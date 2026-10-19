/**
 * Synchronous executor for a {@link Plan} (#498).
 *
 * Every op folds a row list synchronously: the executor reads the
 * replica's own rows and adjacency indices, so a query never awaits and
 * never re-scans storage per accessor. The plan is the whole story — the
 * executor knows nothing about the schema, the registry, or the builder.
 */

import type { Entity, FieldValue } from "@ebbjs/core";
import type { MembershipQuery, Replica, RelationshipQuery } from "@ebbjs/storage/replica";

import type { Plan, PlanPredicate } from "./query-plan";

/**
 * The read seam a plan executes against: a whole-type scan plus the two
 * adjacency indices. A candidate-only chain supplies rows and nothing
 * else, because it can never plan an indexed predicate.
 */
export interface PlanExecutor {
  scan(type: string): readonly Entity[];
  relationships(query: RelationshipQuery): readonly string[];
  memberships(query: MembershipQuery): readonly string[];
}

/** Read straight off the replica's materialized rows and indices. */
export const createReplicaExecutor = (replica: Replica): PlanExecutor => ({
  scan: (type) => replica.iterate(type),
  relationships: (query) => replica.relationships(query),
  memberships: (query) => replica.memberships(query),
});

const candidateOnlyError = (): never => {
  throw new Error(
    "candidate-only executor: a chain over already-materialized rows cannot plan an indexed predicate",
  );
};

/**
 * Execute against a fixed candidate list — the relationship accessor
 * chain's rows. `scan` ignores its type argument; the adjacency reads
 * have no index to consult and fail loudly rather than silently
 * matching nothing.
 */
export const createRowsExecutor = (rows: readonly Entity[]): PlanExecutor => ({
  scan: () => rows,
  relationships: candidateOnlyError,
  memberships: candidateOnlyError,
});

type Direction = "asc" | "desc";

const fieldValue = (entity: Entity, field: string): FieldValue["value"] | undefined =>
  entity.data?.fields?.[field]?.value;

/**
 * Same comparison semantics as the builder's ordering — `undefined`
 * last, numbers numerically, everything else by locale — so a query
 * reordered here matches one ordered there.
 */
const compareFieldValues = (av: unknown, bv: unknown, direction: Direction): number => {
  if (av === bv) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  if (typeof av === "number" && typeof bv === "number") {
    return direction === "asc" ? av - bv : bv - av;
  }
  const as = String(av);
  const bs = String(bv);
  return direction === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
};

/**
 * Total, deterministic order: the plan's field (or nothing, meaning the
 * entity id), tie-broken by entity id ascending so equal field values
 * cannot reorder between runs.
 */
const compareRows = (a: Entity, b: Entity, field: string | null, direction: Direction): number => {
  if (field === null) {
    return direction === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  }
  const primary = compareFieldValues(fieldValue(a, field), fieldValue(b, field), direction);
  return primary === 0 ? a.id.localeCompare(b.id) : primary;
};

/**
 * Union of the index hits for an any-of set. `null` names no live
 * edge/group, so it matches nothing rather than everything.
 */
const indexHits = (
  anyOf: readonly string[] | null,
  lookup: (id: string) => readonly string[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const id of anyOf ?? []) {
    for (const hit of lookup(id)) ids.add(hit);
  }
  return ids;
};

const applyPredicate = (
  rows: readonly Entity[],
  predicate: PlanPredicate,
  executor: PlanExecutor,
): readonly Entity[] => {
  switch (predicate.kind) {
    case "filter":
      return rows.filter((row) => fieldValue(row, predicate.field) === predicate.value);
    case "adjacency": {
      const { as, type, anyOf } = predicate;
      const ids = indexHits(anyOf, (targetId) => executor.relationships({ as, type, targetId }));
      return rows.filter((row) => ids.has(row.id));
    }
    case "membership": {
      const ids = indexHits(predicate.anyOf, (groupId) => executor.memberships({ groupId }));
      return rows.filter((row) => ids.has(row.id));
    }
  }
};

/**
 * One select op is one DNF group: AND its predicates over the scanned
 * rows, then union the survivors into the rows selected so far, deduped
 * by id and kept in scan order.
 */
const applySelect = (
  scanned: readonly Entity[],
  selected: readonly Entity[],
  predicates: readonly PlanPredicate[],
  executor: PlanExecutor,
): readonly Entity[] => {
  const matched = predicates.reduce<readonly Entity[]>(
    (current, predicate) => applyPredicate(current, predicate, executor),
    scanned,
  );
  const ids = new Set([...selected, ...matched].map((row) => row.id));
  return scanned.filter((row) => ids.has(row.id));
};

/**
 * Run the plan synchronously. A select op always evaluates over the scan
 * (groups are ORed), so the fold keeps the scanned rows beside the
 * current result; order and limit then narrow the result.
 */
export function executePlan(plan: Plan, executor: PlanExecutor): readonly Entity[] {
  let scanned: readonly Entity[] = [];
  let selected: readonly Entity[] = [];
  let rows: readonly Entity[] = [];
  for (const op of plan.ops) {
    switch (op.kind) {
      case "scan":
        scanned = executor.scan(op.type).filter((row) => row.deleted_hlc === null);
        selected = [];
        rows = scanned;
        break;
      case "select":
        selected = applySelect(scanned, selected, op.predicates, executor);
        rows = selected;
        break;
      case "order":
        rows = [...rows].sort((a, b) => compareRows(a, b, op.field, op.direction));
        break;
      case "limit":
        rows = rows.slice(0, op.limit);
        break;
    }
  }
  return rows;
}
