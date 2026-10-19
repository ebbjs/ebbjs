/**
 * Synchronous executor for a {@link Plan} (#498).
 *
 * Every op folds a row list synchronously: the executor reads the
 * replica's own rows and adjacency indices, so a query never awaits and
 * never re-scans storage per accessor. A select group that names an
 * indexed predicate seeds from that index — the source type is read one
 * row at a time by id — so a reverse traversal costs its degree, not the
 * size of the type. The plan is the whole story: the executor knows
 * nothing about the schema, the registry, or the builder.
 */

import type { Entity, FieldValue } from "@ebbjs/core";
import type { MembershipQuery, Replica, RelationshipQuery } from "@ebbjs/storage/replica";

import type { Plan, PlanPredicate } from "./query-plan";

/**
 * The read seam a plan executes against: a whole-type scan, a by-id
 * read, and the two adjacency indices. The scan is only materialized for
 * a group that has nothing but field filters; an indexed group reaches
 * its rows through {@link PlanExecutor.get}. A candidate-only chain
 * supplies the rows and nothing else, because it can never plan an
 * indexed predicate.
 */
export interface PlanExecutor {
  scan(type: string): readonly Entity[];
  get(id: string): Entity | undefined;
  relationships(query: RelationshipQuery): readonly string[];
  memberships(query: MembershipQuery): readonly string[];
}

/** Read straight off the replica's materialized rows and indices. */
export const createReplicaExecutor = (replica: Replica): PlanExecutor => ({
  scan: (type) => replica.iterate(type),
  get: (id) => replica.get(id),
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
 * chain's rows. `scan` and `get` read that list; the adjacency reads
 * have no index to consult and fail loudly rather than silently
 * matching nothing.
 */
export const createRowsExecutor = (rows: readonly Entity[]): PlanExecutor => ({
  scan: () => rows,
  get: (id) => rows.find((row) => row.id === id),
  relationships: candidateOnlyError,
  memberships: candidateOnlyError,
});

type Direction = "asc" | "desc";

type IndexPredicate = Exclude<PlanPredicate, { kind: "filter" }>;
type FilterPredicate = Extract<PlanPredicate, { kind: "filter" }>;

const isIndexPredicate = (predicate: PlanPredicate): predicate is IndexPredicate =>
  predicate.kind !== "filter";

const isFilterPredicate = (predicate: PlanPredicate): predicate is FilterPredicate =>
  predicate.kind === "filter";

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

/** The ids one indexed predicate contributes, read from its index. */
const predicateHits = (predicate: IndexPredicate, executor: PlanExecutor): ReadonlySet<string> => {
  switch (predicate.kind) {
    case "adjacency": {
      const { as, type, anyOf } = predicate;
      return indexHits(anyOf, (targetId) => executor.relationships({ as, type, targetId }));
    }
    case "membership":
      return indexHits(predicate.anyOf, (groupId) => executor.memberships({ groupId }));
  }
};

/** AND the indexed predicates of one group: only ids every index agrees on survive. */
const intersectHits = (
  predicates: readonly IndexPredicate[],
  executor: PlanExecutor,
): Set<string> => {
  const [head, ...rest] = predicates.map((predicate) => predicateHits(predicate, executor));
  if (head === undefined) return new Set();
  const ids = new Set(head);
  for (const next of rest) {
    for (const id of ids) {
      if (!next.has(id)) ids.delete(id);
    }
  }
  return ids;
};

/**
 * Resolve an index-derived id set to rows one read at a time. The index
 * can name a row the replica does not hold (a link to a subject that
 * never materialized), so each hit is checked against the scan type and
 * the tombstone rule before it counts as a survivor.
 */
const rowsForIds = (
  ids: ReadonlySet<string>,
  type: string,
  executor: PlanExecutor,
): readonly Entity[] =>
  [...ids].flatMap((id) => {
    const row = executor.get(id);
    return row !== undefined && row.type === type && row.deleted_hlc === null ? [row] : [];
  });

/**
 * One select op is one DNF group: AND its predicates. An indexed
 * predicate seeds the group from its index, so the source type is never
 * iterated; a group of filters only narrows the (lazy) scan.
 */
const selectGroup = (
  predicates: readonly PlanPredicate[],
  sourceType: string,
  scanned: () => readonly Entity[],
  executor: PlanExecutor,
): readonly Entity[] => {
  const indexed = predicates.filter(isIndexPredicate);
  const seed =
    indexed.length === 0
      ? scanned()
      : rowsForIds(intersectHits(indexed, executor), sourceType, executor);
  return predicates
    .filter(isFilterPredicate)
    .reduce<readonly Entity[]>(
      (rows, predicate) =>
        rows.filter((row) => fieldValue(row, predicate.field) === predicate.value),
      seed,
    );
};

/**
 * Run the plan synchronously. `scan` is declarative — it names the source
 * type and the rows are materialized only when an op actually needs them
 * — and select groups are ORed, deduped by id. `order` and `limit` then
 * narrow the result.
 */
export function executePlan(plan: Plan, executor: PlanExecutor): readonly Entity[] {
  let sourceType = "";
  let scanRows: readonly Entity[] | null = null;
  const scanned = (): readonly Entity[] =>
    (scanRows ??= executor.scan(sourceType).filter((row) => row.deleted_hlc === null));

  let selecting = false;
  let selected = new Map<string, Entity>();
  let narrowed: readonly Entity[] | null = null;
  const current = (): readonly Entity[] =>
    narrowed ?? (selecting ? [...selected.values()] : scanned());

  for (const op of plan.ops) {
    switch (op.kind) {
      case "scan":
        sourceType = op.type;
        selecting = false;
        selected = new Map();
        narrowed = null;
        break;
      case "select":
        selecting = true;
        narrowed = null;
        for (const row of selectGroup(op.predicates, sourceType, scanned, executor)) {
          if (!selected.has(row.id)) selected.set(row.id, row);
        }
        break;
      case "order":
        narrowed = [...current()].sort((a, b) => compareRows(a, b, op.field, op.direction));
        break;
      case "limit":
        narrowed = current().slice(0, op.limit);
        break;
    }
  }
  return current();
}
