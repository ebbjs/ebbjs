import type { Action, Entity, Update } from "@ebbjs/core";

import type { LeaseStats, Release } from "./leases";
import type { MembershipRow } from "./row-index";
import type { MembershipLink } from "../types/entity-store";
import type { ReplicaRecord } from "../types/replica-store";

/**
 * A monotonic counter over the replica's observable content. It bumps once
 * per entity change a reader could see — never for delivery bookkeeping like
 * `last_gsn` — so it doubles as the invalidation token for derived state.
 */
export type Revision = number;

/** What a row's place in the set a read is drawn from did. */
export type MembershipTransition = "entered" | "left" | "changed-model";

/**
 * One observable entity change, appended to the revision journal.
 *
 * A change is one of two things. A **content** change is a value a reader can
 * project: it names the components it touched. A **membership** change is the
 * row's place in a model's set moving; it carries no component list, because a
 * row can enter or leave carrying anything. Kept apart, "a row entered or left"
 * stops being encoded as an empty component list, and a reader can tell a value
 * change from a set change without reading the row.
 */
export type ReplicaChange = ContentChange | MembershipChange;

/**
 * What a change moved that the post-change row no longer shows: the edges and
 * the components whose existence moved, and the membership groups on both
 * sides. The journal is the only place an old state is still in hand, so a
 * derived reader learns it here instead of guessing from the new row.
 *
 * Every part is optional and omitted when nothing moved, so a value write to an
 * existing component carries no delta at all.
 */
export interface ChangeDelta {
  /**
   * Live target ids added and removed under each `(as, type)` on `ebb/link`.
   * A tombstoned row contributes no live edges, so deleting a row removes all
   * of its targets.
   */
  readonly edges?: readonly {
    readonly as: string;
    readonly type: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
  /**
   * Components whose existence changed, as opposed to their value. Not the
   * ephemeral Presence primitive: an entity carries a component or it does not.
   */
  readonly existence?: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  /** The row's own `ebb/membership` group ids on each side. */
  readonly groups?: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
}

interface ChangeBase {
  readonly revision: Revision;
  readonly id: string;
  /** Whether the row is tombstoned after the change. */
  readonly deleted: boolean;
  /**
   * Which index keys the change added and removed, when anything moved. It is
   * what lets a reader resolve a relation or a scope from the change alone: a
   * dropped edge or a group the row left is gone from the row itself.
   */
  readonly delta?: ChangeDelta;
}

/** A change to the values of a row that stayed in the set it was read from. */
export interface ContentChange extends ChangeBase {
  readonly kind: "content";
  /**
   * The components this change touched, so a derived reader invalidates on what
   * it read rather than on the row's whole model. A write that moves a row
   * between models and a row arriving or leaving are membership changes, not
   * content ones.
   *
   * Empty when the change moves row metadata — existence or a timestamp —
   * without touching a component value. A row arriving in or leaving a set is
   * never described by an empty list: it is a membership change, which the
   * `membership` kind carries instead.
   */
  readonly components: readonly string[];
}

/** A row entering a model's set, leaving it, or being filed under another. */
export interface MembershipChange extends ChangeBase {
  readonly kind: "membership";
  readonly membership: MembershipTransition;
  /**
   * The models the row is filed under: the one it entered or left, or both
   * sides of a model change. It is what a membership change matches on, since
   * the change names no component.
   */
  readonly models: readonly string[];
}

/**
 * The declared version of a component (`<model>/<leaf>`). The replica stamps
 * this on a write so a later schema upgrade can read-migrate a stored value
 * from the version it was materialized at (#804).
 */
export interface ComponentVersionPolicy {
  declared(component: string): number;
}

export interface ReplicaOptions {
  /**
   * Declared component versions. A write stamps its component at the declared
   * version; a loaded record keeps the stamps it persisted. Without it every
   * component is version 1.
   */
  readonly versions?: ComponentVersionPolicy;
  /**
   * Reads one component from the local stores when a `read` misses. The
   * returned row carries the component's value and the row metadata; the
   * replica adopts the row, keeping any value it already holds for itself.
   * Without it a read stays a miss.
   */
  readonly readComponent?: (id: string, component: string) => Promise<Entity | null>;
  /**
   * How long a component's value stays resident after its last lease is
   * released. Defaults to {@link DEFAULT_RESIDENCY_TTL_MS}. A non-positive or
   * non-finite value disables expiry, so a released value stays resident until
   * a later read claims it. A leased value is never released by the TTL.
   */
  readonly residencyTtlMs?: number;
  /**
   * Maximum retained change-journal entries after trimming. Defaults to
   * {@link DEFAULT_JOURNAL_CAPACITY}. A non-positive or non-finite value keeps
   * the journal unbounded; a positive fraction retains at least one entry.
   */
  readonly journalCapacity?: number;
}

/** A snapshot of what the replica currently materializes and retains. */
export interface ReplicaStats {
  /** Number of row objects currently materialized (tombstones included). */
  readonly entities: number;
  /** Materialized row count per model. */
  readonly byModel: Readonly<Record<string, number>>;
  /**
   * Lease counts: which `(entity, component)` values are leased, which are
   * waiting out their grace period, and the age of the longest wait — overall
   * and per component name.
   */
  readonly leases: LeaseStats;
  /** Components carried by resident rows. */
  readonly components: number;
  readonly revision: Revision;
  /** Append cursor of the last durable position folded into the base. */
  readonly position: number;
  /** Retained journal entries. */
  readonly changes: number;
  /** Oldest revision after which `changesSince` is complete. */
  readonly changeFloor: Revision;
  /**
   * Rows with at least one cold component read in flight. A read's bookkeeping
   * lives exactly as long as the read, so this is 0 whenever nothing is being
   * read — which is what makes a per-read entry the replica forgot to reclaim
   * visible instead of silent.
   */
  readonly readsInFlight: number;
}

/**
 * Serialized bytes the replica retains, by category. Each figure is the UTF-8
 * length of that category's JSON: a stable, reproducible size, not the V8 heap
 * it occupies (a heap account belongs to the harness that can force GC).
 *
 * The categories partition the base rows and the state around them:
 *
 * - `rows` — the row entry envelopes: id, model, existence, timestamps,
 *   last gsn.
 * - `values` — each entry's always-resident fields (leaves and `ebb/*`
 *   components) plus the separate value cache, all with their per-field
 *   `update_id`/`hlc` envelope.
 * - `index` — the derived model, component, edge and membership maps. Versions
 *   live on their entry, not here.
 * - `journal` — the retained change journal, including a discarded prefix a
 *   trim has not compacted yet.
 * - `unconfirmedWrites` — optimistic writes the server has not echoed, the
 *   composed views cached for their rows, and updates waiting for a base row.
 *   A server-confirmed Update buffered behind a cold read is not counted: it
 *   belongs to the base's next settle, not to the overlay.
 *
 * Residency bookkeeping (the lease table, the store-row set, reads in flight)
 * is not a category: it holds no row or value, and its size tracks the number
 * of claims rather than the data.
 */
export interface ReplicaBytes {
  readonly rows: number;
  readonly values: number;
  readonly index: number;
  readonly journal: number;
  readonly unconfirmedWrites: number;
  /** The categories above, summed. */
  readonly total: number;
}

/**
 * Adjacency read key for the replica's relationship reads. `sourceId`
 * reads forward — the live targets on the source row's `ebb/link`
 * component; `targetId` reads reverse — the sources the reverse index files
 * under the target. `sourceId` wins when both are set, and neither yields no
 * ids.
 */
export interface RelationshipQuery {
  readonly as: string;
  readonly type: string;
  readonly sourceId?: string;
  readonly targetId?: string;
}

/**
 * Adjacency read key for the replica's membership index. `groupId`
 * reads the group's members; `entityId` reads the entity's groups.
 * `groupId` wins when both are set, and neither yields no ids.
 */
export interface MembershipQuery {
  readonly groupId?: string;
  readonly entityId?: string;
}

/**
 * The materialized read path. Writes are synchronous and single-writer: the
 * caller serializes them and folds durable updates in ascending log position.
 * Reads return the replica's own row objects (shared, not cloned), tombstones
 * included; callers must treat them as immutable.
 *
 * A row the replica holds has an index entry that answers its model, the
 * components it carries, its live edges and its membership. Leaf and `ebb/*`
 * values are always resident in that entry; a map-shaped user component may
 * have left the value cache, and the local store is its read source.
 */
export interface Replica {
  readonly revision: Revision;
  /**
   * Smallest revision for which the retained journal is complete: the
   * revision of the newest trimmed change, or the loaded record's revision.
   * A `changesSince` below this floor yields nothing because everything may
   * have changed.
   */
  readonly changeFloor: Revision;

  get(id: string): Entity | undefined;
  /**
   * The durable base row for `id`, without this client's optimistic overlay
   * writes. A reader judging "has this row already folded a later Action than
   * the one I am delivering" must read the base: an overlay `put` composes
   * with gsn 0, which would hide the row's folded position.
   */
  base(id: string): Entity | undefined;
  /**
   * Every row of `model`, whatever optional components it carries, as the row
   * index answers it: `data.fields` is the entry's always-resident set, so a
   * map-shaped user value is named but not included.
   */
  iterate(model: string): readonly Entity[];
  /**
   * Whether the replica holds a value for every component `row` carries. Asked
   * of a row read from the local store, it answers whether the replica's own
   * copy is complete — the rule that keeps a partial copy from standing in for
   * the store's row.
   */
  fullyResident(row: Entity): boolean;
  /**
   * Read one row for projection: install the named components the replica does
   * not hold, claiming each for the duration of the read and releasing it
   * before returning. A released value stays resident for one residency grace
   * period, so a remount inside it reads nothing, and a leased value is never
   * released at all. Idempotent and shared: a resident component is not
   * re-read, and a concurrent read of the same component shares the in-flight
   * one. Reading never releases another component: there is no cap. Resolves
   * to the composed row, or `null` when the row is not resident and every read
   * misses.
   */
  read(id: string, components: readonly string[]): Promise<Entity | null>;
  /**
   * Claim the values of `components` on row `id` for as long as the caller needs
   * them, installing any the replica does not hold. The returned release is
   * idempotent; releasing the last claim makes the value inactive for one
   * residency grace period, so it stays warm for a remount and leaves when that
   * elapses. A value the replica folded itself needs no claim — nothing can
   * take it away — and a component the row does not carry is not claimed.
   * Claims are shared: two callers on one value share one read and one
   * residency entry.
   *
   * A long-lived reader (a subscription) holds a claim for its lifetime; a
   * one-shot read takes one for the duration of the read instead (see
   * {@link Replica.read}).
   */
  acquire(id: string, components: readonly string[]): Promise<Release>;
  /** Whether `component`'s value is in the composed view for `id`. */
  isComponentResident(id: string, component: string): boolean;
  /** Component names whose value is resident for `id`, in field order. */
  residentComponents(id: string): readonly string[];
  /**
   * The declared version `id`'s component was last materialized at, or
   * `undefined` when the replica holds no stamp for it. A composed view with
   * an optimistic write to the component reports the declared version.
   */
  componentVersion(id: string, component: string): number | undefined;
  /**
   * Changes newer than `revision`, ascending. Empty when the cursor predates
   * `changeFloor`, where the trimmed journal can no longer answer it.
   */
  changesSince(revision: Revision): readonly ReplicaChange[];
  stats(): ReplicaStats;
  /**
   * Serialized bytes this replica retains, by category. Diagnostic, and not a
   * read path: it serializes every retained structure, so it costs more than
   * {@link stats} does.
   */
  bytes(): ReplicaBytes;

  /**
   * Distinct live targets out of `(as, type, sourceId)`, read from the source
   * entry's edges, or distinct live sources pointing at `(as, type, targetId)`
   * from the row index, ascending.
   */
  relationships(query: RelationshipQuery): readonly string[];
  /**
   * Ids currently carrying `component` (`<type>/<field>`), ascending. The
   * carried set lives in the row index, separately from whether the value is
   * resident, so this read never touches the value cache.
   */
  components(component: string): readonly string[];
  /**
   * Distinct live member entity ids of a group, or distinct live group
   * ids of an entity, ascending.
   */
  memberships(query: MembershipQuery): readonly string[];
  /** Live member-keyed membership rows of an entity, ascending by group then row id. */
  membershipLinks(entityId: string): readonly MembershipLink[];
  /**
   * Every live membership row in the row index, ascending by group then row
   * id. The subscription scope reads this: membership is an index answer, so
   * a value leaving the cache cannot change which group a row is in.
   */
  membershipRows(): readonly MembershipRow[];

  /** Fold one durable Action's `delta` at its log position. */
  ingest(action: Action, delta: readonly Update[], position: number): Revision;
  /** Fold an unacknowledged local Action into the overlay only. */
  optimistic(action: Action): Revision;
  /** Drop an overlay Action's writes, reverting the composed view. */
  discard(actionId: string): Revision;

  /**
   * Replace the materialized base with `record`. The journal resets to that
   * baseline. The revision advances to the record's revision when that is
   * newer, and by one otherwise, so a derived reader always observes the
   * wholesale replacement even when the record is the same revision.
   */
  load(record: ReplicaRecord): Revision;
  toRecord(): ReplicaRecord;

  /**
   * Drop rows from the in-memory base and indices without tombstoning them:
   * afterwards `get(id)` is undefined and `iterate(model)` omits the row. Each
   * removed row journals one change, so derived readers see it leave. Absent
   * ids are ignored. Returns the resulting revision.
   */
  evict(ids: readonly string[]): Revision;

  /**
   * Subscribe to post-change notifications. Fires after every mutating call
   * (`ingest` / `optimistic` / `discard` / `load` / `evict` / `read`) and after
   * a residency expiry, once the composed view has settled, so a derived reader
   * can resynchronise from `revision` and `changesSince`. A no-op write still
   * fires; readers cheaply ignore an unchanged revision. A residency move
   * never advances the revision, so a reader that only tracks the journal sees
   * nothing for it. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}
