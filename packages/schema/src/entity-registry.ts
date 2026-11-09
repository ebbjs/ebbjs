/**
 * `EntityRegistry` — runtime container for declared entity and
 * relationship definitions.
 *
 * Validates field-name membership only. Field-shape validation is not
 * done here because the wire envelope doesn't carry `type` tags.
 */

import { isUnset, type Action } from "@ebbjs/core";
import { Type } from "@sinclair/typebox";
import { Value, type ValueError } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";

import { hasDefault, type ConflictScope, type EntityDef, type FieldMarker } from "./entity";
import type { RelationshipDef, RelationshipKind, SourceCardinality } from "./relationship";

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
  kind: RelationshipKind | undefined;
  contained: boolean;
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
  kind: r.kind,
  contained: r.contained,
});

export class EntityRegistry {
  private readonly entities = new Map<string, AnyEntityDef>();
  private readonly relationships = new Map<string, RegisteredRelationship>();

  /** Register an entity. Re-registering the same name overwrites. */
  register<TFields extends Record<string, TSchema>>(entity: EntityDef<TFields>): void {
    this.entities.set(entity.name, entity as AnyEntityDef);
  }

  /** Look up an entity by name. */
  get(name: string): AnyEntityDef | undefined {
    return this.entities.get(name);
  }

  /** Every registered entity name, in registration order. */
  entityNames(): readonly string[] {
    return [...this.entities.keys()];
  }

  has(name: string): boolean {
    return this.entities.has(name);
  }

  /** True when no entities and no relationships have been registered. */
  isEmpty(): boolean {
    return this.entities.size === 0 && this.relationships.size === 0;
  }

  /**
   * Field-kind query for conflict policy: `true` when `field` on
   * `subjectType` merges last-writer-wins, so a concurrent inbound
   * write can silently overwrite a local one. Unknown entities and
   * undeclared fields default to LWW — a client without a schema has
   * no markers, and a forward-compat field is safer flagged than not.
   */
  isLwwField(subjectType: string, field: string): boolean {
    const entity = this.entities.get(subjectType);
    if (entity === undefined) return true;
    const marker = entity.fields[field] as FieldMarker | undefined;
    return marker === undefined || marker.type === "lww";
  }

  /**
   * Conflict granularity declared by `subjectType`. Unknown entities
   * default to `"field"`, matching a client without a schema.
   */
  getConflictScope(subjectType: string): ConflictScope {
    return this.entities.get(subjectType)?.conflictScope ?? "field";
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
      kind: def.kind,
      contained: def.contained,
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

  /**
   * Relationships whose target is contained in the source's access scope.
   * The membership-change planner walks exactly these.
   */
  getContainedRelationshipsForSource(sourceName: string): readonly AnyRelationshipDef[] {
    return this.getRelationshipsForSource(sourceName).filter((rel) => rel.contained);
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
   * Never throws. Returns `[]` when no entities are registered. `null` is
   * unfiltered. Every group is checked independently, and a `null` entry
   * where a group is expected is reported as malformed.
   */
  validateFilter(type: string, filter: Filter | null): ValidationViolation[] {
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
        if (!(fieldName in entity.fields)) {
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
    if (this.entities.size === 0 || filter === null || !Array.isArray(filter)) return [];
    const entity = this.entities.get(type);
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
      if (fieldSchema === undefined) continue;
      const checked = stripUnsetEntries(value, entityName, key, violations);
      collectFieldTypeErrors(violations, fieldSchema, checked, entityName, key);
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
      cleaned[key] = stripUnsetEntries(value, entityName, key, violations);
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
 * A map field's payload carries one marker per key. `unset` entries are not
 * values, so drop them before `Value.Check`; a literal null entry is the same
 * mistake as a null leaf and is rejected here.
 */
const stripUnsetEntries = (
  value: unknown,
  entityName: string,
  field: string,
  violations: ValidationViolation[],
): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isUnset(entry)) continue;
    if (entry === null) {
      violations.push(nullIsNotUnset(entityName, `${field}.${key}`));
      continue;
    }
    out[key] = entry;
  }
  return out;
};

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
      message: `${fieldName}: ${error.message}`,
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

/** Map one TypeBox `ValueError` to a `ValidationViolation`; the leading `/` on the path is stripped. */
const toViolation = (error: ValueError, entityName: string): ValidationViolation => {
  const field = stripLeadingSlash(error.path);
  const message = field === "" ? error.message : `${field}: ${error.message}`;
  return {
    entityName,
    field: field === "" ? undefined : field,
    message,
  };
};

/** TypeBox prepends `/` to error paths; empty path stays empty. */
const stripLeadingSlash = (path: string): string => (path.startsWith("/") ? path.slice(1) : path);
