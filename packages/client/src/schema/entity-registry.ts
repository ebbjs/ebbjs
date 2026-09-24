/**
 * `EntityRegistry` — runtime container for declared entity definitions.
 *
 * The registry is the validation surface for the schema layer: outbound
 * `client.write()` calls and inbound SSE/catchUp actions consult it
 * before crossing any boundary. In #143 it only checks field-name
 * membership; field-shape validation (`e.counter()` data vs
 * `e.string()` data) is deferred behind #148 because the wire envelope
 * doesn't carry `type` tags.
 *
 * The registry deliberately lives apart from `TextDocumentRegistry`:
 * one holds passive definitions, the other holds live stateful
 * documents. They share a Map-shaped surface but solve different
 * problems.
 */

import type { Action } from "@ebbjs/core";

import type { EntityDef, FieldMarker } from "./entity";

/**
 * One validation failure against a registered entity.
 *
 * `updateIndex` is the position of the offending Update in the action's
 * `updates[]` (omitted for filter violations, which aren't tied to an
 * update). `field` is omitted for violations about the subject_type
 * itself.
 */
export interface ValidationViolation {
  entityName: string;
  updateIndex?: number;
  field?: string;
  message: string;
}

/**
 * Aggregated validation error. Thrown by `client.write()` and
 * `client.queryEntities()` when one or more violations are detected.
 * The `violations` field is the full list — callers can render them
 * grouped by entity, by update, or however they prefer.
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
 * Placeholder entity name when the offending update references a
 * subject_type that wasn't registered. Grouping violations by
 * entityName lets callers filter unknown-type reports separately.
 */
const UNKNOWN_ENTITY = "(unknown)";

type AnyEntityDef = EntityDef<Record<string, FieldMarker>>;

export class EntityRegistry {
  private readonly entities = new Map<string, AnyEntityDef>();

  /** Register an entity. Re-registering the same name overwrites. */
  register<TFields extends Record<string, FieldMarker>>(entity: EntityDef<TFields>): void {
    this.entities.set(entity.name, entity as unknown as AnyEntityDef);
  }

  get(name: string): AnyEntityDef | undefined {
    return this.entities.get(name);
  }

  has(name: string): boolean {
    return this.entities.has(name);
  }

  /**
   * Validate one action against the registry. Returns an array of
   * violations (empty when the action is valid). Never throws —
   * callers decide whether to throw, warn, or aggregate.
   *
   * An empty registry (no entities registered) imposes no
   * constraints and returns `[]` — this matches the "no-op" behavior
   * in `client.write()` and `_applyAction` when no registry was
   * supplied to the SyncClient.
   *
   * Checks per `Update`:
   * - `subject_type` is registered
   * - each key in `data.fields` is declared on the entity
   *
   * Updates with `data === null` (delete method) skip the fields check
   * — they carry no fields to validate. Field-shape compatibility is
   * not checked; see file header.
   */
  validateAction(action: Action): ValidationViolation[] {
    if (this.entities.size === 0) return [];
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
   * Returns an array of violations (empty when valid). Never throws.
   *
   * An empty registry (no entities registered) imposes no
   * constraints and returns `[]` — matches `validateAction`.
   *
   * An empty filter `{}` is always valid (no fields to check).
   * Unknown entity type yields one violation with no `field`.
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
