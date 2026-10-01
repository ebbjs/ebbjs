/**
 * `EntityRegistry` — runtime container for declared entity and
 * relationship definitions.
 *
 * Validates field-name membership only. Field-shape validation is not
 * done here because the wire envelope doesn't carry `type` tags.
 */

import type { Action } from "@ebbjs/core";
import { Value, type ValueError } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";

import type { EntityDef, FieldMarker } from "./entity";
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

/** Placeholder `entityName` when the offending subject_type wasn't registered. */
const UNKNOWN_ENTITY = "(unknown)";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

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
  source: { name: r.sourceName, fields: {} as Record<string, FieldMarker> } as AnyEntityDef,
  target: { name: r.targetName, fields: {} as Record<string, FieldMarker> } as AnyEntityDef,
  as: r.as,
  sourceCardinality: r.sourceCardinality,
  type: r.type,
});

export class EntityRegistry {
  private readonly entities = new Map<string, AnyEntityDef>();
  private readonly relationships = new Map<string, RegisteredRelationship>();

  /** Register an entity. Re-registering the same name overwrites. */
  register<TFields extends Record<string, TSchema>>(entity: EntityDef<TFields>): void {
    this.entities.set(entity.name, entity as unknown as AnyEntityDef);
  }

  /** Look up an entity by name. */
  get(name: string): AnyEntityDef | undefined {
    return this.entities.get(name);
  }

  has(name: string): boolean {
    return this.entities.has(name);
  }

  /** True when no entities and no relationships have been registered. */
  isEmpty(): boolean {
    return this.entities.size === 0 && this.relationships.size === 0;
  }

  /**
   * Register a relationship keyed by `(source, as)`. Re-registering
   * the same pair overwrites; the returned marker lets callers
   * detect the overwrite.
   */
  registerRelationship<
    S extends EntityDef<Record<string, TSchema>>,
    T extends EntityDef<Record<string, TSchema>>,
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
    if (this.entities.size === 0 && this.relationships.size === 0) return [];
    const violations: ValidationViolation[] = [];
    for (let i = 0; i < action.updates.length; i++) {
      const update = action.updates[i];
      if (update === undefined) continue;
      const entity = this.entities.get(update.subject_type);
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
        if (!(fieldName in entity.fields)) {
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
   * Never throws. Returns `[]` when no entities are registered.
   */
  validateFilter(type: string, filter: Record<string, unknown>): ValidationViolation[] {
    if (this.entities.size === 0) return [];
    const entity = this.entities.get(type);
    if (entity === undefined) {
      return [
        {
          entityName: UNKNOWN_ENTITY,
          message: `Unknown entity type for filter: "${type}"`,
        },
      ];
    }
    const violations: ValidationViolation[] = [];
    for (const fieldName of Object.keys(filter)) {
      if (!(fieldName in entity.fields)) {
        violations.push({
          entityName: entity.name,
          field: fieldName,
          message: `Filter field "${fieldName}" is not declared on entity "${entity.name}"`,
        });
      }
    }
    return violations;
  }
}

/**
 * Validate a write-time payload against the entity's TypeBox shape
 * via `Value.Check`. Used by `client.<entity>.create()` and
 * `client.<entity>.update()` to reject malformed input before any
 * network call — the schema stops being decoration and becomes a
 * contract.
 *
 * `partial` selects create vs. update semantics:
 *
 * - `false` (create): the payload is the full entity shape.
 *   Unknown keys are rejected, present keys are type-checked, and
 *   the full `Value.Check` enforces required-field membership.
 * - `true` (update): the payload is a partial patch. Unknown keys
 *   are rejected, present keys are type-checked against their
 *   individual field schema, and missing required fields are
 *   allowed (that's the whole point of a patch).
 *
 * Both paths combine field-name membership with type conformance
 * so the user gets a single `EntityValidationError` enumerating
 * every problem. Each violation carries the entity name and the
 * offending field so the SDK's existing
 * `formatViolations` produces a self-locating message.
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

  // Field-name membership: every key in the payload must be a
  // declared field. TypeBox doesn't reject unknown properties by
  // default, so this check lives here rather than relying on
  // `Value.Check` alone.
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

  if (partial) {
    // Type-check each present value against its individual field
    // schema. Missing keys are allowed (that's the point of a
    // patch). Unknown keys were reported above.
    if (properties !== undefined) {
      for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        const fieldSchema = properties[key];
        if (fieldSchema === undefined) continue;
        collectFieldTypeErrors(violations, fieldSchema, value, entityName, key);
      }
    } else {
      // No property map reachable — fall back to the whole-shape
      // check so we still catch shape-level mismatches.
      collectShapeErrors(violations, shape, payload, entityName);
    }
  } else {
    // Full-shape check: catches wrong types AND missing required
    // fields. TypeBox's required-property errors land here.
    collectShapeErrors(violations, shape, payload, entityName);
  }
  return violations;
};

/**
 * Read the `properties` map out of a `TObject` shape. The shape is
 * opaque from the SDK's perspective (a `TSchema` is too wide to
 * narrow structurally without a cast), so we duck-type-check for the
 * `properties` field and bail out when it's absent (e.g., for
 * `Type.Union`, `Type.Array`, primitive schemas passed by mistake).
 */
const readObjectProperties = (shape: TSchema): Record<string, TSchema> | undefined => {
  const candidate = shape as { properties?: unknown };
  if (candidate.properties === null || typeof candidate.properties !== "object") return undefined;
  return candidate.properties as Record<string, TSchema>;
};

/**
 * Run `Value.Errors` against the shape and append every mapped
 * violation to `out`. Each TypeBox error carries a `path` (the
 * dotted field path with a leading `/`); the leading slash is
 * stripped before the value lands in `ValidationViolation.field`.
 */
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

/**
 * Run `Value.Errors` against one field's schema and append mapped
 * violations with the field name baked into the message — the
 * TypeBox path is empty here because the schema is the leaf.
 */
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
      message: `${fieldName}: ${error.message}`,
    });
  }
};

/**
 * Best-effort human-readable name for a TypeBox schema. Used as a
 * fallback message when `Value.Errors` yields zero entries (rare,
 * but happens for some schema kinds). Falls back to "value" when
 * the schema doesn't carry a recognizable `type` discriminator.
 */
const describeSchema = (schema: TSchema): string => {
  const s = schema as { type?: unknown };
  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.type)) return s.type.join("|");
  return "value";
};

/**
 * Convert one TypeBox `ValueError` into the SDK's
 * `ValidationViolation` shape. Field path is the bare dotted path
 * with leading `/` stripped; the entity name is stamped from the
 * caller so the violation stays tied to its declaring schema even
 * when shapes are nested.
 */
const toViolation = (error: ValueError, entityName: string): ValidationViolation => {
  const field = stripLeadingSlash(error.path);
  const message = field === "" ? error.message : `${field}: ${error.message}`;
  return {
    entityName,
    field: field === "" ? undefined : field,
    message,
  };
};

/** Strip the leading `/` TypeBox prepends to error paths. Empty path → empty string. */
const stripLeadingSlash = (path: string): string => (path.startsWith("/") ? path.slice(1) : path);
