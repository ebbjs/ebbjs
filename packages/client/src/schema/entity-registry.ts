/**
 * `EntityRegistry` — runtime container for declared entity and
 * relationship definitions.
 *
 * Validates field-name membership only. Field-shape validation is not
 * done here because the wire envelope doesn't carry `type` tags.
 */

import type { Action } from "@ebbjs/core";

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

type AnyEntityDef = EntityDef<Record<string, FieldMarker>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

/**
 * One registered relationship lookup, narrowed to the wire-level
 * fields the registry actually needs to enforce rules. The full
 * `RelationshipDef<S, T>` is preserved in the map so consumers can
 * recover `source` and `target` for traversal, but accessors only
 * need the wire-level view.
 */
interface RegisteredRelationship {
  def: AnyRelationshipDef;
  sourceName: string;
  targetName: string;
  as: string;
  sourceCardinality: SourceCardinality;
}

const relationshipKey = (sourceName: string, as: string): string => `${sourceName}::${as}`;

export class EntityRegistry {
  private readonly entities = new Map<string, AnyEntityDef>();
  private readonly relationships = new Map<string, RegisteredRelationship>();

  /** Register an entity. Re-registering the same name overwrites. */
  register<TFields extends Record<string, FieldMarker>>(entity: EntityDef<TFields>): void {
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
   * Register a relationship. Two relationships on the same source may
   * not share an `as` name — that's a registry-level collision (the
   * `as` is the field name on the source, and the source's field set
   * is a flat string-keyed map). Re-registering the same `(source,
   * as)` overwrites; the cardinality assertion only fires on initial
   * registration, when the entry didn't exist before.
   *
   * Returns a `{ overwritten: true }` marker when the previous entry
   * for the same `(source, as)` was replaced; `{ overwritten: false,
   * previousCardinality? }` otherwise. Callers use this to surface a
   * warning (§Design decisions resolved item 7) when a relationship
   * with the same `as` is declared twice with conflicting cardinality
   * — the runtime check is type-level only in v1, so the warning is a
   * signal not a hard error.
   */
  registerRelationship<
    S extends EntityDef<Record<string, FieldMarker>>,
    T extends EntityDef<Record<string, FieldMarker>>,
  >(def: RelationshipDef<S, T>): { overwritten: boolean; previousCardinality?: SourceCardinality } {
    const key = relationshipKey(def.source.name, def.as);
    const prev = this.relationships.get(key);
    const registered: RegisteredRelationship = {
      def: def as unknown as AnyRelationshipDef,
      sourceName: def.source.name,
      targetName: def.target.name,
      as: def.as,
      sourceCardinality: def.sourceCardinality,
    };
    this.relationships.set(key, registered);
    if (prev === undefined) {
      return { overwritten: false };
    }
    return { overwritten: true, previousCardinality: prev.sourceCardinality };
  }

  /** Look up a registered relationship by source name + `as` accessor. */
  getRelationship(sourceName: string, as: string): AnyRelationshipDef | undefined {
    return this.relationships.get(relationshipKey(sourceName, as))?.def;
  }

  /** All relationships declared with `sourceName` as their source. */
  getRelationshipsForSource(sourceName: string): readonly AnyRelationshipDef[] {
    const out: AnyRelationshipDef[] = [];
    for (const r of this.relationships.values()) {
      if (r.sourceName === sourceName) out.push(r.def);
    }
    return out;
  }

  /** All relationships declared with `targetName` as their target. */
  getRelationshipsForTarget(targetName: string): readonly AnyRelationshipDef[] {
    const out: AnyRelationshipDef[] = [];
    for (const r of this.relationships.values()) {
      if (r.targetName === targetName) out.push(r.def);
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
