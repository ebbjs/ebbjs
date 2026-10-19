import type { Action, Entity, Update } from "@ebbjs/core";

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

  /** Fold one durable Action's `delta` at its log position. */
  ingest(action: Action, delta: readonly Update[], position: number): Revision;
  /** Fold an unacknowledged local Action into the overlay only. */
  optimistic(action: Action): Revision;
  /** Drop an overlay Action's writes, reverting the composed view. */
  discard(actionId: string): Revision;

  load(record: ReplicaRecord): Revision;
  toRecord(): ReplicaRecord;
}
