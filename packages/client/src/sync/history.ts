/**
 * Entity history — the application-facing read over the replica's Action
 * log.
 *
 * One event per Action that touched the entity, in GSN order. `changes` is
 * the shared field-path projection the conflict view reads, so a map-key
 * edit is a `path` entry rather than a whole-map replacement, and `methods`
 * is what makes a delete legible: `applyUpdate` keeps a deleted row's
 * fields, so a delete has no removals to diff.
 *
 * Pure functions over the log, not the replica: the read is unit-testable
 * without a client, and it holds no state between calls.
 */

import type { Action, Entity, Update } from "@ebbjs/core";
import { foldEntityAction } from "@ebbjs/storage/replica";
import type { ActionLog } from "@ebbjs/storage/types";
import { diffEntity, type EntityDiff } from "@ebbjs/write";

/** How many events a read returns when the caller names no limit. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Which entity's history to read, and how much of it. */
export interface HistoryOptions {
  readonly entityId: string;
  /**
   * Newest events to return, at most. A slice after the log's full read,
   * not a read bound — see {@link readEntityHistory}. Defaults to
   * {@link DEFAULT_HISTORY_LIMIT}.
   */
  readonly limit?: number;
  /** Return only events with a strictly lower GSN — the paging cursor. */
  readonly beforeGsn?: number;
}

/** One Action that touched the entity, with the positions it moved. */
export interface HistoryEvent {
  /** The Action that produced the event. */
  readonly actionId: string;
  /** The actor that authored it. Synthetic seeds and backfill appear here too. */
  readonly actorId: string;
  /** The Action's hybrid logical clock; the event-time key. */
  readonly hlc: string;
  /** The Action's server sequence number; the ordering and paging key. */
  readonly gsn: number;
  /**
   * The methods of this Action's Updates addressed to the entity, each once
   * and in first-seen order. A create-plus-patch Action reports both. The
   * method is what the Action attempted: a patch the fold rejected (a
   * tombstoned or absent row) still appears here with no `changes`.
   */
  readonly methods: readonly Update["method"][];
  /** The field positions the Action moved, in the shared diff vocabulary. */
  readonly changes: readonly EntityDiff[];
}

/** Which entity to project, and the Action to project it at. */
export interface ReplayOptions {
  readonly entityId: string;
  /** Fold through and including this Action. */
  readonly at: { readonly actionId: string };
}

/** The methods of one Action's Updates for the entity, distinct and first-seen order. */
const entityMethods = (action: Action, entityId: string): readonly Update["method"][] => {
  const methods: Update["method"][] = [];
  for (const update of action.updates) {
    if (update.subject_id !== entityId) continue;
    if (methods.includes(update.method)) continue;
    methods.push(update.method);
  }
  return methods;
};

/**
 * One event per Action, folding the log forward so each event's diff reads
 * the row before and after that Action — the same fold rule the entity
 * stores apply, so a position cannot be reported differently here than the
 * read model materializes it.
 */
const foldEvents = (entityId: string, actions: readonly Action[]): readonly HistoryEvent[] => {
  const events: HistoryEvent[] = [];
  let before: Entity | null = null;
  for (const action of actions) {
    const after = foldEntityAction(before, entityId, action);
    events.push({
      actionId: action.id,
      actorId: action.actor_id,
      hlc: action.hlc,
      gsn: action.gsn,
      methods: entityMethods(action, entityId),
      changes: diffEntity(before, after),
    });
    before = after;
  }
  return events;
};

/**
 * Read the entity's events, newest first.
 *
 * `getForEntity` orders by GSN and the fold follows that order, including a
 * backfill Action with `gsn: 0` folding first even though it was delivered
 * later. Reads whatever the local log holds. A just-saved local edit is
 * absent until its echo lands: local Actions are applied to the replica
 * optimistically but are not appended to the log until the server returns
 * them with a GSN.
 *
 * `beforeGsn` is a strict filter on the event's GSN and `limit` slices the
 * newest survivors, so the pair pages backwards. Both are applied after
 * the log's full read — `ActionLog.getForEntity` reads the entity's whole
 * action list — so `limit` bounds the result, not the cost. Backfill
 * Actions can carry `gsn: 0` and a re-delivered Action can repeat a GSN, so
 * a page boundary inside such a tie can omit the other events sharing that
 * GSN; keep the tied events in one page or resume from the tied events.
 */
export const readEntityHistory = async (
  log: Pick<ActionLog, "getForEntity">,
  options: HistoryOptions,
): Promise<readonly HistoryEvent[]> => {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (limit <= 0) return [];

  const events = foldEvents(options.entityId, await log.getForEntity(options.entityId));
  const { beforeGsn } = options;
  const older = beforeGsn === undefined ? events : events.filter((event) => event.gsn < beforeGsn);

  return older.slice(Math.max(older.length - limit, 0)).reverse();
};

/**
 * The row as of an Action, folding through and including it.
 *
 * Returns `null` when the entity's local log holds no such Action — a
 * compacted id, or one that belongs to another entity — or when the fold
 * never materialized a row at that point (a `patch` or `delete` with no
 * earlier base, as a compacted log can leave). A tombstoned row keeps its
 * fields and its `deleted_hlc`: this is the row the log materializes, not a
 * post-delete absence.
 */
export const replayEntity = async (
  log: Pick<ActionLog, "getForEntity">,
  options: ReplayOptions,
): Promise<Entity | null> => {
  let row: Entity | null = null;
  for (const action of await log.getForEntity(options.entityId)) {
    row = foldEntityAction(row, options.entityId, action);
    if (action.id === options.at.actionId) return row;
  }
  return null;
};
