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
 * The chain accumulates a serializable {@link Query}
 * exposed through {@link QueryBuilder.toQuery}. Predicates are a
 * disjunction of AND-groups (DNF): `.where` adds a conjunct to the
 * current group, `.or` closes it and starts a new one, so
 * `.where(a).where(b).or(c).where(d)` means
 * `(a AND b) OR (c AND d)`. A leading `.or` starts the first group
 * rather than matching every row.
 *
 * Every terminal plans the query over the replica (or an
 * already-materialized candidate list) and projects the survivors. A
 * replica-backed terminal hydrates first; one whose page projects a component
 * the replica does not hold acquires that page before projecting, so it awaits
 * a store read.
 *
 * A read declares the fields it needs with `.select({...})`. The selection is
 * the projection, the lease set, and the invalidation key; system components
 * (`ebb/link`, `ebb/membership`, joined targets) are planner-supplied. A
 * projecting terminal narrows the ids first, then acquires the components the
 * page projects — including a store-backed source or join target — while
 * `.count()` / `.exists()` / `.toRaw()` never acquire the projection. An
 * unlimited projection is therefore a full read: page it with `limit`.
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

import {
  carriesComponent,
  componentName,
  EBB_COMPONENTS,
  fieldComponent,
  EBB_MODEL_NAME,
  type EbbComponentKind,
  type Entity,
} from "@ebbjs/core";
import type { Replica, Release } from "@ebbjs/storage/replica";
import { Value } from "@sinclair/typebox/value";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";
import type { ShapeFields } from "@ebbjs/schema";
import { EntityValidationError, isMapSchema, readDefault, type ModelRegistry } from "@ebbjs/schema";
import { GROUPS_ACCESSOR } from "@ebbjs/schema";
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
import { joinReadComponents, planQuery } from "./query-plan";
import {
  createComponentViewExecutor,
  createReplicaExecutor,
  createRowsExecutor,
  executePlan,
  matchesFieldValue,
  type FieldResolver,
  type PlanExecutor,
} from "./query-execute";
import {
  projectSelectedFields,
  querySelection,
  selectionBase,
  selectionFieldKeys,
  selectionProjection,
  type ComponentFor,
  type Selection,
} from "./selection";
import { componentRowView, type GroupFieldMap } from "./system-row";
import type { QueryResults, QueryStore } from "./query-results";
import type { ComponentMigrations } from "./migrations";

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
 *
 * `fields` narrows the projection to a selection; absent projects the whole
 * shape.
 */
export function projectEntity<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
  migrations?: ComponentMigrations,
  fields?: readonly string[] | null,
): Static<TObject<ShapeFields<TFields>>> {
  const shapeFields = Object.keys(shape.properties);
  return projectSelectedFields(fields ?? null, shapeFields, (field) =>
    resolveFieldValue(entity, field, shape.properties[field], migrations),
  ) as Static<TObject<ShapeFields<TFields>>>;
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
  migrations?: ComponentMigrations,
): unknown => {
  const raw = entity.data?.fields?.[field];
  if (raw === undefined) return readDefault(property);
  const stored = projectFieldValue(raw);
  const value =
    migrations === undefined
      ? stored
      : migrations.project(entity.id, componentName(entity.model, field), stored);
  return value ?? readDefault(property);
};

/**
 * Ordered comparison value for one field: the same resolution projection
 * applies, so a sort never disagrees with the value a row renders as.
 */
export const projectedFieldValue = (
  entity: Entity,
  field: string,
  shape: TObject<Record<string, TSchema>>,
  migrations?: ComponentMigrations,
): unknown => resolveFieldValue(entity, field, shape.properties[field], migrations);

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
 * A row narrowed by a selection: exactly the selected fields plus the
 * structural keys the chain's base row carries — `id`, and `groupIds` on a
 * replica-backed query row. A key the row does not have cannot be selected.
 */
export type SelectedRow<TRow extends { readonly id: string }, TSelection> = Pick<
  TRow,
  Extract<keyof TSelection, keyof TRow> | Extract<keyof TRow, "id" | "groupIds">
>;

/**
 * Project a materialized entity to a {@link ProjectedRow}: the shape's
 * fields plus the entity id. Pure; the id is injected last so it wins
 * over a same-named projected field.
 */
export function projectRow<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
  migrations?: ComponentMigrations,
  fields?: readonly string[] | null,
): ProjectedRow<TFields> {
  return { ...projectEntity(entity, shape, migrations, fields), id: entity.id };
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
  migrations?: ComponentMigrations,
  fields?: readonly string[] | null,
): QueryRow<TFields> {
  return { ...projectEntity(entity, shape, migrations, fields), id: entity.id, groupIds };
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
  readonly [GROUPS_ACCESSOR]: readonly ProjectedRow<GroupFieldMap>[];
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
  /**
   * The component a `has` / `hasNot` field resolves to, for a chain over a value
   * view: every row in such a view carries the same atomic component. Absent for
   * an ordinary chain, where the field names `<model>/<field>`.
   */
  readonly componentFor?: (field: string) => string | null;
  /** The materialized read path the plan executes over. */
  readonly replica: Replica;
  /** The reactive results view shared by every chain over this client. */
  readonly results: QueryResults;
  /** Whether the replica is hydrated, so the plan can run synchronously. */
  hydrated(): boolean;
  /** Bring the replica up to date before the plan runs. Memoized by the client. */
  hydrate(): Promise<void>;
  /** Read migrations for stored component versions, when the schema declares any. */
  readonly migrations?: ComponentMigrations;
}

/**
 * The binding a reactive chain needs: the results view a chain subscribes to,
 * and the synchronous page read whose result that store holds. A chain over
 * already-materialized rows has neither.
 */
interface ResultEngine {
  readonly context: QueryContext;
  readonly syncRun: (query: Query) => readonly unknown[] | null;
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
  /**
   * Declare the model fields this read projects. The selection is also the
   * lease set and the invalidation key; an unselected field is neither
   * returned, leased, nor watched. System components are implicit and cannot
   * be selected: `groupIds` is on every query row, `ebb/link` is added by a
   * relationship predicate or join, and `ebb/membership` by a membership
   * predicate or the `groups` join.
   *
   * An unknown key or a value other than `true` is rejected at the type level
   * and at runtime. `.select({})` returns only the structural keys (`id`, and
   * `groupIds` on a query row). A projection the replica does not hold is read
   * by narrowing first and acquiring the page, so page an unlimited projection.
   */
  select<TSelection extends Selection<TFields>>(
    selection: TSelection,
  ): QueryBuilder<TFields, TJoins, TJoined, SelectedRow<TRow, TSelection>>;
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
   * Subscribe to the retained result. The listener fires only when the
   * result changes — a source- or join-type change that leaves it identical
   * stays silent. Refused on a chain over an already-materialized list, which
   * has no engine binding for a change event.
   */
  subscribe(listener: () => void): () => void;
  /**
   * The reactive results view — `{ data, status, loading, error }` with a
   * stable snapshot between result changes. Every chain lowering to the same
   * query shares one retained entry, so a remount reads it instead of
   * re-running. Refused on a candidate chain, which has no result entry.
   */
  result(): QueryStore<JoinedRow<TFields, TJoined, TRow>>;
  /**
   * The serializable query value the chain has accumulated. Pure data:
   * the planner input and, in #512, the result key.
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
  migrations?: ComponentMigrations,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => candidates;
  return buildLazyQueryBuilder(loader, shape, migrations);
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
  migrations?: ComponentMigrations,
): QueryBuilder<TFields> {
  const loadExecutor = async (): Promise<PlanExecutor> =>
    createRowsExecutor(await loadCandidates());
  const projectBase = (
    row: Entity,
    _executor: PlanExecutor,
    fields: readonly string[] | null,
  ): ProjectedRow<TFields> => projectRow(row, shape, migrations, fields);
  return buildChain(emptyQuery(""), shape, undefined, loadExecutor, projectBase, () => null);
}

/**
 * A patch of one projected page (#942): re-project the rows a change named
 * against the current replica, or decline when a projection would not be the
 * re-run it stands in for.
 *
 * The ids it returns are spliced into the retained result, so the run's own
 * shape is already known to be patchable (no order, no limit, no join) and no
 * change it is handed touches a predicate, an order key, or a join target. What
 * remains is whether this row is the row a run would project:
 *
 * - a row that left the replica, changed model, or no longer satisfies the
 *   filters is not in the result a re-run would produce;
 * - a projected value the replica does not hold is an acquisition, which only
 *   the async run performs (a resident value needs no read, so the patch
 *   projects it exactly as the run would).
 *
 * Either way the answer is `null`: the caller re-runs, which owns acquiring,
 * filtering, and proving the row's place.
 */
const patchProjection =
  (
    query: Query,
    context: QueryContext,
    view: EbbComponentKind | undefined,
    projectBase: (row: Entity, executor: PlanExecutor, fields: readonly string[] | null) => unknown,
  ) =>
  (ids: readonly string[]): readonly unknown[] | null => {
    const executor = replicaExecutorFor(context, view);
    const held = projectionComponents(query, context);
    const fields = selectionProjection(query.selected);
    const rendered = ids.flatMap((id) => {
      const row = executor.get(id);
      if (row === undefined || row.model !== query.source || row.deleted_hlc !== null) return [];
      if (!matchesEveryFilter(row, query)) return [];
      const missing = held.some(
        (component) => !context.replica.isComponentResident(row.id, component),
      );
      if (missing) return [];
      return [projectBase(row, executor, fields)];
    });
    return rendered.length === ids.length ? rendered : null;
  };

/**
 * Re-apply the plan's field predicates to one row: a patch may narrow, never
 * widen. A non-field predicate (an adjacency, membership, or existence test)
 * reads an index rather than the row, so this cannot re-evaluate it and treats
 * it as satisfied. That is safe only because such a predicate is a `keys`
 * component: `patchableRows` declines the batch, so no row whose place depends
 * on one ever reaches here through the results view. A source calling `patch` on its
 * own must keep that contract, or it will widen a result it cannot re-narrow.
 */
const matchesEveryFilter = (row: Entity, query: Query): boolean =>
  query.groups.length === 0 ||
  query.groups.some((group) =>
    group.every(
      (predicate) =>
        predicate.kind !== "field" ||
        matchesFieldValue(row.data?.fields?.[predicate.field], predicate.value),
    ),
  );

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
  view?: EbbComponentKind,
): QueryBuilder<TFields, TJoins, NoJoins, QueryRow<TFields>> {
  const projectBase = (
    row: Entity,
    executor: PlanExecutor,
    fields: readonly string[] | null,
  ): QueryRow<TFields> =>
    projectQueryRow(row, shape, membershipRowIds(row.id, executor), context.migrations, fields);
  const resolveField: FieldResolver = (entity, field) =>
    projectedFieldValue(entity, field, shape, context.migrations);
  /**
   * Project the page synchronously when the replica already holds everything
   * it reads. `null` means a component must be acquired first, which only the
   * async run does.
   *
   * The check runs the whole narrowing plan, and the async path then runs it
   * again to acquire and project the same page. That is deliberate for now:
   * only the narrowed page answers whether a row needs acquisition, so it has
   * to be planned before the answer exists. A cold read of a large projection
   * therefore pays the plan twice; #962 owns that cost.
   */
  const syncRun = (query: Query): readonly unknown[] | null => {
    const executor = replicaExecutorFor(context, view);
    const rows = executePlan(planQuery(query), executor, resolveField);
    if (pageNeedsAcquisition(rows, query, executor, context)) return null;
    // Narrowing reads index rows. A projection reads the composed row, whose
    // value cache may hold what the index deliberately does not.
    const page = rows.map((row) => executor.get(row.id) ?? row);
    return projectResultRows(page, query, executor, context, projectBase);
  };
  const asyncRun = (query: Query): Promise<readonly unknown[]> =>
    runProjected(query, replicaExecutor(context, view), context, resolveField, projectBase);
  const patchRun = (query: Query): ((ids: readonly string[]) => readonly unknown[] | null) =>
    patchProjection(query, context, view, projectBase);
  // A value view resolves every field to its one platform component.
  const componentFor: ComponentFor =
    context.componentFor ?? ((field) => fieldComponent(source, field));
  return buildChain<TFields, TJoins, NoJoins, QueryRow<TFields>>(
    emptyQuery(source, view === undefined ? undefined : [EBB_COMPONENTS[view]]),
    shape,
    context,
    replicaExecutor(context, view),
    projectBase,
    componentFor,
    syncRun,
    asyncRun,
    patchRun,
  );
}

/** An executor over the replica, optionally through a component's value view. */
const replicaExecutorFor = (context: QueryContext, view?: EbbComponentKind): PlanExecutor =>
  view === undefined
    ? createReplicaExecutor(context.replica)
    : createComponentViewExecutor(context.replica, view);

/** Hydrate the replica, then read the plan's rows and indices from it. */
const replicaExecutor =
  (context: QueryContext, view?: EbbComponentKind) => async (): Promise<PlanExecutor> => {
    await context.hydrate();
    return replicaExecutorFor(context, view);
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
      return membershipRowIds(entity.id, executor);
  }
};

/** Expand the planner's whole-model reads to the components a registry declares. */
const expandReads = (reads: readonly string[], context: QueryContext): readonly string[] => {
  const out = new Set<string>();
  for (const read of reads) {
    if (!read.endsWith("/*")) {
      out.add(read);
      continue;
    }
    const model = read.slice(0, -2);
    for (const component of context.registry.componentsOf(model)) out.add(component.name);
  }
  return [...out];
};

/**
 * The components a page's projection needs: the selection, or the whole row
 * when the read selected nothing. A value view's source seed is a scan detail,
 * not a projection, so `.select({})` projects nothing.
 */
const projectionComponents = (query: Query, context: QueryContext): readonly string[] =>
  expandReads(selectionBase(query), context);

/** The components a join's target rows must hold to project the join. */
const joinLeaseComponents = (join: Join, context: QueryContext): readonly string[] =>
  expandReads(joinReadComponents(join), context);

/**
 * Whether the page needs a lease: a selected, projected, or joined component
 * some row it projects does not already hold. The answer is per row, not per
 * query, so the check runs on the page the plan narrowed — a page the replica
 * already holds projects synchronously.
 */
const pageNeedsAcquisition = (
  rows: readonly Entity[],
  query: Query,
  executor: PlanExecutor,
  context: QueryContext,
): boolean => {
  const source = projectionComponents(query, context);
  const joins = query.joins.map((join) => ({
    join,
    components: joinLeaseComponents(join, context),
  }));
  return rows.some((row) => {
    if (source.some((component) => !context.replica.isComponentResident(row.id, component))) {
      return true;
    }
    return joins.some(({ join, components }) =>
      joinIds(row, join, executor).some((id) =>
        components.some((component) => !context.replica.isComponentResident(id, component)),
      ),
    );
  });
};

const noopRelease: Release = () => {};

const releaseAll = (releases: readonly Release[]): Release => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
  };
};

/**
 * Acquire the components the narrowed page projects, and each join target's,
 * before projecting. The narrowing ops already picked the page, so only these
 * rows are read — the two-phase read that makes a store-backed projection
 * legal without materializing the type. The caller releases after projection;
 * a retained result then holds the same components through its subscription.
 */
const acquirePage = async (
  rows: readonly Entity[],
  query: Query,
  executor: PlanExecutor,
  context: QueryContext | undefined,
): Promise<Release> => {
  if (context === undefined) return noopRelease;
  const source = projectionComponents(query, context);
  const joins = query.joins
    .map((join) => ({ join, components: joinLeaseComponents(join, context) }))
    .filter(({ components }) => components.length > 0);
  if (source.length === 0 && joins.length === 0) return noopRelease;
  const releases: Release[] = [];
  try {
    for (const row of rows) {
      if (source.length > 0) releases.push(await context.replica.acquire(row.id, source));
      for (const { join, components } of joins) {
        for (const id of joinIds(row, join, executor)) {
          releases.push(await context.replica.acquire(id, components));
        }
      }
    }
  } catch (thrown) {
    releaseAll(releases)();
    throw thrown;
  }
  return releaseAll(releases);
};

/**
 * Run the narrowing plan, acquire the page's projection, project, and release.
 * The projection owns its values, so releasing after it is safe.
 */
const runProjected = async <TRow extends { readonly id: string }>(
  query: Query,
  loadExecutor: () => Promise<PlanExecutor>,
  context: QueryContext | undefined,
  resolveField: FieldResolver,
  projectBase: (row: Entity, executor: PlanExecutor, fields: readonly string[] | null) => TRow,
): Promise<readonly unknown[]> => {
  const run = await runPlan(query, loadExecutor, resolveField);
  const release = await acquirePage(run.rows, query, run.executor, context);
  try {
    // Acquiring installs a component by replacing the row, so project the
    // page's current rows rather than the pre-acquisition references.
    const rows = run.rows.map((row) => run.executor.get(row.id) ?? row);
    return projectResultRows(rows, query, run.executor, context, projectBase);
  } finally {
    release();
  }
};

/**
 * The group ids a projected query row carries, read from the replica's
 * entity-keyed membership index.
 */
const membershipRowIds = (entityId: string, executor: PlanExecutor): readonly string[] =>
  executor.memberships({ entityId });

/**
 * The value shape of a platform component: `registry.get("ebb").shape` is the
 * four-component envelope, never one kind's value.
 */
const componentValueShape = (
  context: QueryContext | undefined,
  component: string,
): TObject<Record<string, TSchema>> => {
  const shape = context?.registry.componentOf(EBB_MODEL_NAME, component)?.shape;
  if (shape === undefined) {
    throw new Error(`with(): platform component "${component}" is not registered`);
  }
  return shape as TObject<Record<string, TSchema>>;
};

const readJoinedRow = (
  id: string,
  join: Join,
  executor: PlanExecutor,
  context: QueryContext | undefined,
): ProjectedRow<Record<string, TSchema>> | null => {
  const row = executor.get(id);
  if (row === undefined || row.deleted_hlc !== null || row.model !== join.target) return null;
  if (join.kind === "membership") {
    // The `groups` join projects group rows: filter on the component and project
    // its value.
    if (!carriesComponent(row, "group")) return null;
    return projectRow(
      componentRowView(row, "group") ?? row,
      componentValueShape(context, EBB_COMPONENTS.group),
      context?.migrations,
    );
  }
  return projectRow(row, shapeForJoin(context, join.target), context?.migrations);
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
const projectResultRows = <TRow extends { readonly id: string }>(
  rows: readonly Entity[],
  query: Query,
  executor: PlanExecutor,
  context: QueryContext | undefined,
  projectBase: (row: Entity, executor: PlanExecutor, fields: readonly string[] | null) => TRow,
): readonly (TRow & Record<string, unknown>)[] =>
  rows.map((row) => {
    const base = projectBase(row, executor, selectionProjection(query.selected));
    if (query.joins.length === 0) return base;
    const widened: Record<string, unknown> = { ...base };
    for (const join of query.joins) {
      widened[join.as] = resolveJoin(row, join, executor, context);
    }
    return widened as TRow & Record<string, unknown>;
  });

const resolveJoinDef = (entityName: string, key: string, registry: ModelRegistry): Join => {
  if (key === GROUPS_ACCESSOR) {
    // Group rows are `ebb` rows carrying `ebb/group`; the join reads them
    // through that component's value view.
    return { kind: "membership", as: key, target: EBB_MODEL_NAME, cardinality: "many" };
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
  projectBase: (row: Entity, executor: PlanExecutor, fields: readonly string[] | null) => TRow,
  componentFor: ComponentFor,
  syncRun?: (query: Query) => readonly unknown[] | null,
  asyncRun?: (query: Query) => Promise<readonly unknown[]>,
  patchRun?: (query: Query) => (ids: readonly string[]) => readonly unknown[] | null,
): QueryBuilder<TFields, TJoins, TJoined, TRow> {
  // Ordering reads the field as projection does, so a defaulted field sorts
  // by its default instead of sorting unset rows elsewhere.
  const resolveOrderField: FieldResolver = (entity, field) =>
    projectedFieldValue(entity, field, shape, context?.migrations);
  const resultFor = (
    query: Query,
    engine: ResultEngine,
  ): QueryStore<JoinedRow<TFields, TJoined, TRow>> => {
    const patch = patchRun?.(query);
    return engine.context.results.watch<JoinedRow<TFields, TJoined, TRow>>("rows", query, {
      ready: () => engine.context.hydrate(),
      isReady: () => engine.context.hydrated(),
      // A page the replica already holds settles synchronously, so its refresh
      // never flashes `stale`. One that must acquire a component or a join
      // target returns the pending run, which the results view publishes as `stale`
      // until it settles.
      execute: () => {
        const rows = engine.syncRun(query);
        if (rows !== null || asyncRun === undefined) {
          return rows as readonly JoinedRow<TFields, TJoined, TRow>[];
        }
        return asyncRun(query) as Promise<readonly JoinedRow<TFields, TJoined, TRow>[]>;
      },
      // A change that only rewrites a projected value re-projects these rows
      // instead of re-running the plan (#942).
      patch:
        patch === undefined
          ? undefined
          : (ids) => patch(ids) as readonly JoinedRow<TFields, TJoined, TRow>[] | null,
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
    select<TSelection extends Selection<TFields>>(selection: TSelection) {
      const fields = selectionFieldKeys(selection, shape, context?.entityName ?? "(unknown)");
      const selected = querySelection(fields, componentFor);
      return make({ ...query, selected }) as unknown as QueryBuilder<
        TFields,
        TJoins,
        TJoined,
        SelectedRow<TRow, TSelection>
      >;
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
      const rows = await runProjected(query, loadExecutor, context, resolveOrderField, projectBase);
      return rows[0] as unknown as JoinedRow<TFields, TJoined, TRow> | undefined;
    },
    async count() {
      return (await executeQuery(query, loadExecutor, resolveOrderField)).length;
    },
    async exists() {
      return (await executeQuery(query, loadExecutor, resolveOrderField)).length > 0;
    },
    [Symbol.asyncIterator]() {
      const iter = async function* () {
        const rows = await runProjected(
          query,
          loadExecutor,
          context,
          resolveOrderField,
          projectBase,
        );
        for (const row of rows) yield row as JoinedRow<TFields, TJoined, TRow>;
      };
      return iter();
    },
    async toRaw() {
      return executeQuery(query, loadExecutor, resolveOrderField);
    },
    subscribe(listener) {
      if (context === undefined || syncRun === undefined) {
        throw new Error(
          "subscribe(): a chain over already-materialized rows has no engine binding for a change event; await the chain to re-read",
        );
      }
      // A listener never fires on subscribe itself: the first run primes the
      // store silently, later result changes wake the listener.
      return resultFor(query, { context, syncRun }).subscribe(listener, { initial: false });
    },
    result() {
      if (context === undefined || syncRun === undefined) {
        throw new Error(
          "result(): a chain over already-materialized rows has no engine store; await the chain to read it",
        );
      }
      return resultFor(query, { context, syncRun });
    },
    // oxlint-disable-next-line no-thenable -- the QueryBuilder is intentionally a thenable; awaiting it projects the chain.
    then(onfulfilled, onrejected) {
      // Forward `onrejected` onto the whole chain, not just the
      // projection step: a rejecting candidate loader or a failed
      // hydration must settle the awaited builder as a rejection rather
      // than leaving it pending.
      return runProjected(query, loadExecutor, context, resolveOrderField, projectBase)
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
  const name =
    context.componentFor?.(field) ??
    context.registry.get(context.entityName)?.components[field]?.name;
  if (name === undefined || name === null) {
    throw new EntityValidationError([
      {
        entityName: context.entityName,
        field,
        message: `${method}("${field}"): not a component on "${context.entityName}"`,
      },
    ]);
  }
  return { kind: "existence", component: name, present };
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
