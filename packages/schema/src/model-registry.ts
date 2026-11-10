/**
 * `ModelRegistry` — runtime container for declared model and
 * relationship definitions.
 *
 * Validates field-name membership only. Field-shape validation is not
 * done here because the wire envelope doesn't carry `type` tags.
 */

import { isUnset, type Action } from "@ebbjs/core";
import { Type } from "@sinclair/typebox";
import { Value, type ValueError } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";

import {
  hasDefault,
  isMapSchema,
  type ComponentDef,
  type ConflictScope,
  type FieldMarker,
  type Loading,
  type ModelDef,
} from "./model";
import type { RelationshipDef, SourceCardinality } from "./relationship";

/** One validation failure against a registered entity. */
export interface ValidationViolation {
  /** Entity name; `"(unknown)"` if the offending update's subject_type wasn't registered. */
  entityName: string;
  /** Position of the offending Update in the action's `updates[]`. Omitted for filter violations. */
  updateIndex?: number;
  /** Field name; omitted for violations about the subject_type itself. */
  field?: string;
  message: string;
}

/**
 * Aggregated validation error. Thrown by `client.write()`,
 * `client.queryEntities()`, and `client.buildRelationshipWrite()` when
 * one or more violations are detected.
 */
export class EntityValidationError extends Error {
  readonly violations: readonly ValidationViolation[];

  constructor(violations: readonly ValidationViolation[]) {
    super(formatViolations(violations));
    this.name = "EntityValidationError";
    this.violations = violations;
  }
}

const formatViolations = (vs: readonly ValidationViolation[]): string => {
  if (vs.length === 0) return "EntityValidationError";
  const lines = vs.map((v) => `  - ${v.message}`);
  return `EntityValidationError: ${vs.length} violation(s)\n${lines.join("\n")}`;
};

/**
 * One conjunction of field predicates: keys within a group are ANDed.
 *
 * A `null` value is the predicate "no live value" — the field is absent or
 * tombstoned — and never a schema default.
 */
export type FilterGroup = Record<string, string | number | boolean | null>;

/**
 * A query filter is a disjunction of groups: groups are ORed, keys within a
 * group ANDed. `null`, `[]`, and a list holding an empty group are unfiltered
 * (an empty conjunction is TRUE).
 */
export type Filter = readonly FilterGroup[];

/** Placeholder `entityName` when the offending subject_type wasn't registered. */
const UNKNOWN_ENTITY = "(unknown)";

type AnyModelDef = ModelDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;

/**
 * Wire-level fields the registry needs at lookup time. The full
 * `RelationshipDef<S, T>` shape is reconstructed from these on read.
 */
interface RegisteredRelationship {
  sourceName: string;
  targetName: string;
  as: string;
  sourceCardinality: SourceCardinality;
  type: string;
}

const relationshipKey = (sourceName: string, as: string): string => `${sourceName}::${as}`;

/**
 * Build the wire-level `RelationshipDef` view from a registered
 * entry. The reconstructed source/target carry only their `name`;
 * callers that need field-level metadata should keep the original
 * `defineRelationship` reference.
 */
const toRelationshipDef = (r: RegisteredRelationship): AnyRelationshipDef => ({
  source: { name: r.sourceName } as AnyModelDef,
  target: { name: r.targetName } as AnyModelDef,
  as: r.as,
  sourceCardinality: r.sourceCardinality,
  type: r.type,
});

const modelNameOf = (model: string | ModelDef<Record<string, TSchema>>): string =>
  typeof model === "string" ? model : model.name;

export class ModelRegistry {
  private readonly models = new Map<string, AnyModelDef>();
  private readonly relationships = new Map<string, RegisteredRelationship>();

  /** Register a model. Re-registering the same name overwrites. */
  register<TFields extends Record<string, TSchema>>(model: ModelDef<TFields>): void {
    this.models.set(model.name, model as AnyModelDef);
  }

  /** Look up a model by name. */
  get(name: string): AnyModelDef | undefined {
    return this.models.get(name);
  }

  /** Every registered model name, in registration order. */
  modelNames(): readonly string[] {
    return [...this.models.keys()];
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  /** True when no models and no relationships have been registered. */
  isEmpty(): boolean {
    return this.models.size === 0 && this.relationships.size === 0;
  }

  /** Components declared by `model`, keyed by field. Unknown models declare none. */
  componentsOf(model: string | ModelDef<Record<string, TSchema>>): readonly ComponentDef[] {
    const def = this.models.get(modelNameOf(model));
    return def === undefined ? [] : Object.values(def.components);
  }

  /** One declared component, looked up by field key or full `<model>/<leaf>` name. */
  componentOf(
    model: string | ModelDef<Record<string, TSchema>>,
    name: string,
  ): ComponentDef | undefined {
    const def = this.models.get(modelNameOf(model));
    if (def === undefined) return undefined;
    const byField = def.components[name];
    if (byField !== undefined) return byField;
    return Object.values(def.components).find((component) => component.name === name);
  }

  /** Whether a declared component may be absent. Unknown components are not optional. */
  isOptional(model: string | ModelDef<Record<string, TSchema>>, name: string): boolean {
    return this.componentOf(model, name)?.optional ?? false;
  }

  /** Loading declared by a component. Unknown components default to eager. */
  loadingOf(model: string | ModelDef<Record<string, TSchema>>, name: string): Loading {
    return this.componentOf(model, name)?.loading ?? "eager";
  }

  /** Conflict scope declared by a component, falling back to the model's default. */
  conflictScopeOf(model: string | ModelDef<Record<string, TSchema>>, name: string): ConflictScope {
    return (
      this.componentOf(model, name)?.conflictScope ??
      this.models.get(modelNameOf(model))?.conflictScope ??
      "field"
    );
  }

  /**
   * Permission subject for a component: its own `<model>/<leaf>` when it
   * opts in, otherwise the model's `<model>` subject.
   */
  permissionOf(model: string | ModelDef<Record<string, TSchema>>, name?: string): string {
    const modelName = modelNameOf(model);
    const component = name === undefined ? undefined : this.componentOf(modelName, name);
    return component?.permission === "own" ? component.name : modelName;
  }

  /**
   * Field-kind query for conflict policy: `true` when `field` on
   * `subjectType` merges last-writer-wins, so a concurrent inbound
   * write can silently overwrite a local one. Unknown entities and
   * undeclared fields default to LWW — a client without a schema has
   * no markers, and a forward-compat field is safer flagged than not.
   */
  isLwwField(subjectType: string, field: string): boolean {
    const model = this.models.get(subjectType);
    if (model === undefined) return true;
    const marker = model.components[field]?.marker as FieldMarker | undefined;
    return marker === undefined || marker.type === "lww";
  }

  /**
   * Conflict granularity declared by `subjectType`. Unknown entities
   * default to `"field"`, matching a client without a schema.
   */
  getConflictScope(subjectType: string): ConflictScope {
    return this.models.get(subjectType)?.conflictScope ?? "field";
  }

  /**
   * Register a relationship keyed by `(source, as)`. Re-registering
   * the same pair overwrites; the returned marker lets callers
   * detect the overwrite.
   */
  registerRelationship<
    S extends ModelDef<Record<string, TSchema>>,
    T extends ModelDef<Record<string, TSchema>>,
  >(def: RelationshipDef<S, T>): { overwritten: boolean; previousCardinality?: SourceCardinality } {
    const key = relationshipKey(def.source.name, def.as);
    const prev = this.relationships.get(key);
    const entry: RegisteredRelationship = {
      sourceName: def.source.name,
      targetName: def.target.name,
      as: def.as,
      sourceCardinality: def.sourceCardinality,
      type: def.type,
    };
    this.relationships.set(key, entry);
    if (prev === undefined) {
      return { overwritten: false };
    }
    return { overwritten: true, previousCardinality: prev.sourceCardinality };
  }

  /** Look up a registered relationship by source name + `as` accessor. */
  getRelationship(sourceName: string, as: string): AnyRelationshipDef | undefined {
    const entry = this.relationships.get(relationshipKey(sourceName, as));
    return entry === undefined ? undefined : toRelationshipDef(entry);
  }

  /** All relationships declared with `sourceName` as their source. */
  getRelationshipsForSource(sourceName: string): readonly AnyRelationshipDef[] {
    const out: AnyRelationshipDef[] = [];
    for (const r of this.relationships.values()) {
      if (r.sourceName === sourceName) out.push(toRelationshipDef(r));
    }
    return out;
  }

  /** All relationships declared with `targetName` as their target. */
  getRelationshipsForTarget(targetName: string): readonly AnyRelationshipDef[] {
    const out: AnyRelationshipDef[] = [];
    for (const r of this.relationships.values()) {
      if (r.targetName === targetName) out.push(toRelationshipDef(r));
    }
    return out;
  }

  /**
   * Validate one action against the registry. Never throws; callers
   * decide whether to throw, warn, or aggregate. Returns `[]` when
   * no entities are registered (validation is a no-op).
   *
   * Updates with `data === null` (delete method) skip the fields check.
   */
  validateAction(action: Action): ValidationViolation[] {
    if (this.models.size === 0 && this.relationships.size === 0) return [];
    const violations: ValidationViolation[] = [];
    for (let i = 0; i < action.updates.length; i++) {
      const update = action.updates[i];
      if (update === undefined) continue;
      const entity = this.models.get(update.subject_type);
      if (entity === undefined) {
        violations.push({
          entityName: UNKNOWN_ENTITY,
          updateIndex: i,
          message: `Unknown subject_type: "${update.subject_type}"`,
        });
        continue;
      }
      if (update.data === null) continue;
      const fieldNames = Object.keys(update.data.fields);
      for (const fieldName of fieldNames) {
        if (!(fieldName in entity.components)) {
          violations.push({
            entityName: entity.name,
            updateIndex: i,
            field: fieldName,
            message: `Field "${fieldName}" is not declared on entity "${entity.name}"`,
          });
        }
      }
    }
    return violations;
  }

  /**
   * Validate a filter against the registry for the given entity type.
   * Never throws. Returns `[]` when no entities are registered. `null` is
   * unfiltered. Every group is checked independently, and a `null` entry
   * where a group is expected is reported as malformed.
   */
  validateFilter(type: string, filter: Filter | null): ValidationViolation[] {
    if (this.models.size === 0) return [];
    const entity = this.models.get(type);
    if (entity === undefined) {
      return [
        {
          entityName: UNKNOWN_ENTITY,
          message: `Unknown entity type for filter: "${type}"`,
        },
      ];
    }
    const violations: ValidationViolation[] = [];
    if (filter !== null && !Array.isArray(filter)) {
      return [
        {
          entityName: entity.name,
          message: "Filter must be a list of groups",
        },
      ];
    }
    const groups: readonly unknown[] = filter ?? [];
    for (const [index, group] of groups.entries()) {
      if (group === null || typeof group !== "object" || Array.isArray(group)) {
        violations.push({
          entityName: entity.name,
          message: `Filter group ${index} must be an object`,
        });
        continue;
      }
      for (const fieldName of Object.keys(group as FilterGroup)) {
        if (!(fieldName in entity.components)) {
          violations.push({
            entityName: entity.name,
            field: fieldName,
            message: `Filter field "${fieldName}" in group ${index} is not declared on entity "${entity.name}"`,
          });
        }
      }
    }
    return violations;
  }

  /**
   * Warnings for a filter that names a defaulted field's value without a
   * `null` term for it in any group. A filter never applies a default, so
   * `{ priority: "normal" }` silently excludes rows nobody set; the hint
   * points at `{ priority: null }`. Never fatal — the caller decides
   * whether to surface it.
   */
  filterWarnings(type: string, filter: Filter | null): ValidationViolation[] {
    if (this.models.size === 0 || filter === null || !Array.isArray(filter)) return [];
    const entity = this.models.get(type);
    if (entity === undefined) return [];
    const compared = new Set<string>();
    const hasNullTerm = new Set<string>();
    for (const group of filter) {
      if (group === null || typeof group !== "object" || Array.isArray(group)) continue;
      for (const [field, value] of Object.entries(group)) {
        if (value === null) hasNullTerm.add(field);
        else compared.add(field);
      }
    }
    const warnings: ValidationViolation[] = [];
    for (const field of compared) {
      if (hasNullTerm.has(field)) continue;
      const property = entity.shape.properties[field] as TSchema | undefined;
      if (property === undefined || !hasDefault(property)) continue;
      warnings.push({
        entityName: entity.name,
        field,
        message:
          `Filter on "${field}" compares a defaulted field's value but never its absence; ` +
          `add { ${field}: null } to also match rows nobody set`,
      });
    }
    return warnings;
  }
}

/**
 * Validate a write-time payload against the entity's TypeBox shape.
 * `partial=false` requires the full entity shape (create semantics);
 * `partial=true` accepts a subset (update semantics, missing keys
 * are allowed).
 *
 * TypeBox doesn't reject unknown properties by default, so the
 * function explicitly enforces field-name membership alongside
 * `Value.Check`'s type conformance. Every violation surfaces in
 * one `EntityValidationError` so the caller sees the whole problem
 * list at once.
 */
export const validatePayload = <T extends TSchema>(
  shape: T,
  payload: unknown,
  entityName: string,
  partial: boolean,
): ValidationViolation[] => {
  if (payload === null || typeof payload !== "object") {
    return [
      {
        entityName,
        message: `payload must be an object, got ${payload === null ? "null" : typeof payload}`,
      },
    ];
  }
  const obj = payload as Record<string, unknown>;
  const violations: ValidationViolation[] = [];
  const properties = readObjectProperties(shape);
  const declaredKeys = properties === undefined ? null : new Set(Object.keys(properties));

  if (declaredKeys !== null) {
    for (const key of Object.keys(obj)) {
      if (!declaredKeys.has(key)) {
        violations.push({
          entityName,
          field: key,
          message: `Field "${key}" is not declared on entity "${entityName}"`,
        });
      }
    }
  }

  if (partial && properties !== undefined) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || isUnset(value)) continue;
      if (value === null) {
        violations.push(nullIsNotUnset(entityName, key));
        continue;
      }
      const fieldSchema = properties[key];
      const before = violations.length;
      const checked = sanitizeFieldValue(value, fieldSchema, entityName, key, violations);
      // A nested `unset` is reported where it was authored; type-checking the
      // stripped value would only add a shape error the caller cannot act on.
      if (violations.length > before) continue;
      if (fieldSchema !== undefined) {
        collectFieldTypeErrors(violations, fieldSchema, checked, entityName, key);
      }
    }
  } else {
    // `unset` is not a value: drop it from the payload, and treat the key as
    // satisfied so a create can assert absence for a required field. A
    // literal `null` is a payload that never learned the vocabulary; its own
    // violation replaces the required-field error it would otherwise add.
    const skippedKeys: string[] = [];
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isUnset(value)) {
        skippedKeys.push(key);
        continue;
      }
      if (value === null) {
        skippedKeys.push(key);
        violations.push(nullIsNotUnset(entityName, key));
        continue;
      }
      const before = violations.length;
      const sanitized = sanitizeFieldValue(value, properties?.[key], entityName, key, violations);
      // A field with an `unset`/null violation is reported where it was
      // authored; removing it keeps the shape check from adding a second
      // error about the value it no longer carries.
      if (violations.length > before) {
        skippedKeys.push(key);
        continue;
      }
      cleaned[key] = sanitized;
    }
    const shapeForCheck =
      skippedKeys.length > 0 && properties !== undefined
        ? withOptionalKeys(properties, skippedKeys)
        : shape;
    collectShapeErrors(violations, shapeForCheck, cleaned, entityName);
  }
  return violations;
};

/**
 * Drop the `unset` markers a payload is allowed to carry and reject the rest.
 *
 * Only a map field's top-level entries are positions: `unset` there compiles
 * to a tombstone leaf. Anywhere else — inside an object, an array item, or a
 * map entry's own value — `unset` has no envelope, so it is reported once at
 * its path rather than stripped into a shape error.
 *
 * A literal `null` is that same mistake inside an atomic value, but not inside
 * a map entry: a map's entries are positions, and a schema that admits a null
 * there declares it as the position's own value. That is the definition-time
 * carve-out; validation has to honour it or the two disagree again.
 */
const sanitizeFieldValue = (
  value: unknown,
  fieldSchema: TSchema | undefined,
  entityName: string,
  field: string,
  violations: ValidationViolation[],
): unknown => {
  if (fieldSchema !== undefined && isMapSchema(fieldSchema) && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isUnset(entry)) continue;
      const path = `${field}.${key}`;
      if (entry === null) {
        violations.push(nullIsNotUnset(entityName, path));
        continue;
      }
      out[key] = sanitizeNestedValue(entry, entityName, path, violations, true);
    }
    return out;
  }
  return sanitizeNestedValue(value, entityName, field, violations, false);
};

const sanitizeNestedValue = (
  value: unknown,
  entityName: string,
  path: string,
  violations: ValidationViolation[],
  nullIsPositionValue: boolean,
): unknown => {
  if (isUnset(value)) {
    violations.push(nestedUnset(entityName, path));
    return undefined;
  }
  if (value === null) {
    if (!nullIsPositionValue) violations.push(nullIsNotUnset(entityName, path));
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeNestedValue(entry, entityName, `${path}[${index}]`, violations, nullIsPositionValue),
    );
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeNestedValue(
        entry,
        entityName,
        `${path}.${key}`,
        violations,
        nullIsPositionValue,
      );
    }
    return out;
  }
  return value;
};

/**
 * True for a non-array object. Validation and the wire envelope both read a
 * plain object as either one leaf value or a map payload.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The path of the first `unset` at or below `value`, or `undefined`. A path
 * is the field's dotted position: `anchor.y`, `tags[0]`.
 */
export const findNestedUnsetPath = (value: unknown, path: string): string | undefined => {
  if (isUnset(value)) return path;
  if (!isPlainObject(value) && !Array.isArray(value)) return undefined;
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [`${path}[${index}]`, entry] as const)
    : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry] as const);
  for (const [entryPath, entry] of entries) {
    const found = findNestedUnsetPath(entry, entryPath);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * The one message for an `unset` that landed below the position that can
 * carry it. Naming the escape keeps the refusal actionable: a map merges per
 * key, so it is how one position is cleared.
 */
export const nestedUnsetMessage = (path: string): string =>
  `unset at "${path}" has no envelope: \`unset\` clears a whole field; declare the field as e.map to clear one key.`;

/** One violation for an `unset` that landed deeper than a map field's entries. */
const nestedUnset = (entityName: string, path: string): ValidationViolation => ({
  entityName,
  field: path,
  message: nestedUnsetMessage(path),
});

/** One violation for a payload that used `null` where only `unset` asserts absence. */
const nullIsNotUnset = (entityName: string, field: string): ValidationViolation => ({
  entityName,
  field,
  message: `${field}: null is not a value; use \`unset\` to clear a field`,
});

/** A copy of a field map with the named properties optional, so an `unset` key is satisfied. */
const withOptionalKeys = (
  properties: Record<string, TSchema>,
  keys: readonly string[],
): TSchema => {
  const next: Record<string, TSchema> = { ...properties };
  for (const key of keys) {
    const fieldSchema = properties[key];
    if (fieldSchema !== undefined) {
      next[key] = Type.Optional(fieldSchema as Parameters<typeof Type.Optional>[0]);
    }
  }
  return Type.Object(next);
};

/** Extract a `TObject` shape's `properties` map. Returns `undefined` for non-object shapes. */
const readObjectProperties = (shape: TSchema): Record<string, TSchema> | undefined => {
  const candidate = shape as { properties?: unknown };
  if (candidate.properties === null || typeof candidate.properties !== "object") return undefined;
  return candidate.properties as Record<string, TSchema>;
};

/** Append one violation per `Value.Errors` entry; the entity name is stamped from the caller. */
const collectShapeErrors = (
  out: ValidationViolation[],
  shape: TSchema,
  payload: unknown,
  entityName: string,
): void => {
  if (Value.Check(shape, payload)) return;
  for (const error of Value.Errors(shape, payload)) {
    out.push(toViolation(error, entityName));
  }
};

/** Same as `collectShapeErrors` but on a single field — the field name is the message prefix. */
const collectFieldTypeErrors = (
  out: ValidationViolation[],
  fieldSchema: TSchema,
  value: unknown,
  entityName: string,
  fieldName: string,
): void => {
  if (Value.Check(fieldSchema, value)) return;
  const leafErrors = [...Value.Errors(fieldSchema, value)];
  if (leafErrors.length === 0) {
    out.push({
      entityName,
      field: fieldName,
      message: `${fieldName}: expected ${describeSchema(fieldSchema)}`,
    });
    return;
  }
  for (const error of leafErrors) {
    out.push({
      entityName,
      field: fieldName,
      message: `${formatFieldPath(fieldName, error.path)}: ${error.message}`,
    });
  }
};

/** Fallback for `Value.Errors` returning zero entries — read the schema's `type` discriminator. */
const describeSchema = (schema: TSchema): string => {
  const s = schema as { type?: unknown };
  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.type)) return s.type.join("|");
  return "value";
};

/** Map one TypeBox `ValueError` to a `ValidationViolation`; the path is dotted. */
const toViolation = (error: ValueError, entityName: string): ValidationViolation => {
  const field = formatPath(error.path);
  const message = field === "" ? error.message : `${field}: ${error.message}`;
  return {
    entityName,
    field: field === "" ? undefined : field,
    message,
  };
};

/** A TypeBox error path (`/a/0/b`) as a dotted path (`a[0].b`); empty stays empty. */
const formatPath = (path: string): string => {
  const segments = path.split("/").slice(1);
  return segments.reduce(
    (acc, segment) =>
      /^\d+$/.test(segment) ? `${acc}[${segment}]` : acc === "" ? segment : `${acc}.${segment}`,
    "",
  );
};

/** A field name plus the error's path below it: `anchor` + `/y` -> `anchor.y`. */
const formatFieldPath = (field: string, path: string): string => {
  const below = formatPath(path);
  if (below === "") return field;
  return below.startsWith("[") ? `${field}${below}` : `${field}.${below}`;
};
