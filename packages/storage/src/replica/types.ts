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
 * while its body is loaded only on demand (#802). A row is resident iff any of
 * its components is held, or the row is pinned.
 */
export interface MaterializationPolicy {
  holds(component: string): boolean;
}

export interface ReplicaOptions {
  readonly materialization?: MaterializationPolicy;
  /**
   * Reads one component from the local stores when `open(id, component)` misses.
   * The returned row carries the component's value and the row metadata; the
   * replica installs only what it is asked for. Without it an open stays a
   * miss.
   */
  readonly readComponent?: (id: string, component: string) => Promise<Entity | null>;
  /**
   * Maximum resident on-demand components. Defaults to 16. A non-positive or
   * non-finite value keeps every opened component resident; opening past the
   * window releases the least recently opened one.
   */
  readonly pinnedCapacity?: number;
  /**
   * How long a closed on-demand component stays cached before release. Defaults
   * to 30_000 ms. A non-positive or non-finite value releases it immediately on
   * close. An open component is never released by the TTL.
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
  /** Rows retained because at least one of their components is held. */
  readonly held: number;
  /** Held row count per type; excludes rows resident only through a pin. */
  readonly heldByType: Readonly<Record<string, number>>;
  /** Resident on-demand components (open or closed and waiting out their TTL). */
  readonly pinned: number;
  /** Components present on resident rows: held, pinned, or overlaid. */
  readonly components: number;
  /** Components whose value is in the composed view. */
  readonly residentComponents: number;
  /** Held component count per component name: the retained metadata footprint. */
  readonly heldComponents: Readonly<Record<string, number>>;
  /** Pinned on-demand component count per component name. */
  readonly pinnedComponents: Readonly<Record<string, number>>;
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
 *
 * A row may be partial: components the policy does not hold are absent from its
 * fields while the replica still knows they exist (`components()` includes
 * them). Opening a component installs its value and pins it.
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
   * Open one component. Reads it through `readComponent` when it is not
   * resident, installs its value, and pins it. Idempotent: a resident component
   * is marked open and touched (LRU order) without another read, a concurrent
   * open shares the in-flight read, and a held component is returned without
   * installing or pinning. Resolves to the composed row, or `null` when the
   * read misses.
   */
  open(id: string, component: string): Promise<Entity | null>;
  /**
   * Close one pinned component. It stays cached until `pinnedTtlMs` so a
   * remount reads it back, then its value leaves; with the TTL disabled it
   * leaves immediately. A no-op for held components.
   */
  close(id: string, component: string): void;
  /** Whether the pin for `(id, component)` is currently open. */
  isOpen(id: string, component: string): boolean;
  /** Whether `component`'s value is in the composed view for `id`. */
  isComponentResident(id: string, component: string): boolean;
  /** Component names whose value is resident for `id`, in field order. */
  residentComponents(id: string): readonly string[];
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
   * component only touches the LRU window, so it fires nothing. Returns an
   * unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}
