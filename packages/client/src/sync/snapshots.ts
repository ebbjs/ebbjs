/**
 * Snapshots — per-pass pre-sync capture of the entity rows a buffered
 * local write was built on, exposed publicly as `client.snapshots`.
 *
 * Catch-up re-materializes affected entities from the inbound Action
 * log, and a still-unflushed local write is not in that log, so the
 * optimistic row it produced is overwritten the moment a conflicting
 * inbound Action lands. This manager takes one read-only capture per
 * at-risk entity per catch-up pass, before the missed window is applied,
 * so a consumer can read what the user had before the merge (backup /
 * undo) and the outbox can pair each conflict with the row that preceded
 * its own window.
 *
 * Captures are keyed by the pass's `catchUpId`: one pass's capture never
 * satisfies another pass's read, so a second reconnect captures afresh
 * instead of reusing the first window's row. Within a pass the first
 * read wins. The public surface keeps the #395 session-first read — the
 * earliest capture is the one a backup should see — while releasing an
 * entity across every pass, so `duplicate({ at: "preSync" })` and the
 * resolution-driven release keep working until the manager is retired
 * (#410). Nothing is persisted; a capture does not survive a reload.
 */

import type { Entity } from "@ebbjs/core";

/**
 * The application-facing snapshot surface, reachable as
 * `client.snapshots`. Local-only: it issues no network writes and reads
 * at most one entity row per at-risk entity per pass.
 */
export interface Snapshots {
  /** Entity ids captured in any retained pass, in capture order. */
  list(): readonly string[];
  /**
   * Earliest retained pre-merge row for `entityId` (session-first, so a
   * reconnect does not overlay the backup row), or `null` when none.
   */
  get(entityId: string): Promise<Entity | null>;
  /** Drop one entity's captures across every pass. Unknown ids are a no-op. */
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
   * Capture every entity in `entityIds` not already captured for
   * `catchUpId`. One read per at-risk entity; a missing row is skipped
   * and retried on a later pass.
   */
  capture(catchUpId: string, entityIds: Iterable<string>): Promise<void>;
  /**
   * The row captured for `entityId` on `catchUpId`'s pass, or `null`
   * when that pass captured none. The outbox's `preSyncRow` reader.
   */
  readPass(catchUpId: string, entityId: string): Entity | null;
  /** Drop several captures at once, across every pass. */
  releaseMany(entityIds: Iterable<string>): void;
}

/**
 * Build a snapshot manager over a local entity read.
 */
export function createSnapshots(deps: SnapshotsDependencies): SnapshotManager {
  // Pass -> entity id -> row, in pass order: the earliest capture for an
  // entity is the first one written.
  const passes = new Map<string, Map<string, Entity>>();

  const snapshots: Snapshots = {
    list: () => {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const pass of passes.values()) {
        for (const entityId of pass.keys()) {
          if (seen.has(entityId)) continue;
          seen.add(entityId);
          ids.push(entityId);
        }
      }
      return ids;
    },
    get: (entityId) => {
      for (const pass of passes.values()) {
        const row = pass.get(entityId);
        if (row !== undefined) return Promise.resolve(row);
      }
      return Promise.resolve(null);
    },
    release: (entityId) => {
      for (const pass of passes.values()) pass.delete(entityId);
    },
    clear: () => {
      passes.clear();
    },
  };

  const capture = async (catchUpId: string, entityIds: Iterable<string>): Promise<void> => {
    // Dedupe within the call: one read per at-risk entity per pass. The
    // first capture in a pass wins, and a later pass captures afresh. A
    // missing row retains nothing and is retried on the next pass, when
    // the write itself may materialize it.
    const attempted = new Set<string>();
    for (const entityId of entityIds) {
      if (attempted.has(entityId)) continue;
      attempted.add(entityId);
      if (passes.get(catchUpId)?.has(entityId) === true) continue;
      const row = await deps.read(entityId);
      if (row === null) continue;
      const pass = passes.get(catchUpId);
      if (pass === undefined) passes.set(catchUpId, new Map([[entityId, row]]));
      else if (!pass.has(entityId)) pass.set(entityId, row);
    }
  };

  const readPass = (catchUpId: string, entityId: string): Entity | null =>
    passes.get(catchUpId)?.get(entityId) ?? null;

  const releaseMany = (entityIds: Iterable<string>): void => {
    for (const entityId of entityIds) snapshots.release(entityId);
  };

  return { snapshots, capture, readPass, releaseMany };
}
