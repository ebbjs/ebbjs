/**
 * Synchronous executor for a {@link Plan} (#498).
 *
 * Every op folds a row list synchronously: the executor reads the
 * replica's own rows and adjacency indices, so a query never awaits and
 * never re-scans storage per accessor. A select group that names an
 * indexed predicate seeds from that index — the source type is read one
 * row at a time by id — so a reverse traversal costs its degree, not the
 * size of the type. Component existence is an index too: `has` intersects
 * its component's ids with the group's other hits, while `hasNot` is a set
 * difference and so can never be cheaper than the model's row count. The
 * plan is the whole story: the executor knows nothing about the schema,
 * the registry, or the builder.
 */

import {
  componentModel,
  EBB_COMPONENTS,
  isFieldMap,
  structuralEqual,
  type EbbComponentKind,
  type Entity,
  type FieldValue,
} from "@ebbjs/core";
import type { MembershipQuery, Replica, RelationshipQuery } from "@ebbjs/storage/replica";

import type { Query } from "./query";
import {
  compileReadComponents,
  joinReadComponents,
  readComponentsFor,
  type CompiledReadComponents,
  type Plan,
  type PlanPredicate,
} from "./query-plan";
import { componentRowView } from "./system-row";
import { recordResultRows } from "./traversal-counter";

/**
 * The read seam a plan executes against: a whole-type scan, a by-id
 * read, the adjacency indices, and component existence. The scan is only
 * materialized for a group that has nothing but field filters and
 * negative existence; an indexed group reaches its rows through
 * {@link PlanExecutor.get}. A candidate-only chain supplies the rows and
 * nothing else, because it can never plan an indexed predicate.
 */
export interface PlanExecutor {
  scan(type: string): readonly Entity[];
  get(id: string): Entity | undefined;
  relationships(query: RelationshipQuery): readonly string[];
  memberships(query: MembershipQuery): readonly string[];
  /** Ids carrying a component (`<type>/<field>`) in the composed view. */
  components(component: string): readonly string[];
}

/** Read straight off the replica's materialized rows and indices. */
export const createReplicaExecutor = (replica: Replica): PlanExecutor => ({
  scan: (type) => recordScan(replica.iterate(type)),
  get: (id) => recordRowRead(replica.get(id)),
  relationships: (query) => replica.relationships(query),
  memberships: (query) => replica.memberships(query),
  components: (component) => replica.components(component),
});

/**
 * Count the rows one materialization read, for the benchmark and the patch
 * acceptance (#942). A scan counts every row it materialized; a by-id read
 * counts the row it returned. The counter is a propagation cost, not a
 * diagnostic: an executor built outside a propagating read (a one-shot
 * terminal, a benchmark probe) records into it all the same, so a reader resets
 * it around the work it measures.
 */
const recordScan = (rows: readonly Entity[]): readonly Entity[] => {
  recordResultRows(rows.length);
  return rows;
};

const recordRowRead = (row: Entity | undefined): Entity | undefined => {
  if (row !== undefined) recordResultRows(1);
  return row;
};

/**
 * Read a platform model through a component's value view: the rows carrying
 * `kind`, each rewritten so its value reads as the row's fields. The indices are
 * the replica's own.
 */
export const createComponentViewExecutor = (
  replica: Replica,
  kind: EbbComponentKind,
): PlanExecutor => {
  const view = (row: Entity): Entity | undefined => componentRowView(row, kind) ?? undefined;
  return {
    scan: (type) => recordScan(replica.iterate(type).flatMap((row) => view(row) ?? [])),
    get: (id) => {
      const row = replica.get(id);
      if (row === undefined) return undefined;
      const visible = view(row);
      return visible === undefined ? undefined : recordRowRead(visible);
    },
    relationships: (query) => replica.relationships(query),
    memberships: (query) => replica.memberships(query),
    components: (component) => replica.components(component),
  };
};

const candidateOnlyError = (): never => {
  throw new Error(
    "candidate-only executor: a chain over already-materialized rows cannot plan an indexed predicate",
  );
};

/**
 * Execute against a fixed candidate list — the relationship accessor
 * chain's rows. `scan` and `get` read that list; the adjacency and
 * existence reads have no index to consult and fail loudly rather than
 * silently matching nothing.
 */
export const createRowsExecutor = (rows: readonly Entity[]): PlanExecutor => ({
  scan: () => rows,
  get: (id) => rows.find((row) => row.id === id),
  relationships: candidateOnlyError,
  memberships: candidateOnlyError,
  components: candidateOnlyError,
});

type Direction = "asc" | "desc";

type IndexPredicate = Exclude<PlanPredicate, { kind: "filter" }>;
type FilterPredicate = Extract<PlanPredicate, { kind: "filter" }>;
type ExistencePredicate = Extract<PlanPredicate, { kind: "existence" }>;

const isIndexPredicate = (predicate: PlanPredicate): predicate is IndexPredicate =>
  predicate.kind !== "filter";

const isFilterPredicate = (predicate: PlanPredicate): predicate is FilterPredicate =>
  predicate.kind === "filter";

/** `hasNot`: an existence predicate that excludes rather than seeds. */
const isNegativeExistence = (predicate: PlanPredicate): predicate is ExistencePredicate =>
  predicate.kind === "existence" && !predicate.present;

const fieldValue = (entity: Entity, field: string): FieldValue["value"] | undefined =>
  entity.data?.fields?.[field]?.value;

/** The whole field envelope, so a map is distinguishable from a leaf. */
const fieldEntry = (entity: Entity, field: string): FieldValue | undefined =>
  entity.data?.fields?.[field];

/**
 * How an ordered field reads for a row. The builder supplies the
 * schema-aware resolver (`stored ?? default`), so a sort compares the same
 * value projection renders. Filtering never uses this: the query path is
 * schema-blind and a default never matches on a caller's behalf.
 */
export type FieldResolver = (entity: Entity, field: string) => unknown;

/** A non-null object or array: the value kinds that have no scalar order. */
const isNonScalar = (value: unknown): boolean => value !== null && typeof value === "object";

/**
 * A `null` predicate asks for "no live value": an absent leaf and a
 * tombstoned one both answer yes. A map envelope is a live value even when
 * its keys are tombstoned (clearing the whole field writes a leaf
 * tombstone), so it never matches. Any non-null value matches only an equal
 * stored leaf — structurally, so an object or array leaf compares by value
 * — and a schema default never widens a filter. A compound leaf is one value
 * on the wire, so a predicate object asks for "this value", never "this
 * reference".
 */
export const matchesFieldValue = (field: FieldValue | undefined, expected: unknown): boolean => {
  if (field === undefined) return expected === null;
  if (isFieldMap(field)) return false;
  return expected === null ? field.value === null : structuralEqual(field.value, expected);
};

/**
 * Same comparison semantics as the builder's ordering — `undefined`
 * last, numbers numerically, everything else by locale — so a query
 * reordered here matches one ordered there.
 */
const compareFieldValues = (
  av: unknown,
  bv: unknown,
  direction: Direction,
  field: string,
): number => {
  // `String()` on an object is `"[object Object]"` for every row, so a
  // non-scalar field would silently tie all of them. A compound value has
  // no total order: refuse it, naming the field, rather than sort by id.
  if (isNonScalar(av) || isNonScalar(bv)) {
    throw new Error(
      `orderBy("${field}"): only scalar fields are orderable; an object or array value ` +
        `has no total order and is not orderable`,
    );
  }
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
const compareRows = (
  a: Entity,
  b: Entity,
  field: string | null,
  direction: Direction,
  resolveField: FieldResolver,
): number => {
  if (field === null) {
    return direction === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  }
  const primary = compareFieldValues(
    resolveField(a, field),
    resolveField(b, field),
    direction,
    field,
  );
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
const predicateHits = (
  predicate: IndexPredicate,
  sourceModel: string,
  executor: PlanExecutor,
): ReadonlySet<string> => {
  switch (predicate.kind) {
    case "adjacency": {
      const { as, type, anyOf } = predicate;
      return indexHits(anyOf, (targetId) => executor.relationships({ as, type, targetId }));
    }
    case "membership":
      return indexHits(predicate.anyOf, (groupId) => executor.memberships({ groupId }));
    case "existence":
      // A component outside this scan's model names nothing the scan can
      // carry, so a positive predicate matches nothing.
      return componentModel(predicate.component) === sourceModel
        ? new Set(executor.components(predicate.component))
        : new Set();
  }
};

/** AND the indexed predicates of one group: only ids every index agrees on survive. */
const intersectHits = (
  predicates: readonly IndexPredicate[],
  sourceModel: string,
  executor: PlanExecutor,
): Set<string> => {
  const [head, ...rest] = predicates.map((predicate) =>
    predicateHits(predicate, sourceModel, executor),
  );
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
    return row !== undefined && row.model === type && row.deleted_hlc === null ? [row] : [];
  });

/**
 * One select op is one DNF group: AND its predicates. A positive indexed
 * predicate seeds the group from its index, so the source type is never
 * iterated. `hasNot` is a complement, so it is a set difference: against
 * the group's positive index hits, or against the model scan when the group
 * has nothing positive to seed from — a `hasNot` therefore costs the model's
 * row count. A group of filters only narrows the (lazy) scan.
 */
const selectGroup = (
  predicates: readonly PlanPredicate[],
  sourceModel: string,
  scanned: () => readonly Entity[],
  executor: PlanExecutor,
): readonly Entity[] => {
  const indexed = predicates.filter(isIndexPredicate);
  const seeds = indexed.filter((predicate) => !isNegativeExistence(predicate));
  const negatives = indexed.filter(isNegativeExistence);

  let rows =
    seeds.length === 0
      ? scanned()
      : rowsForIds(intersectHits(seeds, sourceModel, executor), sourceModel, executor);

  for (const negative of negatives) {
    // A foreign component is carried by no row of this model, so `hasNot`
    // excludes nothing.
    if (componentModel(negative.component) !== sourceModel) continue;
    const excluded = new Set(executor.components(negative.component));
    rows = rows.filter((row) => !excluded.has(row.id));
  }

  return predicates
    .filter(isFilterPredicate)
    .reduce<readonly Entity[]>(
      (survivors, predicate) =>
        survivors.filter((row) =>
          matchesFieldValue(fieldEntry(row, predicate.field), predicate.value),
        ),
      rows,
    );
};

/**
 * Run the plan synchronously. `scan` is declarative — it names the source
 * type and the rows are materialized only when an op actually needs them
 * — and select groups are ORed, deduped by id. `order` and `limit` then
 * narrow the result.
 */
export function executePlan(
  plan: Plan,
  executor: PlanExecutor,
  resolveField: FieldResolver = fieldValue,
): readonly Entity[] {
  let sourceModel = "";
  let scanRows: readonly Entity[] | null = null;
  const scanned = (): readonly Entity[] =>
    (scanRows ??= executor.scan(sourceModel).filter((row) => row.deleted_hlc === null));

  let selecting = false;
  let selected = new Map<string, Entity>();
  let narrowed: readonly Entity[] | null = null;
  const current = (): readonly Entity[] =>
    narrowed ?? (selecting ? [...selected.values()] : scanned());

  for (const op of plan.ops) {
    switch (op.kind) {
      case "scan":
        sourceModel = op.type;
        selecting = false;
        selected = new Map();
        narrowed = null;
        break;
      case "select":
        selecting = true;
        narrowed = null;
        for (const row of selectGroup(op.predicates, sourceModel, scanned, executor)) {
          if (!selected.has(row.id)) selected.set(row.id, row);
        }
        break;
      case "order":
        narrowed = [...current()].sort((a, b) =>
          compareRows(a, b, op.field, op.direction, resolveField),
        );
        break;
      case "limit":
        narrowed = current().slice(0, op.limit);
        break;
    }
  }
  return current();
}

/**
 * The shape a change can be patched into (#942). A patch rewrites one row's
 * projection where it already sits, so it can only reproduce a re-run when the
 * change cannot move the row: no ordering, no limit, and no join, whose
 * membership and cardinality a projected value must never stand in for.
 */
export interface PatchShape {
  /** Whether the plan's own shape can be patched at all. */
  readonly allowed: boolean;
  /** Components whose change only rewrites a row's projection. */
  readonly projected: CompiledReadComponents;
  /**
   * Components whose change moves the row's place: the plan's predicates and
   * ordering, a join's target, and membership for the `groupIds` every query
   * row carries.
   */
  readonly keys: CompiledReadComponents;
}

/**
 * The components a read projects before predicates widen its read set: the
 * selection's components, or the source model whole. A value view seeds the one
 * component it projects.
 */
const projectedComponents = (query: Query): readonly string[] =>
  query.selected !== undefined
    ? query.selected.components
    : (query.sourceComponents ?? [`${query.source}/*`]);

/**
 * Classify a query for patch dispatch. A row read is patchable when it can be
 * re-projected in place — no order, no limit, no join — and a change is only
 * patchable when it names a projected component that is not also a key.
 */
export const patchShapeOf = (query: Query): PatchShape => {
  const keys = new Set<string>(readComponentsFor(query));
  for (const join of query.joins) {
    for (const component of joinReadComponents(join)) keys.add(component);
  }
  // `groupIds` rides on every query row, so a membership write is structural
  // even when the plan names no membership predicate.
  keys.add(EBB_COMPONENTS.membership);
  return {
    allowed:
      query.source !== "" &&
      query.order === null &&
      query.limit === null &&
      query.joins.length === 0,
    projected: compileReadComponents(projectedComponents(query)),
    keys: compileReadComponents([...keys]),
  };
};

/**
 * Splice freshly projected rows into a cached result. The id set and its order
 * are the caller's proof that nothing moved, so a row keeps its position; an
 * unchanged row keeps its reference, and an unchanged result keeps the array,
 * so a view re-renders only for a visible change.
 *
 * `null` means the patch cannot stand in for a run: a row it was handed is not
 * in the result, so placing it would silently change the result set.
 */
export const patchResultRows = <T extends { readonly id: string }>(
  current: readonly T[],
  patched: readonly T[],
): readonly T[] | null => {
  if (patched.length === 0) return current;
  const fresh = new Map(patched.map((row) => [row.id, row]));
  let changed = false;
  const next = current.map((row) => {
    const replacement = fresh.get(row.id);
    if (replacement === undefined) return row;
    fresh.delete(row.id);
    if (structuralEqual(replacement, row)) return row;
    changed = true;
    return replacement;
  });
  if (fresh.size > 0) return null;
  return changed ? next : current;
};
