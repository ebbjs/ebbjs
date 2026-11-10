/**
 * Typed thenable QueryBuilder.
 *
 * `await qb` resolves to rows projected through the chain's base row
 * type: a replica-backed `query()` row is a {@link QueryRow} — the
 * shape's fields plus the entity's `id` and live `groupIds` — while a
 * chain over already-materialized candidates keeps a plain
 * {@link ProjectedRow} (fields plus `id`). The injected keys are not
 * envelope access. Raw wire access stays on `.toRaw()` (collections)
 * and the `EntitySnapshot` passed to `subscribe` (single rows).
 * The chain mutators (`where` / `or` / `orderBy` / `limit` / `has` /
 * `hasNot`) are typed against the field map: a field key narrows to
 * `keyof TFields` and its value to the field's TypeBox static type. A key
 * that names a registered relationship on the entity filters that edge
 * instead — see {@link QueryContext}. The reserved `groups` key filters
 * built-in membership. `has` / `hasNot` ask whether the row carries a
 * declared component, which is an index read rather than a value filter.
 *
 * The chain accumulates a serializable {@link Query} (epic decision 13)
 * exposed through {@link QueryBuilder.toQuery}. Predicates are a
 * disjunction of AND-groups (DNF): `.where` adds a conjunct to the
 * current group, `.or` closes it and starts a new one, so
 * `.where(a).where(b).or(c).where(d)` means
 * `(a AND b) OR (c AND d)`. A leading `.or` starts the first group
 * rather than matching every row.
 *
 * Every terminal plans the query and executes the plan synchronously:
 * a replica-backed chain hydrates the replica and reads its rows and
 * adjacency indices; a chain over an already-materialized candidate
 * list runs against those rows. The builder is async because
 * hydration, the candidate loader, and opening a joined on-demand
 * target are.
 *
 * The source type must be held. A query whose source is materialized
 * on demand is refused with {@link OnDemandQueryError}: a scan is
 * held-only. A held source may join an on-demand target; the
 * projecting terminals open those rows before projecting, while
 * `.count()` / `.exists()` / `.toRaw()` never need them.
 *
 * The terminal methods materialize the chain:
 * - `await qb` / `.then(...)` — projected rows.
 * - `.first()` — first projected survivor, or `undefined`.
 * - `.count()` — number of survivors.
 * - `.exists()` — whether any row survives.
 * - `[Symbol.asyncIterator]()` — streaming iterator of projected rows.
 * - `.toRaw()` — untyped escape hatch returning `readonly Entity[]`.
 *
 * Every terminal reads live rows: a tombstoned row (`deleted_hlc` set)
 * is never a survivor, whatever the filters. Deleted-row inspection
 * stays on `get(id)` / the storage adapter.
 *
 * The builder is thenable (has a `.then` method), not a Promise, so
 * `await qb` and `qb.then(...)` work via the standard thenable
 * protocol. Each chain method returns a new builder; the original
 * is untouched.
 */

import type { Entity } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";
import { Value } from "@sinclair/typebox/value";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";
import type { ShapeFields } from "@ebbjs/schema";
import { EntityValidationError, isMapSchema, readDefault, type ModelRegistry } from "@ebbjs/schema";
import { GROUPS_ACCESSOR, groupSystemEntity, type GroupFields } from "@ebbjs/schema";
import { normalizePointer, projectFieldValue, type PointerValue } from "@ebbjs/write";
import type {
  AccessorKeyOf,
  AnyModelDef,
  AnyRelationshipDef,
  FieldsOf,
  SourceNameOf,
  TargetNameOf,
} from "./definition-types";
import { emptyQuery, type Join, type Predicate, type Query } from "./query";
import { planQuery } from "./query-plan";
import {
  createReplicaExecutor,
  createRowsExecutor,
  executePlan,
  type FieldResolver,
  type PlanExecutor,
} from "./query-execute";
import { createLocalQueryStore, type QueryCache, type QueryStore } from "./query-cache";

/**
 * Raised when a chain's source type is materialized on demand. A scan is
 * held-only: reading a body is `get(id)` / `replica.open(id)`, not a query
 * over its type. A held source may still join an on-demand target.
 */
export class OnDemandQueryError extends Error {
  /** The on-demand entity type the refused query scanned. */
  readonly entityName: string;

  constructor(entityName: string) {
    super(
      `query("${entityName}"): "${entityName}" is materialized on demand, and a scan is held-only. ` +
        `Open the row by id instead, or query a held type that relates to it.`,
    );
    this.name = "OnDemandQueryError";
    this.entityName = entityName;
  }
}

export { projectFieldValue } from "@ebbjs/write";

/**
 * Map a single materialized entity onto the schema's TypeBox shape.
 * Pure: the entity is read-only; the projected row is a fresh object. A map
 * field's projection is shared across rows of the same version, so treat it
 * as read-only.
 *
 * Projection states per field:
 * - `data.fields[K]` absent              → the field's declared default, else `undefined`
 * - leaf `data.fields[K].value = V`      → `V`
 * - leaf `data.fields[K].value = null`   → the field's declared default, else `undefined`
 * - map `data.fields[K].map`             → each entry projected,
 *   tombstoned entries omitted
 *
 * An `optional` component may not declare a default, so for one of those
 * the absent and cleared states both read `undefined`: existence is the
 * only thing that separates them, and projection never answers it. A
 * non-optional component keeps resolving its default.
 *
 * A default is read off the property schema, so this takes the shape and
 * never the entity definition. A tombstone is absence with an HLC, not a
 * stored null: it reads exactly like an absent leaf. `projectFieldValue`
 * stays structural and knows nothing about defaults.
 */
export function projectEntity<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
): Static<TObject<ShapeFields<TFields>>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape.properties) as (keyof TFields & string)[]) {
    out[key] = resolveFieldValue(entity, key, shape.properties[key]);
  }
  return out as Static<TObject<ShapeFields<TFields>>>;
}

/**
 * One field's read value: the stored projection, or the property schema's
 * declared default when the leaf is absent or tombstoned. An `optional`
 * component declares no default, so for it both states read `undefined`.
 * Projection and ordering both go through here so the two cannot drift.
 */
const resolveFieldValue = (
  entity: Entity,
  field: string,
  property: TSchema | undefined,
): unknown => {
  const raw = entity.data?.fields?.[field];
  const stored = raw === undefined ? undefined : projectFieldValue(raw);
  return stored ?? readDefault(property);
};

/**
 * Ordered comparison value for one field: the same resolution projection
 * applies, so a sort never disagrees with the value a row renders as.
 */
export const projectedFieldValue = (
  entity: Entity,
  field: string,
  shape: TObject<Record<string, TSchema>>,
): unknown => resolveFieldValue(entity, field, shape.properties[field]);

/**
 * A materialized entity projected to the schema's shape, plus the
 * entity's `id`. The id is the addressing key — `get(row.id)`,
 * `update(row.id, ...)`, a React `key` — not a wire-envelope
 * passthrough: `data` / `type` / HLC stamps stay reachable through
 * `.toRaw()` or the `subscribe` snapshot. The id is `Omit`-ed out of
 * the shape first, so the entity id wins over a field named `id` of
 * any declared type.
 *
 * This is the projection of one entity, with no membership source; a
 * replica-backed query row adds `groupIds` on top as a
 * {@link QueryRow}. A joined target and an already-materialized
 * candidate row stay this shape.
 */
export type ProjectedRow<TFields extends Record<string, TSchema>> = Omit<
  Static<TObject<ShapeFields<TFields>>>,
  "id"
> & {
  readonly id: string;
};

/**
 * A projected query row: the schema's fields, the entity id, and the
 * row's live group ids. `groupIds` names the groups the row is a live
 * member of, so a consumer that only needs the ids does not carry a
 * denormalized `group_id` field or await the `groups` accessor. It is
 * read from the replica's membership index by the query executor, one
 * lookup per row.
 *
 * Both injected keys are `Omit`-ed out of the shape first, so the
 * entity values win over same-named fields of any declared type.
 */
export type QueryRow<TFields extends Record<string, TSchema>> = Omit<
  Static<TObject<ShapeFields<TFields>>>,
  "id" | "groupIds"
> & {
  readonly id: string;
  readonly groupIds: readonly string[];
};

/**
 * Project a materialized entity to a {@link ProjectedRow}: the shape's
 * fields plus the entity id. Pure; the id is injected last so it wins
 * over a same-named projected field.
 */
export function projectRow<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
): ProjectedRow<TFields> {
  return { ...projectEntity(entity, shape), id: entity.id };
}

/** Project every row in a list. Pure; each row carries the entity id. */
export function projectRows<TFields extends Record<string, TSchema>>(
  rows: readonly Entity[],
  shape: TObject<TFields>,
): readonly ProjectedRow<TFields>[] {
  return rows.map((row) => projectRow(row, shape));
}

/**
 * Project a materialized entity to a {@link QueryRow}: the shape's
 * fields, the entity id, and the supplied group ids. Pure; both
 * injected keys are injected last so they win over same-named
 * projected fields.
 */
export function projectQueryRow<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
  groupIds: readonly string[],
): QueryRow<TFields> {
  return { ...projectEntity(entity, shape), id: entity.id, groupIds };
}

/** What a query without schema relationships can join: nothing. */
export type NoJoins = Record<never, never>;

/** A joined row: the target's wire projection plus its id. No nested accessors. */
type JoinedTarget<D> = ProjectedRow<FieldsOf<D>>;

type ForwardJoinValue<R> = R extends {
  readonly target: infer T;
  readonly sourceCardinality: infer C;
}
  ? T extends AnyModelDef
    ? [C] extends ["one"]
      ? JoinedTarget<T> | null
      : readonly JoinedTarget<T>[]
    : never
  : never;

type ReverseJoinValue<R> = R extends { readonly source: infer S }
  ? S extends AnyModelDef
    ? readonly JoinedTarget<S>[]
    : never
  : never;

type ForwardJoinSlots<TRels, TName extends string> = {
  [K in keyof TRels as SourceNameOf<TRels[K]> extends TName
    ? AccessorKeyOf<TRels[K]>
    : never]: ForwardJoinValue<TRels[K]>;
};

type ReverseJoinSlots<TRels, TName extends string> = {
  [K in keyof TRels as TargetNameOf<TRels[K]> extends TName
    ? AccessorKeyOf<TRels[K]>
    : never]: ReverseJoinValue<TRels[K]>;
};

/**
 * The join surface a query over entity `TName` exposes, derived from the
 * schema's relationship map. A source-side relationship joins forward
 * (one-cardinality to a row or `null`, many to an array); a target-side
 * one joins reverse (always an array). A forward slot wins a forward /
 * reverse collision on the same `as`, so a self-referential relationship
 * joins the direction its own declaration names.
 *
 * `TRels` is `undefined` for schemas declared without relationships.
 */
export type JoinRecord<TRels, TName extends string> = [TRels] extends [undefined]
  ? NoJoins
  : TRels extends Record<string, AnyRelationshipDef>
    ? ForwardJoinSlots<TRels, TName> &
        Omit<ReverseJoinSlots<TRels, TName>, keyof ForwardJoinSlots<TRels, TName>>
    : NoJoins;

/** Built-in membership join carried by every entity's query. */
export type MembershipJoin = {
  readonly [GROUPS_ACCESSOR]: readonly ProjectedRow<GroupFields>[];
};

/** Selector accepted by {@link QueryBuilder.with}. */
export type JoinSelection<TJoins extends object> = {
  readonly [K in keyof TJoins]?: true;
};

type NonUndefined<T> = T extends undefined ? never : T;

/**
 * The selector argument: `never` when the chain has no join surface, so a
 * candidate-only chain cannot call `with` at all. The mapped intersection
 * rejects an explicitly `undefined` selector, which an optional property
 * would otherwise admit.
 */
export type JoinArgument<TJoins extends object, TSelection extends JoinSelection<TJoins>> = [
  keyof TJoins,
] extends [never]
  ? never
  : TSelection & { readonly [K in keyof TSelection]: NonUndefined<TSelection[K]> };

/**
 * A projected row widened by its selected joins. Joined keys win over
 * same-named base fields, matching the row accessors. `TRow` is the
 * chain's base projection: a replica-backed query supplies
 * {@link QueryRow}, a candidate chain the plain {@link ProjectedRow}.
 */
export type JoinedRow<
  TFields extends Record<string, TSchema>,
  TJoined extends object,
  TRow extends { readonly id: string } = ProjectedRow<TFields>,
> = Omit<TRow, keyof TJoined> & TJoined;

/** Re-exported from `@ebbjs/write`, where the pointer vocabulary lives. */
export type { PointerValue } from "@ebbjs/write";
export { normalizePointer } from "@ebbjs/write";

/**
 * Everything a replica-backed chain needs to infer and execute a
 * predicate. Built by the entity namespace, which owns the registry and
 * the client's replica binding. Candidate chains carry no context: there
 * a key that isn't a field is rejected rather than inferred as an edge.
 */
export interface QueryContext {
  readonly entityName: string;
  readonly registry: ModelRegistry;
  /** The materialized read path the plan executes over. */
  readonly replica: Replica;
  /** The reactive result cache shared by every chain over this client. */
  readonly queries: QueryCache;
  /** Whether the replica is hydrated, so the plan can run synchronously. */
  hydrated(): boolean;
  /** Bring the replica up to date before the plan runs. Memoized by the client. */
  hydrate(): Promise<void>;
}

/** Loader for the candidate entity list. Resolved lazily on each materialization. */
export type LoadEntities = () => Promise<readonly Entity[]>;

/**
 * The field keys `orderBy` accepts: a field whose declared schema is
 * scalar. An object- or array-shaped field has no total order, so it is
 * refused at the type level and at runtime.
 */
export type OrderableKey<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields & string]: TFields[K] extends { readonly type: "object" | "array" }
    ? never
    : K;
}[keyof TFields & string];

/**
 * A field's stored value is orderable only when it is scalar: the executor
 * compares numbers numerically and everything else lexically, and a
 * compound value has no total order. Refuse an object- or array-shaped
 * declared type where the schema is known, rather than sorting every row
 * into an id tie.
 */
const assertOrderableField = <TFields extends Record<string, TSchema>>(
  shape: TObject<TFields>,
  field: string,
  entityName: string,
): void => {
  const property = shape.properties[field];
  if (property === undefined) return;
  if ("properties" in property || isMapSchema(property) || "items" in property) {
    throw new EntityValidationError([
      {
        entityName,
        field,
        message:
          `orderBy("${field}"): only scalar fields are orderable; ` +
          `object and array values are not orderable`,
      },
    ]);
  }
};

/**
 * Typed thenable chain over a list of candidate entities. The same
 * chain is consumed by `client.<entity>.query()` and by the
 * relationship accessors on a projected row — one chain, one
 * projection.
 *
 * `TRow` is the chain's base projection. A replica-backed `query()`
 * supplies {@link QueryRow} (fields, `id`, `groupIds`); a chain over an
 * already-materialized candidate list keeps the plain
 * {@link ProjectedRow} because it has no membership index to read.
 */
export interface QueryBuilder<
  TFields extends Record<string, TSchema>,
  TJoins extends object = NoJoins,
  TJoined extends object = NoJoins,
  TRow extends { readonly id: string } = ProjectedRow<TFields>,
> {
  /**
   * Equality predicate. A registered relationship key filters that
   * edge — relationship wins over a same-named field, matching the row
   * accessors. The reserved `groups` key filters built-in membership.
   * Any other key filters the data field. Field values narrow to the
   * field's static type; relationship targets accept an id, a handle,
   * or an array meaning any-of. Adds to the current AND-group.
   */
  where<K extends keyof TFields & string>(
    key: K,
    value: Static<TFields[K]> | null,
  ): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /**
   * Relationship-target overload. It stays open over every key because
   * the registry decides field vs. edge at runtime and a relationship
   * wins a same-named field — so any field-named key may be an edge.
   * Typing the exact relationship keys is the #181 follow-up.
   */
  where(
    key: string,
    target: PointerValue | readonly PointerValue[],
  ): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /**
   * Disjunction. Accepts the same key/value forms as {@link where} and
   * starts a new AND-group: `.where(a).where(b).or(c).where(d)` means
   * `(a AND b) OR (c AND d)`. A leading `.or` with no prior `.where`
   * starts the first group — it does not match every row.
   */
  or<K extends keyof TFields & string>(
    key: K,
    value: Static<TFields[K]> | null,
  ): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /** Open pointer overload for {@link or}, mirroring {@link where}'s. */
  or(
    key: string,
    target: PointerValue | readonly PointerValue[],
  ): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /** Ordering on a scalar field of `TFields`; object and array fields are not orderable. */
  orderBy<K extends OrderableKey<TFields>>(
    field: K,
    direction: "asc" | "desc",
  ): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /**
   * Keep the rows currently carrying the component declared under `field`.
   * Existence is a fact about the row — a cleared component is still present —
   * so `has(field)` and `where(field, null)` answer different questions.
   * Reads the replica's component index, one lookup per named component.
   * Refused on a chain over already-materialized rows, which has no index.
   */
  has(field: keyof TFields & string): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /**
   * Keep the rows the component declared under `field` is absent from.
   * Existence is a complement, so this is a set difference against the group's
   * other index hits — or against the model's rows when the group names
   * nothing positive. It therefore costs the model scan, unlike `has`.
   * Refused on a chain over already-materialized rows, which has no index.
   */
  hasNot(field: keyof TFields & string): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<TFields, TJoins, TJoined, TRow>;
  /**
   * Widen each surviving row with one-level joins selected by key. Each
   * selected key comes from {@link JoinRecord}; a nested selector is
   * rejected at the type level and at runtime.
   */
  with<TSelection extends JoinSelection<TJoins>>(
    selection: JoinArgument<TJoins, TSelection>,
  ): QueryBuilder<TFields, TJoins, TJoined & Pick<TJoins, keyof TSelection & keyof TJoins>, TRow>;
  /** First projected survivor, or `undefined` when the chain is empty. */
  first(): Promise<JoinedRow<TFields, TJoined, TRow> | undefined>;
  /** Count of survivors after the chain runs. Joins do not affect the count. */
  count(): Promise<number>;
  /** `true` when at least one row survives the chain. Joins do not affect existence. */
  exists(): Promise<boolean>;
  /** Streaming iterator over projected survivors. */
  [Symbol.asyncIterator](): AsyncIterableIterator<JoinedRow<TFields, TJoined, TRow>>;
  /** Materialize the untyped source entities, skipping projection and joins. */
  toRaw(): Promise<readonly Entity[]>;
  /**
   * Subscribe to the engine-cached result. The listener fires only when the
   * result changes — a source- or join-type change that leaves it identical
   * stays silent. No-op for a chain over an already-materialized list, which
   * carries no engine signal.
   */
  subscribe(listener: () => void): () => void;
  /**
   * The reactive result store — `{ data, status, loading, error }` with a
   * stable snapshot between result changes. Every chain lowering to the same
   * query shares one cached entry, so a remount reads it instead of
   * re-running. A candidate chain gets a one-off store with no invalidation.
   */
  result(): QueryStore<JoinedRow<TFields, TJoined, TRow>>;
  /**
   * The serializable query value the chain has accumulated. Pure data:
   * the planner input and, in #512, the result-cache key.
   */
  toQuery(): Query;
  /** Thenable — `await qb` resolves to the projected rows. */
  then<TResult1 = readonly JoinedRow<TFields, TJoined, TRow>[], TResult2 = never>(
    onfulfilled?:
      | ((value: readonly JoinedRow<TFields, TJoined, TRow>[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

/**
 * Build a QueryBuilder over a list of candidate entities. The chain
 * applies `where` / `orderBy` / `limit` on top; awaiting the builder
 * projects every survivor to the schema's TypeBox shape.
 *
 * Each chain method returns a new builder with the new constraint
 * appended — the original is untouched, so the same builder can be
 * reused across callers without surprising state.
 */
export function buildQueryBuilder<TFields extends Record<string, TSchema>>(
  candidates: readonly Entity[],
  shape: TObject<TFields>,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => candidates;
  return buildLazyQueryBuilder(loader, shape);
}

/**
 * Like {@link buildQueryBuilder} but with a lazy candidate loader.
 * The loader is called every time the chain materializes (via
 * `await qb` or `.toRaw()`) so the chain reflects the latest snapshot
 * of the underlying rows.
 */
export function buildLazyQueryBuilder<TFields extends Record<string, TSchema>>(
  loadCandidates: LoadEntities,
  shape: TObject<TFields>,
): QueryBuilder<TFields> {
  const loadExecutor = async (): Promise<PlanExecutor> =>
    createRowsExecutor(await loadCandidates());
  const projectBase = (row: Entity): ProjectedRow<TFields> => projectRow(row, shape);
  return buildChain(emptyQuery(""), shape, undefined, loadExecutor, projectBase);
}

/**
 * Build the chain `client.<entity>.query()` returns: predicates resolve
 * against `context`'s registry and every terminal executes the plan
 * synchronously over the client's replica, hydrated first. A projected
 * row is a {@link QueryRow}: the shape's fields, the entity id, and the
 * live group ids read from the replica's membership index.
 */
export function buildReplicaQueryBuilder<
  TFields extends Record<string, TSchema>,
  TJoins extends object = NoJoins,
>(
  source: string,
  shape: TObject<TFields>,
  context: QueryContext,
): QueryBuilder<TFields, TJoins, NoJoins, QueryRow<TFields>> {
  if (!context.replica.isHeld(source)) throw new OnDemandQueryError(source);
  const projectBase = (row: Entity, executor: PlanExecutor): QueryRow<TFields> =>
    projectQueryRow(row, shape, entityGroupIds(row.id, executor));
  const syncRun = (query: Query): readonly unknown[] => {
    const executor = createReplicaExecutor(context.replica);
    return projectResultRows(
      executePlan(planQuery(query), executor, (entity, field) =>
        projectedFieldValue(entity, field, shape),
      ),
      query,
      executor,
      context,
      projectBase,
    );
  };
  const asyncRun = async (query: Query): Promise<readonly unknown[]> => {
    const run = await runProjectingPlan(query, replicaExecutor(context), context, (entity, field) =>
      projectedFieldValue(entity, field, shape),
    );
    return projectResultRows(run.rows, query, run.executor, context, projectBase);
  };
  return buildChain<TFields, TJoins, NoJoins, QueryRow<TFields>>(
    emptyQuery(source),
    shape,
    context,
    replicaExecutor(context),
    projectBase,
    syncRun,
    asyncRun,
  );
}

/** Hydrate the replica, then read the plan's rows and indices from it. */
const replicaExecutor = (context: QueryContext) => async (): Promise<PlanExecutor> => {
  await context.hydrate();
  return createReplicaExecutor(context.replica);
};

interface QueryRun {
  readonly rows: readonly Entity[];
  readonly executor: PlanExecutor;
}

/**
 * Plan and execute the chain's narrowing ops, keeping the executor so
 * the join projection can read the same replica or candidate list.
 */
const runPlan = async (
  query: Query,
  loadExecutor: () => Promise<PlanExecutor>,
  resolveField: FieldResolver,
): Promise<QueryRun> => {
  const executor = await loadExecutor();
  return { rows: executePlan(planQuery(query), executor, resolveField), executor };
};

const executeQuery = async (
  query: Query,
  loadExecutor: () => Promise<PlanExecutor>,
  resolveField: FieldResolver,
): Promise<readonly Entity[]> => (await runPlan(query, loadExecutor, resolveField)).rows;

/** Fail loudly rather than projecting through an unregistered shape. */
const shapeForJoin = (
  context: QueryContext | undefined,
  target: string,
): TObject<Record<string, TSchema>> => {
  const shape = context?.registry.get(target)?.shape;
  if (shape === undefined) {
    throw new Error(`with(): joined entity "${target}" is not registered`);
  }
  return shape;
};

/** Ids a join reads from the replica's adjacency index. */
const joinIds = (entity: Entity, join: Join, executor: PlanExecutor): readonly string[] => {
  switch (join.kind) {
    case "relationship":
      return join.direction === "forward"
        ? executor.relationships({ as: join.as, type: join.type, sourceId: entity.id })
        : executor.relationships({ as: join.as, type: join.type, targetId: entity.id });
    case "membership":
      return entityGroupIds(entity.id, executor);
  }
};

/** The joins of this query whose target type the replica does not hold. */
const coldJoins = (query: Query, context: QueryContext | undefined): readonly Join[] =>
  context === undefined ? [] : query.joins.filter((join) => !context.replica.isHeld(join.target));

/** Whether any join of this query reads a target type the replica does not hold. */
const hasOnDemandJoin = (query: Query, context: QueryContext | undefined): boolean =>
  coldJoins(query, context).length > 0;

/**
 * Materialize the on-demand rows a plan's joins read. A held target is already
 * resident, so only a cold join loads anything; a failed load rejects the read
 * rather than projecting a hole.
 */
const openJoinedRows = async (
  rows: readonly Entity[],
  query: Query,
  executor: PlanExecutor,
  context: QueryContext | undefined,
): Promise<void> => {
  if (context === undefined) return;
  const cold = coldJoins(query, context);
  if (cold.length === 0) return;
  const ids = new Set<string>();
  for (const row of rows) {
    for (const join of cold) {
      for (const id of joinIds(row, join, executor)) ids.add(id);
    }
  }
  await Promise.all([...ids].map((id) => context.replica.open(id)));
};

/** Run the plan, then open the on-demand rows its joins read before projecting. */
const runProjectingPlan = async (
  query: Query,
  loadExecutor: () => Promise<PlanExecutor>,
  context: QueryContext | undefined,
  resolveField: FieldResolver,
): Promise<QueryRun> => {
  const run = await runPlan(query, loadExecutor, resolveField);
  await openJoinedRows(run.rows, query, run.executor, context);
  return run;
};

/**
 * The group ids a projected query row carries, read from the replica's
 * entity-keyed membership index.
 */
const entityGroupIds = (entityId: string, executor: PlanExecutor): readonly string[] =>
  executor.memberships({ entityId });

const readJoinedRow = (
  id: string,
  join: Join,
  executor: PlanExecutor,
  context: QueryContext | undefined,
): ProjectedRow<Record<string, TSchema>> | null => {
  const row = executor.get(id);
  if (row === undefined || row.deleted_hlc !== null || row.type !== join.target) return null;
  return projectRow(row, shapeForJoin(context, join.target));
};

const resolveJoin = (
  entity: Entity,
  join: Join,
  executor: PlanExecutor,
  context: QueryContext | undefined,
): unknown => {
  const rows = joinIds(entity, join, executor).flatMap((id) => {
    const row = readJoinedRow(id, join, executor, context);
    return row === null ? [] : [row];
  });
  return join.cardinality === "one" ? (rows[0] ?? null) : rows;
};

/**
 * Project each narrowed row through the chain's base projection, then
 * widen it with the query's joins. Joined keys spread last so they win
 * a same-named base field, matching the row accessors.
 */
const projectResultRows = <
  TFields extends Record<string, TSchema>,
  TRow extends ProjectedRow<TFields>,
>(
  rows: readonly Entity[],
  query: Query,
  executor: PlanExecutor,
  context: QueryContext | undefined,
  projectBase: (row: Entity, executor: PlanExecutor) => TRow,
): readonly (TRow & Record<string, unknown>)[] =>
  rows.map((row) => {
    const base = projectBase(row, executor);
    if (query.joins.length === 0) return base;
    const widened: Record<string, unknown> = { ...base };
    for (const join of query.joins) {
      widened[join.as] = resolveJoin(row, join, executor, context);
    }
    return widened as TRow & Record<string, unknown>;
  });

const resolveJoinDef = (entityName: string, key: string, registry: ModelRegistry): Join => {
  if (key === GROUPS_ACCESSOR) {
    return { kind: "membership", as: key, target: groupSystemEntity.name, cardinality: "many" };
  }
  // Forward wins a collision so a self-referential relationship joins the
  // direction it declares.
  const forward = registry.getRelationship(entityName, key);
  if (forward !== undefined) {
    return {
      kind: "relationship",
      as: key,
      type: forward.type,
      target: forward.target.name,
      direction: "forward",
      cardinality: forward.sourceCardinality,
    };
  }
  const reverse = registry.getRelationshipsForTarget(entityName).find((rel) => rel.as === key);
  if (reverse !== undefined) {
    return {
      kind: "relationship",
      as: key,
      type: reverse.type,
      target: reverse.source.name,
      direction: "reverse",
      cardinality: "many",
    };
  }
  throw new EntityValidationError([
    {
      entityName,
      field: key,
      message: `with("${key}"): not a declared relationship on "${entityName}"`,
    },
  ]);
};

/**
 * Validate a `with(...)` selector and lower it to join descriptors. An
 * existing join with the same key is replaced, so chained `with` calls
 * widen the same row rather than nesting.
 */
const buildJoins = (
  selection: unknown,
  context: QueryContext | undefined,
  existing: readonly Join[],
): readonly Join[] => {
  if (context === undefined) {
    throw new Error(
      "with(): a chain over already-materialized rows carries no schema to resolve joins",
    );
  }
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("with(): expected an object of join selectors");
  }
  const merged = new Map(existing.map((join) => [join.as, join]));
  for (const [key, value] of Object.entries(selection)) {
    if (value !== true) {
      throw new EntityValidationError([
        {
          entityName: context.entityName,
          field: key,
          message: `with("${key}"): select a join with \`true\`; nested with(...) is not supported`,
        },
      ]);
    }
    merged.set(key, resolveJoinDef(context.entityName, key, context.registry));
  }
  return [...merged.values()];
};

/**
 * The single chain implementation. Each mutator returns a new builder
 * carrying the next {@link Query}; the original is untouched. Terminals
 * all funnel through {@link runPlan}, so a replica chain and a candidate
 * chain differ only in where the executor comes from.
 */
function buildChain<
  TFields extends Record<string, TSchema>,
  TJoins extends object = NoJoins,
  TJoined extends object = NoJoins,
  TRow extends { readonly id: string } = ProjectedRow<TFields>,
>(
  initial: Query,
  shape: TObject<TFields>,
  context: QueryContext | undefined,
  loadExecutor: () => Promise<PlanExecutor>,
  projectBase: (row: Entity, executor: PlanExecutor) => TRow,
  syncRun?: (query: Query) => readonly unknown[],
  asyncRun?: (query: Query) => Promise<readonly unknown[]>,
): QueryBuilder<TFields, TJoins, TJoined, TRow> {
  // Ordering reads the field as projection does, so a defaulted field sorts
  // by its default instead of sorting unset rows elsewhere.
  const resolveOrderField: FieldResolver = (entity, field) =>
    projectedFieldValue(entity, field, shape);
  const resultFor = (query: Query): QueryStore<JoinedRow<TFields, TJoined, TRow>> => {
    if (context === undefined || syncRun === undefined) {
      return createLocalQueryStore(async () => {
        const run = await runProjectingPlan(query, loadExecutor, context, resolveOrderField);
        // SAFETY: the candidate chain's own shape and joins produced these rows.
        return projectResultRows(
          run.rows,
          query,
          run.executor,
          context,
          projectBase,
        ) as readonly JoinedRow<TFields, TJoined, TRow>[];
      });
    }
    return context.queries.watch<JoinedRow<TFields, TJoined, TRow>>("rows", query, {
      ready: () => context.hydrate(),
      isReady: () => context.hydrated(),
      // A chain with no on-demand join settles synchronously, so its refresh
      // never flashes `stale`. One that must open a join returns the pending
      // run, which the #512 cache publishes as `stale` until it settles.
      execute: () =>
        hasOnDemandJoin(query, context) && asyncRun !== undefined
          ? (asyncRun(query) as Promise<readonly JoinedRow<TFields, TJoined, TRow>[]>)
          : // SAFETY: `syncRun` closes over this chain's shape and joins.
            (syncRun(query) as readonly JoinedRow<TFields, TJoined, TRow>[]),
    });
  };
  const make = (query: Query): QueryBuilder<TFields, TJoins, TJoined, TRow> => ({
    where(key: string, target: unknown) {
      return make(withConjunct(query, buildPredicate(key, target, shape, context, "where")));
    },
    or(key: string, target: unknown) {
      const predicate = buildPredicate(key, target, shape, context, "or");
      return make({ ...query, groups: [...query.groups, [predicate]] });
    },
    has(field) {
      return make(withConjunct(query, buildExistence(field, true, context)));
    },
    hasNot(field) {
      return make(withConjunct(query, buildExistence(field, false, context)));
    },
    orderBy(field, direction) {
      assertOrderableField(shape, field, context?.entityName ?? "(unknown)");
      return make({ ...query, order: { field, direction } });
    },
    limit(n) {
      return make({ ...query, limit: n });
    },
    with<TSelection extends JoinSelection<TJoins>>(selection: JoinArgument<TJoins, TSelection>) {
      const joins = buildJoins(selection, context, query.joins);
      return make({ ...query, joins }) as unknown as QueryBuilder<
        TFields,
        TJoins,
        TJoined & Pick<TJoins, keyof TSelection & keyof TJoins>,
        TRow
      >;
    },
    toQuery: () => query,
    async first() {
      const run = await runProjectingPlan(query, loadExecutor, context, resolveOrderField);
      const head = projectResultRows(run.rows, query, run.executor, context, projectBase)[0];
      return head as unknown as JoinedRow<TFields, TJoined, TRow> | undefined;
    },
    async count() {
      return (await executeQuery(query, loadExecutor, resolveOrderField)).length;
    },
    async exists() {
      return (await executeQuery(query, loadExecutor, resolveOrderField)).length > 0;
    },
    [Symbol.asyncIterator]() {
      const iter = async function* () {
        const run = await runProjectingPlan(query, loadExecutor, context, resolveOrderField);
        for (const row of projectResultRows(run.rows, query, run.executor, context, projectBase)) {
          yield row as unknown as JoinedRow<TFields, TJoined, TRow>;
        }
      };
      return iter();
    },
    async toRaw() {
      return executeQuery(query, loadExecutor, resolveOrderField);
    },
    subscribe(listener) {
      if (context === undefined || syncRun === undefined) return () => {};
      // A signal never fires on subscribe itself: the first run primes the
      // cache silently, later result changes wake the listener.
      return resultFor(query).subscribe(listener, { initial: false });
    },
    result() {
      return resultFor(query);
    },
    // oxlint-disable-next-line no-thenable -- the QueryBuilder is intentionally a thenable; awaiting it projects the chain.
    then(onfulfilled, onrejected) {
      // Forward `onrejected` onto the whole chain, not just the
      // projection step: a rejecting candidate loader or a failed
      // hydration must settle the awaited builder as a rejection rather
      // than leaving it pending.
      return runProjectingPlan(query, loadExecutor, context, resolveOrderField)
        .then((run) => projectResultRows(run.rows, query, run.executor, context, projectBase))
        .then((rows) => rows as readonly JoinedRow<TFields, TJoined, TRow>[])
        .then(onfulfilled, onrejected);
    },
  });
  return make(initial);
}

/**
 * Turn one `has` / `hasNot` argument into an existence predicate. The field is
 * resolved against the source model's declared components, so the predicate
 * always names `<source>/<field>`; a full component name, or a field the
 * model does not declare, is refused.
 */
function buildExistence(
  field: string,
  present: boolean,
  context: QueryContext | undefined,
): Predicate {
  const method = present ? "has" : "hasNot";
  if (context === undefined) {
    throw new EntityValidationError([
      {
        entityName: "(unknown)",
        field,
        message: `${method}("${field}"): a chain over already-materialized rows carries no component index`,
      },
    ]);
  }
  const component = context.registry.get(context.entityName)?.components[field];
  if (component === undefined) {
    throw new EntityValidationError([
      {
        entityName: context.entityName,
        field,
        message: `${method}("${field}"): not a component on "${context.entityName}"`,
      },
    ]);
  }
  return { kind: "existence", component: component.name, present };
}

/**
 * Append a conjunct to the chain's current AND-group, opening the first group
 * when the chain has none yet.
 */
const withConjunct = (query: Query, predicate: Predicate): Query => {
  const current = query.groups[query.groups.length - 1];
  const groups =
    current === undefined ? [[predicate]] : [...query.groups.slice(0, -1), [...current, predicate]];
  return { ...query, groups };
};

/**
 * Turn one `where` / `or` argument into a predicate. A registered
 * forward relationship on the entity wins over a same-named field; an
 * unknown key throws rather than silently matching nothing.
 */
function buildPredicate<TFields extends Record<string, TSchema>>(
  key: string,
  value: unknown,
  shape: TObject<TFields>,
  context: QueryContext | undefined,
  method: "where" | "or",
): Predicate {
  // `groups` is reserved, so it can never be a declared relationship or
  // a field. With a query context it always means built-in membership;
  // a bare builder carries no registry, so the key falls through to the
  // unknown-field throw below.
  if (key === GROUPS_ACCESSOR && context !== undefined) {
    const label = `${method}("${GROUPS_ACCESSOR}") on "${context.entityName}"`;
    return {
      kind: "membership",
      anyOf: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
    };
  }
  const rel =
    context === undefined ? undefined : context.registry.getRelationship(context.entityName, key);
  if (rel !== undefined && context !== undefined) {
    const label = `${method}("${key}") on "${context.entityName}"`;
    return {
      kind: "relationship",
      as: key,
      type: rel.type,
      anyOf: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
    };
  }
  if (Object.prototype.hasOwnProperty.call(shape.properties, key)) {
    const entityName = context?.entityName ?? "(unknown)";
    // A non-null object or array may have missed the registry and landed
    // here as a field predicate. Accept it only when the field's declared
    // type admits it (array/object-typed fields stay filterable); otherwise
    // reject rather than compare a scalar to an object/array and match nothing.
    if (value !== null && typeof value === "object" && !Value.Check(shape.properties[key], value)) {
      throw new EntityValidationError([
        {
          entityName,
          field: key,
          message: `${method}("${key}"): array/object values are only valid for a relationship key or a field whose declared type accepts them`,
        },
      ]);
    }
    return { kind: "field", field: key, value };
  }
  const entityName = context?.entityName ?? "(unknown)";
  throw new EntityValidationError([
    {
      entityName,
      field: key,
      message: `${method}("${key}"): not a field on "${entityName}" and not a declared relationship`,
    },
  ]);
}

/**
 * Resolve a relationship predicate's pointer(s) to a deduplicated
 * any-of id set. An empty set (an empty array, or every entry
 * null/undefined) becomes `null`: the pointer names no live edge, so
 * the predicate matches nothing.
 */
function resolveTargetIds(
  value: PointerValue | readonly PointerValue[],
  label: string,
): readonly string[] | null {
  const list = Array.isArray(value) ? (value as readonly PointerValue[]) : [value as PointerValue];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = normalizePointer(entry, label);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length === 0 ? null : ids;
}
