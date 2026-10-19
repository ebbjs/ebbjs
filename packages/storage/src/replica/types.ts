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

  get(id: string): Entity | undefined;
  iterate(type: string): readonly Entity[];
  changesSince(revision: Revision): readonly ReplicaChange[];

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

  load(record: ReplicaRecord): Revision;
  toRecord(): ReplicaRecord;

  /**
   * Subscribe to post-change notifications. Fires after every mutating call
   * (`ingest` / `optimistic` / `discard` / `load`) once the composed view is
   * settled, so a derived reader can resynchronise from `revision` and
   * `changesSince`. A no-op write still fires; readers cheaply ignore an
   * unchanged revision. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}
