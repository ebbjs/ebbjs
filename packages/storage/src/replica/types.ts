import type { Action, Entity, Update } from "@ebbjs/core";

import type { LeaseStats } from "./leases";
import type { MembershipLink } from "../types/entity-store";
import type { ReplicaRecord } from "../types/replica-store";

/**
 * A monotonic counter over the replica's observable content. It bumps once
 * per entity change a reader could see — never for delivery bookkeeping like
 * `last_gsn` — so it doubles as the invalidation token for derived state.
 */
export type Revision = number;

/** One observable entity change, appended to the revision journal. */
export interface ReplicaChange {
  readonly revision: Revision;
  readonly id: string;
  readonly deleted: boolean;
  /**
   * The components this change touched, so a derived reader invalidates on what
   * it read rather than on the row's whole model. A tombstone transition touches
   * every component the row carries, and a write that moves a row between models
   * names each field under both prefixes. Empty only for a row that carried no
   * component.
   */
  readonly components: readonly string[];
}

/**
 * Whether the replica retains a component's value. Residency is declared per
 * component (`<model>/<leaf>`), not per row: a note's metadata can be held
 * while its body is leased only while a read needs it (#802, #933). A row is
 * resident iff any of its components is held or claimed by a lease.
 */
export interface MaterializationPolicy {
  holds(component: string): boolean;
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
  readonly materialization?: MaterializationPolicy;
  /**
   * Declared component versions. A write stamps its component at the declared
   * version; a loaded record keeps the stamps it persisted. Without it every
   * component is version 1.
   */
  readonly versions?: ComponentVersionPolicy;
  /**
   * Reads one component from the local stores when a `read` misses. The
   * returned row carries the component's value and the row metadata; the
   * replica installs only what it is asked for. Without it a read stays a miss.
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
  /** Rows retained because at least one of their components is held. */
  readonly held: number;
  /** Held row count per model; excludes rows resident only through a lease. */
  readonly heldByModel: Readonly<Record<string, number>>;
  /**
   * Lease counts: which `(entity, component)` values are leased, which are
   * waiting out their grace period, and the age of the longest wait — overall
   * and per component name.
   */
  readonly leases: LeaseStats;
  /** Components present on resident rows: held, leased, or overlaid. */
  readonly components: number;
  /** Components whose value is in the composed view. */
  readonly residentComponents: number;
  /** Held component count per component name: the retained metadata footprint. */
  readonly heldComponents: Readonly<Record<string, number>>;
  /**
   * Components known to exist on a resident row but whose value is not
   * resident, per component name. A held note with a lazy body reports its body
   * here.
   */
  readonly nonResidentComponents: Readonly<Record<string, number>>;
  /** Total components known to exist on a resident row without their value. */
  readonly nonResident: number;
  readonly revision: Revision;
  /** Append cursor of the last durable position folded into the base. */
  readonly position: number;
  /** Retained journal entries. */
  readonly changes: number;
  /** Oldest revision after which `changesSince` is complete. */
  readonly changeFloor: Revision;
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
 * A row may be partial: components the policy does not hold are absent from its
 * fields while the replica still knows they exist (`components()` includes
 * them). Reading a component installs its value under a lease.
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
   * Every row of `model`, whatever optional components it carries. Served by
   * the model index with the overlay's model overrides layered on top.
   */
  iterate(model: string): readonly Entity[];
  /** Whether the materialization policy holds `component` (`<model>/<leaf>`). */
  isHeld(component: string): boolean;
  /** Whether every component the row carries is held, so it needs no open. */
  isRowHeld(row: Entity): boolean;
  /**
   * Read one row for projection: install the named components the policy does
   * not hold, claiming each for the duration of the read and releasing it
   * before returning. A released value stays resident for one residency grace
   * period, so a remount inside it reads nothing, and a leased value is never
   * released at all. Idempotent and shared: a resident component is not
   * re-read, a concurrent read of the same component shares the in-flight one,
   * and a held component is returned as it is. Reading never releases another
   * component: there is no cap. Resolves to the composed row, or `null` when
   * the row is not resident and every read misses.
   */
  read(id: string, components: readonly string[]): Promise<Entity | null>;
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
   * Distinct live targets out of `(as, type, sourceId)` — a read of the
   * source row's `ebb/link` component — or distinct live sources pointing at
   * `(as, type, targetId)` from the reverse index, ascending.
   */
  relationships(query: RelationshipQuery): readonly string[];
  /**
   * Ids currently carrying `component` (`<type>/<field>`) in the composed
   * view, ascending. Component existence is the set of present components on
   * a row — held or known-but-not-resident — so a query reading it costs its
   * index rather than a row filter.
   */
  components(component: string): readonly string[];
  /**
   * Distinct live member entity ids of a group, or distinct live group
   * ids of an entity, ascending.
   */
  memberships(query: MembershipQuery): readonly string[];
  /** Live member-keyed membership rows of an entity, ascending by group then row id. */
  membershipLinks(entityId: string): readonly MembershipLink[];

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
