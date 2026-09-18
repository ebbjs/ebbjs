/**
 * Conflict detection for the causal tree field.
 *
 * Implements Decision 4 from the design doc:
 * https://.../packages/client/docs/prototypes/collaborative-text/README.md
 *
 * ## Detection rule
 *
 * A conflict is recorded when ALL of these are true:
 *
 * 1. Two or more Updates target the same RunNode (or its split descendants).
 * 2. Those Updates have **concurrent HLCs** — neither strictly happens-before
 *    the other (per Kulkarni et al.'s HLC paper):
 *      a → b iff a.l < b.l OR (a.l == b.l AND a.c < b.c)
 *      concurrent iff neither → nor ←
 * 3. The Updates are **non-trivial** — both modify content (insert or extend),
 *    not just split or tombstone.
 *
 * Happens-before is based on (logical_time, counter) ONLY — not actor_id.
 * Actor_id is a total-order tiebreak for sibling insertion, not for
 * happens-before.
 *
 * ## Implementation
 *
 * Per-run "recently applied" map: tracks the most recent Update targeting
 * each run. When a new non-trivial Update arrives, we check if the
 * previously-applied Update to the same run is concurrent. If yes, record
 * a Conflict.
 *
 * Conflicts live in-memory on the tree. The action log is the source of
 * truth for *what happened*; conflicts are derived metadata. Re-deriving
 * on reload is cheap (walk the log, apply the rule).
 */

import type { Action, HLCTimestamp } from "@ebbjs/core";
import { parse } from "@ebbjs/core";
import { applyActions, isDocSubjectUpdate, DEFAULT_DOC_SUBJECT_TYPE } from "./wire";
import { reconstruct, type DocState } from "./tree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an HLC into { logicalTime, counter }. Used for happens-before checks
 * which ignore the actor_id tiebreak.
 */
const unpackHlc = (hlc: HLCTimestamp): { l: bigint; c: bigint } => {
  const packed = parse(hlc);
  return { l: packed >> 16n, c: packed & 0xffffn };
};

/**
 * Happens-before: a → b iff a.l < b.l OR (a.l == b.l AND a.c < b.c).
 *
 * Returns:
 *   -1  if a happens-before b
 *    1  if b happens-before a
 *    0  if equal OR concurrent
 *
 * (We collapse equal and concurrent to the same return because the caller
 * just needs to know "is there a happens-before relationship in either
 * direction?". A new arrival is always concurrent with itself in the
 * recent-update map.)
 */
export const happensBefore = (a: HLCTimestamp, b: HLCTimestamp): -1 | 0 | 1 => {
  const A = unpackHlc(a);
  const B = unpackHlc(b);
  if (A.l < B.l) return -1;
  if (A.l > B.l) return 1;
  // l equal: counter decides
  if (A.c < B.c) return -1;
  if (A.c > B.c) return 1;
  // equal — not concurrent
  return 0;
};

/**
 * Determine whether an Update is non-trivial (modifies content).
 * Kept for the conflict detector's logical model: field updates with a
 * non-null RunNode value are non-trivial (insert / extend); field
 * updates with `value: null` (tombstones) are not.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A snapshot of the tree state at one point in time. */
export type RunSnapshot = {
  /** The reconstructed document text. */
  readonly text: string;
  /** Number of visible (non-deleted) runs. */
  readonly runCount: number;
};

/** A detected conflict between concurrent Updates targeting the same RunNode. */
export type Conflict = {
  readonly id: string;
  /** RunNode that was concurrently modified. */
  readonly runId: string;
  /** Tree state BEFORE the conflicting Update was applied. */
  readonly preMerge: RunSnapshot;
  /** Tree state AFTER the conflicting Update was applied. */
  readonly postMerge: RunSnapshot;
  /** The Actions whose Updates contributed to this conflict. */
  readonly contributingActions: readonly Action[];
  /** HLCs of the conflicting Updates (one per contributing Action). */
  readonly contributingHlcs: readonly HLCTimestamp[];
  /** Detection timestamp (ms since epoch). */
  readonly detectedAt: number;
};

/** Per-run "last applied non-trivial Update" record. */
type LastApplied = {
  readonly actionId: string;
  readonly action: Action;
  readonly hlc: HLCTimestamp;
  readonly actorId: string;
};

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * ConflictDetector — observes applyActions calls and records Conflicts.
 *
 * Caller invokes {@link observe} after every applyActions batch. The
 * detector walks the applied Actions' Updates, checks each non-trivial
 * Update against the per-run "last applied" map, and records a conflict
 * if it finds a concurrent predecessor.
 *
 * State is in-memory only. Conflicts are not persisted; they can be
 * re-derived by replaying the action log.
 */
export class ConflictDetector {
  /** Per-run last-applied non-trivial Update. */
  private readonly lastAppliedByRun = new Map<string, LastApplied>();
  /** Recorded conflicts, in insertion order. */
  private readonly conflicts: Conflict[] = [];
  /** Auto-incrementing conflict counter for unique IDs. */
  private conflictCounter = 0;

  /** All recorded conflicts. */
  all(): readonly Conflict[] {
    return this.conflicts;
  }

  /** Conflicts targeting a specific run. */
  forRun(runId: string): readonly Conflict[] {
    return this.conflicts.filter((c) => c.runId === runId);
  }

  /** Conflicts detected since the given ms timestamp. */
  since(timestamp: number): readonly Conflict[] {
    return this.conflicts.filter((c) => c.detectedAt >= timestamp);
  }

  /** Clear all recorded conflicts (e.g., on reload). */
  clear(): void {
    this.conflicts.length = 0;
    this.lastAppliedByRun.clear();
  }

  /**
   * Observe a batch of applied Updates.
   *
   * For each non-trivial Update in the batch, check if a previous
   * non-trivial Update to the same run is concurrent. If so, record a
   * Conflict.
   *
   * @param preState  tree state BEFORE applying the actions
   * @param postState tree state AFTER applying the actions
   * @param actions   the actions that were applied (in order)
   * @param actorId   the local actor id (used as a heuristic to attribute conflicts)
   */
  observe(
    preState: DocState,
    postState: DocState,
    actions: readonly Action[],
    actorId: string,
  ): readonly Conflict[] {
    const newConflicts: Conflict[] = [];

    for (const action of actions) {
      for (const update of action.updates) {
        if (!isDocSubjectUpdate(update, DEFAULT_DOC_SUBJECT_TYPE)) continue;
        if (!update.data || typeof update.data !== "object") continue;
        const fields = update.data as Record<string, Record<string, unknown>>;
        for (const [fieldName, field] of Object.entries(fields)) {
          if (!fieldName.startsWith("run:")) continue;
          if (!field || typeof field !== "object") continue;
          const value = field["value"];
          // Tombstones are not non-trivial.
          if (value === null) continue;
          const runId = fieldName.slice("run:".length);
          const kind =
            value && typeof value === "object" && "id" in value
              ? preState.nodes.has(runId)
                ? "extend"
                : "insert"
              : null;
          if (kind === null) continue;

          const previous = this.lastAppliedByRun.get(runId);
          if (previous && previous.actionId !== action.id) {
            // Concurrent check: if neither happens-before holds, it's a conflict.
            // happensBefore returns 0 for both "equal" and "concurrent"; we
            // already filtered out the equal case via the action.id check above
            // (same action redelivered via SSE / replay).
            const rel = happensBefore(previous.hlc, action.hlc);
            if (rel === 0) {
              const conflict: Conflict = {
                id: `conflict_${this.conflictCounter++}`,
                runId,
                preMerge: snapshotOf(preState),
                postMerge: snapshotOf(postState),
                contributingActions: [previous.action, action],
                contributingHlcs: [previous.hlc, action.hlc],
                detectedAt: Date.now(),
              };
              this.conflicts.push(conflict);
              newConflicts.push(conflict);
            }
          }

          // Record this Update as the new "last applied" for this run.
          this.lastAppliedByRun.set(runId, {
            actionId: action.id,
            action,
            hlc: action.hlc,
            actorId,
          });
        }
      }
    }

    return newConflicts;
  }
}

/** Build a snapshot of the tree state for storage in a Conflict record. */
const snapshotOf = (state: DocState): RunSnapshot => {
  let runCount = 0;
  for (const node of state.nodes.values()) {
    if (!node.deleted && node.id !== "ROOT") runCount++;
  }
  return {
    text: reconstruct(state),
    runCount,
  };
};

// ---------------------------------------------------------------------------
// Convenience: re-export for callers
// ---------------------------------------------------------------------------

// Re-export apply-related items so callers don't need a second import.
export { applyActions, isDocSubjectUpdate, DEFAULT_DOC_SUBJECT_TYPE } from "./wire";
export { RUN_FIELD_PREFIX, formatRunFieldName, parseRunFieldName } from "./wire";
