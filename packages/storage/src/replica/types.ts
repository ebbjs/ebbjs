import type { Action, Entity, Update } from "@ebbjs/core";

import type {
  MembershipLink,
  RelationshipLink,
  RelationshipSourceQuery,
} from "../types/entity-store";
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
  readonly type: string;
  readonly deleted: boolean;
}

/**
 * Whether the replica retains a type's rows. The seam #500 builds on-demand
 * residency against: a policy that holds nothing lets the engine fetch a type
 * on first read and react to the journal it still receives.
 */
export interface MaterializationPolicy {
  holds(type: string): boolean;
}

export interface ReplicaOptions {
  readonly materialization?: MaterializationPolicy;
  /**
   * Reads a row from the local stores when `open` misses. Without it an
   * on-demand id that is not resident stays a miss.
   */
  readonly readEntity?: (id: string) => Promise<Entity | null>;
  /**
   * Maximum resident on-demand rows. Defaults to 16. A non-positive or
   * non-finite value keeps every opened row resident; opening past the
   * window releases the least recently opened one.
   */
  readonly pinnedCapacity?: number;
  /**
   * How long a closed on-demand row stays cached before release. Defaults to
   * 30_000 ms. A non-positive or non-finite value releases it immediately on
   * close. An open row is never released by the TTL.
   */
  readonly pinnedTtlMs?: number;
  /**
   * Maximum retained change-journal entries after trimming. Defaults to 1024.
   * A non-positive or non-finite value keeps the journal unbounded; a
   * positive fraction retains at least one entry.
   */
  readonly journalCapacity?: number;
}

/** A snapshot of what the replica currently materializes and retains. */
export interface ReplicaStats {
  /** Number of row objects currently materialized (tombstones included). */
  readonly entities: number;
  /** Materialized row count per entity type. */
  readonly byType: Readonly<Record<string, number>>;
  /** Rows retained because their type is held: the metadata footprint. */
  readonly held: number;
  /** Held row count per type; excludes opened on-demand rows. */
  readonly heldByType: Readonly<Record<string, number>>;
  /** Resident on-demand rows (open or closed and waiting out their TTL). */
  readonly pinned: number;
  readonly revision: Revision;
  /** Append cursor of the last durable position folded into the base. */
  readonly position: number;
  /** Retained journal entries. */
  readonly changes: number;
  /** Oldest revision after which `changesSince` is complete. */
  readonly changeFloor: Revision;
}

/**
 * Adjacency read key for the replica's relationship index. `sourceId`
 * reads forward — the targets out of the source; `targetId` reads
 * reverse — the sources pointing at the target. `sourceId` wins when
 * both are set, and neither yields no ids.
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
  iterate(type: string): readonly Entity[];
  /** Whether the materialization policy holds `type` in full. */
  isHeld(type: string): boolean;
  /**
   * Load `id` through `readEntity` when absent, pinning it and journaling the
   * install so a derived reader sees the row arrive. Idempotent: a resident row
   * is marked open and touched (LRU order) without another read, a concurrent
   * open shares the in-flight read, and a held row is returned without
   * installing or pinning. Resolves to the composed row, or `null` when the
   * read misses.
   */
  open(id: string): Promise<Entity | null>;
  /**
   * Close a pinned row. It stays cached until `pinnedTtlMs` so a remount reads
   * it back, then leaves; with the TTL disabled it leaves immediately. A no-op
   * for held rows.
   */
  close(id: string): void;
  /** Whether `id` is currently open (closed rows waiting out their TTL are not). */
  isOpen(id: string): boolean;
  /**
   * Changes newer than `revision`, ascending. Empty when the cursor predates
   * `changeFloor`, where the trimmed journal can no longer answer it.
   */
  changesSince(revision: Revision): readonly ReplicaChange[];
  stats(): ReplicaStats;

  /**
   * Distinct live targets out of `(as, type, sourceId)`, or distinct
   * live sources pointing at `(as, type, targetId)`, ascending.
   */
  relationships(query: RelationshipQuery): readonly string[];
  /**
   * Distinct live member entity ids of a group, or distinct live group
   * ids of an entity, ascending.
   */
  memberships(query: MembershipQuery): readonly string[];
  /** Live forward relationship edges out of a source, ascending by target then row id. */
  relationshipLinks(query: RelationshipSourceQuery): readonly RelationshipLink[];
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
   * afterwards `get(id)` is undefined and `iterate(type)` omits the row. Each
   * removed row journals one change, so derived readers see it leave. Absent
   * ids are ignored. Returns the resulting revision.
   */
  evict(ids: readonly string[]): Revision;

  /**
   * Subscribe to post-change notifications. Fires after every mutating call
   * (`ingest` / `optimistic` / `discard` / `load` / `evict` / `open` /
   * `close`) that settles the composed view, so a derived reader can
   * resynchronise from `revision` and `changesSince`. A no-op write still
   * fires; readers cheaply ignore an unchanged revision. Re-opening a resident
   * row only touches the LRU window, so it fires nothing. Returns an
   * unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}
