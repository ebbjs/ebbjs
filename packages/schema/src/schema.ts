/**
 * `defineSchema` — composes per-model and per-relationship definitions
 * into a single `Schema` value the rest of the SDK consumes.
 *
 * The builder is pure: no I/O, no side effects beyond constructing
 * the runtime `ModelRegistry` and freezing the result. It's safe to
 * call at module top level and share the value across clients.
 */

import type { ModelDef } from "./model";
import { ModelRegistry } from "./model-registry";
import type { RelationshipDef } from "./relationship";
import type { TSchema } from "@sinclair/typebox/type";
import { assertAccessorNameAvailable, assertEntityNameAvailable } from "./reserved";
import {
  entityGroupSystemEntity,
  groupMemberSystemEntity,
  groupSystemEntity,
  relationshipSystemEntity,
} from "./system-entities";

type AnyModelDef = ModelDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;

/**
 * Raised when the key a model is registered under differs from the
 * definition's own `name`. Namespaces are keyed by the map key but
 * built from `def.name`, so a mismatched key would address another
 * model — and therefore another permission string — under the name
 * the app reads.
 */
export class ModelKeyMismatchError extends Error {
  /** The key the model map registered. */
  readonly key: string;
  /** The name the definition carries. */
  readonly modelName: string;

  constructor(key: string, modelName: string) {
    super(
      `Model map key "${key}" does not match the definition's name "${modelName}". ` +
        `A preset keyed under another name could address another model and ` +
        `permission string. Key it under its own name: models: { ${modelName} }.`,
    );
    this.name = "ModelKeyMismatchError";
    this.key = key;
    this.modelName = modelName;
  }
}

/**
 * Raised when a model's component map names a component that is not
 * `<model>/<leaf>` for that model. Such a declaration would attach a
 * foreign component to the model, borrowing another model's policy.
 */
export class ComponentOutsideModelError extends Error {
  readonly modelName: string;
  readonly componentName: string;

  constructor(modelName: string, componentName: string) {
    super(
      `Model "${modelName}" declares component "${componentName}", which does not belong to ` +
        `it. A component attached to model "${modelName}" must be named ` +
        `"${modelName}/<leaf>" with the leaf matching its field key.`,
    );
    this.name = "ComponentOutsideModelError";
    this.modelName = modelName;
    this.componentName = componentName;
  }
}

const assertComponentsBelongToModel = (model: AnyModelDef): void => {
  for (const [field, component] of Object.entries(model.components)) {
    const segments = component.name.split("/");
    const [owner, leaf] = segments;
    if (segments.length !== 2 || owner !== model.name || leaf !== field) {
      throw new ComponentOutsideModelError(model.name, component.name);
    }
  }
};

/**
 * Raised when `defineSchema` sees a relationship whose source or
 * target model was never registered. Without this check the row type
 * promises an accessor the runtime cannot build, so the omission
 * surfaces later as an `undefined` at the call site rather than as a
 * schema-authoring error here.
 */
export class UnregisteredRelationshipEndpointError extends Error {
  /** Name of the missing model — the one to add to `models`. */
  readonly entityName: string;
  /** Which end of the relationship `entityName` occupies. */
  readonly role: "source" | "target";
  /** `as` accessor on the source that would have resolved the endpoint. */
  readonly accessor: string;

  constructor(info: {
    entityName: string;
    role: "source" | "target";
    sourceName: string;
    accessor: string;
  }) {
    const reference =
      info.role === "source"
        ? `relationship "${info.accessor}" references its source entity "${info.entityName}"`
        : `relationship "${info.accessor}" on entity "${info.sourceName}" references ` +
          `target entity "${info.entityName}"`;
    super(
      `Schema ${reference}, which is not registered. Add "${info.entityName}" to the ` +
        `"models" map passed to defineSchema.`,
    );
    this.name = "UnregisteredRelationshipEndpointError";
    this.entityName = info.entityName;
    this.role = info.role;
    this.accessor = info.accessor;
  }
}

/**
 * Assert that both endpoints of `rel` are registered. Called after
 * every model (system and user) is registered, so `registry` mirrors
 * the full set `defineSchema` will expose. A dangling endpoint is a
 * schema-authoring bug: `buildRowAccessors` would otherwise type-check
 * the accessor but drop it at runtime.
 */
function assertRelationshipEndpointsRegistered(
  rel: AnyRelationshipDef,
  registry: ModelRegistry,
): void {
  const endpoints = [
    ["source", rel.source.name],
    ["target", rel.target.name],
  ] as const;
  for (const [role, entityName] of endpoints) {
    if (registry.has(entityName)) continue;
    throw new UnregisteredRelationshipEndpointError({
      entityName,
      role,
      sourceName: rel.source.name,
      accessor: rel.as,
    });
  }
}

/**
 * The compiled schema handed to `createClient({ schema })`. The
 * `TModels` / `TRelationships` generics are inferred from the inputs so
 * callers see typed model and relationship shapes without an explicit
 * annotation.
 *
 * `TRelationships` defaults to `undefined` so callers that omit the
 * `relationships` slot get a clean `s.relationships === undefined`
 * at the type level. Passing `relationships` narrows it to the
 * specific Record type.
 */
export interface Schema<TModels extends Record<string, AnyModelDef>, TRelationships = undefined> {
  readonly models: TModels;
  /**
   * Relationship map. `undefined` when no `relationships` input was
   * passed to `defineSchema`; a populated Record otherwise. Empty
   * `{}` and `undefined` are distinguishable at runtime so callers
   * can tell "no relationships declared" from "explicitly empty".
   */
  readonly relationships: TRelationships;
  /** Schema version advertised to the server on handshake. */
  readonly version: number;
  /**
   * Lower bound of acceptable server-compatibility versions. When
   * set, the server can reject connections whose stored schema is
   * older than this floor. When omitted, the client only advertises
   * `version`.
   */
  readonly minSupportedVersion?: number;
  /** Runtime registry seeded by `defineSchema`. */
  readonly _registry: ModelRegistry;
}

/**
 * Inputs accepted by `defineSchema`. Mirrors {@link Schema} but with
 * `relationships` and `minSupportedVersion` optional.
 */
export interface DefineSchemaInput<
  TModels extends Record<string, AnyModelDef>,
  TRelationships extends Record<string, AnyRelationshipDef> = Record<string, never>,
> {
  readonly models: TModels;
  readonly relationships?: TRelationships;
  readonly version: number;
  readonly minSupportedVersion?: number;
}

/**
 * Compose per-model and per-relationship definitions into a single
 * `Schema` value. The result is frozen so accidental mutation is a
 * hard error rather than a silent failure.
 *
 * Models are registered with `ModelRegistry.register` and relationships
 * with `ModelRegistry.registerRelationship`. The system models
 * (`relationship`, `group`, `groupMember`, `entityGroup`) are registered
 * alongside user models so the public relationship-write path (`link` /
 * `unlink` / `setLinks`) can submit Relationship Updates and the
 * membership write path can submit `entityGroup` Updates. Membership is
 * a dedicated `entityGroup` row, not an injected relationship. The
 * registry owns the cardinality / overwrite rules; this builder delegates
 * without adding its own. A relationship whose source or target is
 * neither a system model nor a member of `models` throws
 * `UnregisteredRelationshipEndpointError` before the schema is frozen.
 * A model registered under a map key other than its own name throws
 * `ModelKeyMismatchError`: the map key is what a namespace is exposed
 * as, so the two must agree.
 */
export function defineSchema<
  TModels extends Record<string, AnyModelDef>,
  TRelationships extends Record<string, AnyRelationshipDef> = Record<string, never>,
>(input: DefineSchemaInput<TModels, TRelationships>): Schema<TModels, TRelationships> {
  const registry = new ModelRegistry();
  seedRegistry(registry, input.models, input.relationships);
  return Object.freeze({
    models: input.models,
    relationships: input.relationships,
    version: input.version,
    minSupportedVersion: input.minSupportedVersion,
    _registry: registry,
  }) as unknown as Schema<TModels, TRelationships>;
}

/**
 * Register the system models and the user models/relationships onto
 * `registry`. Shared by `defineSchema` and the per-client registry builder
 * so the two can't drift. Rejects app-authored names that collide with the
 * reserved system / membership names, model map keys that differ from the
 * definition's name, components that name another model, and relationships
 * whose source or target model is not registered.
 */
export function seedRegistry(
  registry: ModelRegistry,
  models: Record<string, AnyModelDef>,
  relationships: Record<string, AnyRelationshipDef> | undefined,
): void {
  registry.register(relationshipSystemEntity);
  registry.register(groupSystemEntity);
  registry.register(groupMemberSystemEntity);
  registry.register(entityGroupSystemEntity);
  for (const [key, model] of Object.entries(models)) {
    if (key !== model.name) throw new ModelKeyMismatchError(key, model.name);
    assertComponentsBelongToModel(model);
    assertEntityNameAvailable(model.name);
    registry.register(model);
  }
  if (relationships !== undefined) {
    for (const rel of Object.values(relationships)) {
      assertRelationshipEndpointsRegistered(rel, registry);
      assertAccessorNameAvailable(rel.source.name, rel.as);
      registry.registerRelationship(rel);
    }
  }
}
