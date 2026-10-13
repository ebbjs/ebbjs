/**
 * Snapshots — pre-sync capture of the entity rows a buffered local write
 * was built on, exposed publicly as `client.snapshots`.
 *
 * Catch-up re-materializes affected entities from the inbound Action
 * log, and a still-unflushed local write is not in that log, so the
 * optimistic row it produced is overwritten the moment a conflicting
 * inbound Action lands. This manager takes one read-only capture per
 * at-risk entity before the missed window is applied, so a consumer can
 * read what the user had before the merge (backup / undo).
 *
 * Capture lasts for the sync that opened it: the first read of an entity
 * wins and is not refreshed until it is released, so a backup survives a
 * reconnect without overlaying the pre-merge row. The client releases an
 * entity when its conflicts resolve and clears the rest when the session
 * ends. Nothing is persisted, so a capture does not survive a reload.
 */

import type { Entity } from "@ebbjs/core";

/**
 * The application-facing snapshot surface, reachable as
 * `client.snapshots`. Local-only: it issues no network writes and reads
 * at most one entity row per at-risk entity per sync.
 */
export interface Snapshots {
  /** Entity ids captured this sync, in capture order. */
  list(): readonly string[];
  /** Pre-merge row for `entityId`, or `null` when nothing was captured. */
  get(entityId: string): Promise<Entity | null>;
  /** Drop one capture. Unknown ids are a no-op. */
  release(entityId: string): void;
  /** Drop every capture. */
  clear(): void;
}

/** Collaborators the manager needs: one local entity read. */
export interface SnapshotsDependencies {
  /** Read the cached entity row, or `null` when it is not materialized. */
  read(entityId: string): Promise<Entity | null>;
}

/** The manager plus the client-internal capture lifecycle. */
export interface SnapshotManager {
  readonly snapshots: Snapshots;
  /**
   * Capture every entity in `entityIds` not already captured. One read
   * per at-risk entity; a missing row is skipped and retried on the next
   * capture.
   */
  capture(entityIds: Iterable<string>): Promise<void>;
  /** Drop several captures at once. */
  releaseMany(entityIds: Iterable<string>): void;
}

/**
 * Build a snapshot manager over a local entity read.
 */
export function createSnapshots(deps: SnapshotsDependencies): SnapshotManager {
  const rows = new Map<string, Entity>();

  const snapshots: Snapshots = {
    list: () => [...rows.keys()],
    get: (entityId) => Promise.resolve(rows.get(entityId) ?? null),
    release: (entityId) => {
      rows.delete(entityId);
    },
    clear: () => {
      rows.clear();
    },
  };

  const capture = async (entityIds: Iterable<string>): Promise<void> => {
    // Dedupe within the call: one read per at-risk entity per sync. A row
    // already captured stays untouched, so a later sync cannot overlay the
    // pre-merge row. A missing row retains nothing and is retried on the
    // next sync, when the write itself may materialize it.
    const attempted = new Set<string>();
    for (const entityId of entityIds) {
      if (attempted.has(entityId) || rows.has(entityId)) continue;
      attempted.add(entityId);
      const row = await deps.read(entityId);
      if (row !== null) rows.set(entityId, row);
    }
  };

  const releaseMany = (entityIds: Iterable<string>): void => {
    for (const entityId of entityIds) snapshots.release(entityId);
  };

  return { snapshots, capture, releaseMany };
}
