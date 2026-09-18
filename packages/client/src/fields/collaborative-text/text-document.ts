/**
 * TextDocument — user-facing facade for the causal-tree field type.
 *
 * Owns the document's `DocState` plus an outbound action queue for
 * locally-authored edits. Incoming Actions (from SSE / catch-up) flow
 * through `applyActions`; locally-authored edits flow through
 * `localInsert` / `localDelete` which both apply locally AND queue the
 * resulting Action for `client.write()`.
 *
 * ## Usage
 *
 * ```ts
 * const doc = await client.textDocument.open('doc_demo');
 *
 * // Listen for updates (fires for both local and remote Updates)
 * doc.onUpdate((update) => { ... });
 *
 * // Listen for detected conflicts
 * doc.onConflict((conflict) => { ... });
 *
 * // Local edit (optimistic — applied immediately, queued for write)
 * doc.localInsert('hello', { afterRun: doc.rootRunId });
 *
 * // Submit pending actions
 * const { rejected } = await client.write(doc.pendingActions());
 *
 * // Apply remote actions (e.g., from the sync client's SSE stream)
 * doc.applyActions(remoteActions);
 * ```
 *
 * ## Identity model
 *
 * `TextDocument` is a per-entity singleton within a `SyncClient`. The
 * `open()` factory is idempotent: opening the same document twice
 * returns the same instance, plus the same `pendingActions()` queue.
 *
 * ## Pending action queue
 *
 * Locally-authored actions accumulate in `pendingActions`. `client.write()`
 * drains them — on rejection the caller is responsible for removing the
 * rejected actions (the document doesn't auto-rollback; that decision is
 * deferred to slice 3+ when outbox semantics land).
 */

import type { Action, HLCTimestamp, Update } from "@ebbjs/core";
import { createDocState, docReducer, type DocState, type RunNode } from "./tree";
import {
  applyActions,
  docActionToUpdate,
  updateToDocAction,
  FIELD_RUN,
  isRunUpdate,
  isWellFormedRunUpdate,
  RUN_SUBJECT_TYPE,
} from "./wire";
import { ConflictDetector, type Conflict } from "./conflict";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Update as it was applied (post-translation). */
export type AppliedUpdate = {
  readonly action: Action;
  readonly runId: string;
  readonly method: "put" | "patch" | "delete";
};

/** Local insert options. */
export interface LocalInsertOptions {
  /** Run id to insert the new run after. Defaults to ROOT. */
  readonly afterRun?: string;
  /**
   * Offset within the parent run to split at (if inserting mid-run).
   * The split is performed locally before the INSERT_RUN is applied.
   * The receiving peer performs the same split (via splitParentAt on the
   * wire-format update).
   */
  readonly splitParentAt?: number;
  /** HLC for the new run. Defaults to Date.now()-derived packed bigint. */
  readonly hlc?: HLCTimestamp;
  /** Local HLC state for advancing on local edits. */
  readonly localHlc?: { l: bigint; c: bigint };
}

/** Local delete options. */
export interface LocalDeleteOptions {
  readonly runId: string;
  readonly offset: number;
  readonly count: number;
  readonly hlc?: HLCTimestamp;
}

/** Update listener. */
export type UpdateListener = (update: AppliedUpdate) => void;

/** Conflict listener. */
export type ConflictListener = (conflict: Conflict) => void;

// ---------------------------------------------------------------------------
// Local clock helper
// ---------------------------------------------------------------------------

/**
 * Advance a local HLC state for a local event.
 *
 * If `now > state.l`, set l=now, c=0. Otherwise bump c.
 * Returns the new HLC and the new state (mutated).
 */
const advanceLocalHlc = (state: {
  l: bigint;
  c: bigint;
}): { hlc: HLCTimestamp; state: { l: bigint; c: bigint } } => {
  const now = BigInt(Date.now());
  if (now > state.l) {
    state.l = now;
    state.c = 0n;
  } else {
    state.c = state.c + 1n;
  }
  const packed = (state.l << 16n) | (state.c & 0xffffn);
  return { hlc: packed.toString() as HLCTimestamp, state };
};

// ---------------------------------------------------------------------------
// TextDocument
// ---------------------------------------------------------------------------

export class TextDocument {
  /** Document id (the entity id hosting the runs). */
  readonly docId: string;
  /** Local actor id (used for outgoing action attribution). */
  readonly actorId: string;

  private state: DocState = createDocState();
  private readonly detector = new ConflictDetector();
  private readonly updateListeners = new Set<UpdateListener>();
  private readonly conflictListeners = new Set<ConflictListener>();
  /** Outbound queue: local edits waiting for `client.write()`. */
  private readonly pending: Action[] = [];
  /** Local HLC state for advancing on local edits. */
  private readonly localHlcState = { l: 0n, c: 0n };
  /** Counter for generating update IDs for local edits. */
  private updateCounter = 0;

  constructor(opts: { docId: string; actorId: string }) {
    this.docId = opts.docId;
    this.actorId = opts.actorId;
  }

  // -------------------------------------------------------------------------
  // Public read API
  // -------------------------------------------------------------------------

  /** Current document state. Read-only — callers should not mutate. */
  get docState(): DocState {
    return this.state;
  }

  /** Current document text (reconstructed via DFS). */
  get text(): string {
    let result = "";
    const { nodes, children } = this.state;
    const stack: string[] = ["ROOT"];
    const output: string[] = [];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = nodes.get(id);
      if (!node) continue;
      if (!node.deleted && node.id !== "ROOT") {
        output.push(node.text);
      }
      const childIds = children.get(id) ?? [];
      // Push in reverse so the first child is processed first (document order
      // is maintained since children are sorted descending).
      for (let i = childIds.length - 1; i >= 0; i--) {
        stack.push(childIds[i]!);
      }
    }
    result = output.join("");
    return result;
  }

  /** All recorded conflicts. */
  conflicts(): readonly Conflict[] {
    return this.detector.all();
  }

  /** Sentinel id of the root run — convenience for "insert at start". */
  get rootRunId(): string {
    return "ROOT";
  }

  /**
   * Find the id of the last visible run in document order. Walks the
   * span array in reverse to find the last runId. Returns null for an
   * empty document.
   */
  private findLastVisibleRunId(): string | null {
    const spans = this.state.index.spans;
    if (spans.length === 0) return null;
    return spans[spans.length - 1]!.runId;
  }

  // -------------------------------------------------------------------------
  // Apply external Actions (from sync / catch-up / SSE)
  // -------------------------------------------------------------------------

  /**
   * Apply a list of Actions to this document. Runs them through the
   * wire-format adapter, applies them to the tree, fires onUpdate
   * listeners, and feeds the detector for conflict recording.
   *
   * Idempotent at the Action level: duplicate Action IDs are no-ops
   * (the wire adapter's applyActions is idempotent because the storage
   * adapter dedupes at this layer). For application-level idempotency,
   * route Actions through `storage.actions.append` first.
   */
  applyActions(actions: readonly Action[]): void {
    if (actions.length === 0) return;
    const pre = this.state;
    const { state: post, applied } = applyActions(pre, actions);
    this.state = post;

    // Fire update listeners for each applied Update
    let actionIdx = 0;
    let updateCounter = 0;
    for (const action of actions) {
      for (const update of action.updates) {
        if (!isRunUpdate(update)) continue;
        if (!isWellFormedRunUpdate(update)) continue;
        if (updateCounter >= applied.length) continue;
        const docAction = applied[updateCounter]!;
        updateCounter++;

        let runId: string;
        if (docAction.type === "INSERT_RUN") runId = docAction.node.id;
        else if (docAction.type === "EXTEND_RUN") runId = docAction.runId;
        else if (docAction.type === "DELETE_RANGE") runId = docAction.runId;
        else continue; // SPLIT is internal

        const evt: AppliedUpdate = {
          action,
          runId,
          method: update.method,
        };
        for (const cb of this.updateListeners) {
          try {
            cb(evt);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[TextDocument] onUpdate handler threw:", err);
          }
        }
      }
      void actionIdx++;
      actionIdx++;
    }

    // Detect conflicts (only over the just-applied actions)
    const newConflicts = this.detector.observe(pre, post, actions, this.actorId);
    for (const conflict of newConflicts) {
      for (const cb of this.conflictListeners) {
        try {
          cb(conflict);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[TextDocument] onConflict handler threw:", err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Apply single Update (convenience for SSE handlers that work per-event)
  // -------------------------------------------------------------------------

  /**
   * Apply a single Update. Wraps it in a synthetic Action and forwards to
   * applyActions. Fires onUpdate exactly once for the underlying run
   * Update.
   */
  applyUpdate(update: Update): void {
    if (!isRunUpdate(update)) return;
    const action: Action = {
      id: update.id, // dedupe by update id (best-effort)
      actor_id: "",
      hlc: "0",
      gsn: 0,
      updates: [update],
    };
    this.applyActions([action]);
  }

  // -------------------------------------------------------------------------
  // Local edits
  // -------------------------------------------------------------------------

  /**
   * Insert text as a new run.
   *
   * Local-only — applies optimistically to the tree immediately, then
   * queues the resulting Action for `client.write()`. The receiver will
   * apply the INSERT_RUN and (if `splitParentAt` is set) the implicit
   * SPLIT before the INSERT_RUN.
   *
   * Default behavior: append at the end of the document (after the last
   * visible run). Pass `afterRun: <runId>` to insert at a specific
   * position, or `afterRun: 'ROOT'` to insert among the root children.
   *
   * Returns the new run's id (or null if the local edit was rejected).
   */
  localInsert(text: string, opts: LocalInsertOptions = {}): string | null {
    // Default parent: the last visible run (so typing sequentially produces
    // 'abc' not 'cba'). If the doc is empty, parent is ROOT.
    let parentId: string;
    if (opts.afterRun !== undefined) {
      parentId = opts.afterRun;
    } else {
      const lastVisible = this.findLastVisibleRunId();
      parentId = lastVisible ?? "ROOT";
    }

    // Advance local HLC
    const { hlc, state: newHlcState } = advanceLocalHlc(opts.localHlc ?? this.localHlcState);
    this.localHlcState.l = newHlcState.l;
    this.localHlcState.c = newHlcState.c;
    const finalHlc = opts.hlc ?? hlc;

    // Build the new RunNode
    const runId = `${finalHlc}:${this.actorId}`;
    const node: RunNode = {
      id: runId,
      hlc: finalHlc,
      actorId: this.actorId,
      text,
      parentId,
      deleted: false,
    };

    // Apply locally (this is optimistic apply per Decision 2)
    const docAction = {
      type: "INSERT_RUN" as const,
      node,
      ...(opts.splitParentAt !== undefined && { splitParentAt: opts.splitParentAt }),
    };
    let next = this.state;
    if (opts.splitParentAt !== undefined) {
      const parentNode = next.nodes.get(parentId);
      if (parentNode && parentNode.text.length > opts.splitParentAt) {
        next = docReducer(next, {
          type: "SPLIT",
          runId: parentId,
          offset: opts.splitParentAt,
        });
      }
    }
    next = docReducer(next, docAction);
    this.state = next;

    // Build the wire-format Update and Action
    const updateId = `u_local_${this.updateCounter++}`;
    const update = docActionToUpdate(docAction, {
      actorId: this.actorId,
      hlc: finalHlc,
      updateId,
    });
    if (!update) return null;

    const action: Action = {
      id: `a_local_${this.updateCounter++}`,
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);

    // Fire onUpdate for the local edit
    const evt: AppliedUpdate = {
      action,
      runId,
      method: "put",
    };
    for (const cb of this.updateListeners) {
      try {
        cb(evt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[TextDocument] onUpdate handler threw:", err);
      }
    }

    return runId;
  }

  /**
   * Delete a range within a run.
   *
   * Returns the resulting DELETE_RANGE action id, or null if the local
   * edit was invalid (e.g., run not found).
   */
  localDelete(opts: LocalDeleteOptions): string | null {
    const node = this.state.nodes.get(opts.runId);
    if (!node || node.deleted) return null;

    // Validate
    if (opts.offset < 0 || opts.count <= 0 || opts.offset + opts.count > node.text.length) {
      return null;
    }

    // Advance local HLC
    const { hlc, state: newHlcState } = advanceLocalHlc(this.localHlcState);
    this.localHlcState.l = newHlcState.l;
    this.localHlcState.c = newHlcState.c;
    const finalHlc = opts.hlc ?? hlc;

    // Apply locally
    const docAction = {
      type: "DELETE_RANGE" as const,
      runId: opts.runId,
      offset: opts.offset,
      count: opts.count,
    };
    this.state = docReducer(this.state, docAction);

    // Build wire-format Update and Action
    const updateId = `u_local_${this.updateCounter++}`;
    const update = docActionToUpdate(docAction, {
      actorId: this.actorId,
      hlc: finalHlc,
      updateId,
    });
    if (!update) return null;

    const action: Action = {
      id: `a_local_${this.updateCounter++}`,
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);

    // Fire onUpdate for the local edit
    const evt: AppliedUpdate = {
      action,
      runId: opts.runId,
      method: "delete",
    };
    for (const cb of this.updateListeners) {
      try {
        cb(evt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[TextDocument] onUpdate handler threw:", err);
      }
    }

    return action.id;
  }

  // -------------------------------------------------------------------------
  // Pending action queue
  // -------------------------------------------------------------------------

  /** Outbound queue of locally-authored actions awaiting `client.write()`. */
  pendingActions(): readonly Action[] {
    // Return a shallow copy so callers can hold references without being
    // affected by ackPending/clearPending mutations on the internal queue.
    return [...this.pending];
  }

  /**
   * Remove actions from the pending queue. Called by callers after
   * `client.write()` rejects actions (or accepts them).
   */
  ackPending(actionIds: readonly string[]): void {
    const idSet = new Set(actionIds);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (idSet.has(this.pending[i]!.id)) {
        this.pending.splice(i, 1);
      }
    }
  }

  /** Clear all pending actions (e.g., on a reset). */
  clearPending(): void {
    this.pending.length = 0;
  }

  // -------------------------------------------------------------------------
  // Event subscriptions
  // -------------------------------------------------------------------------

  /** Subscribe to Update events. Returns an unsubscribe function. */
  onUpdate(cb: UpdateListener): () => void {
    this.updateListeners.add(cb);
    return () => {
      this.updateListeners.delete(cb);
    };
  }

  /** Subscribe to conflict events. Returns an unsubscribe function. */
  onConflict(cb: ConflictListener): () => void {
    this.conflictListeners.add(cb);
    return () => {
      this.conflictListeners.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /** Reset state to empty (for tests / reload). */
  reset(): void {
    this.state = createDocState();
    this.pending.length = 0;
    this.detector.clear();
    this.localHlcState.l = 0n;
    this.localHlcState.c = 0n;
    this.updateCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// Registry — one TextDocument per (client, docId)
// ---------------------------------------------------------------------------

/**
 * In-memory registry of TextDocuments. The `SyncClient.textDocument.open()`
 * accessor pulls from / populates this map. Documents are weakly keyed
 * by docId so callers can hold their own references.
 */
export class TextDocumentRegistry {
  private readonly docs = new Map<string, TextDocument>();

  /** Get or create a TextDocument for the given docId. */
  open(opts: { docId: string; actorId: string }): TextDocument {
    const existing = this.docs.get(opts.docId);
    if (existing && existing.actorId === opts.actorId) {
      return existing;
    }
    const doc = new TextDocument(opts);
    this.docs.set(opts.docId, doc);
    return doc;
  }

  /** Get a TextDocument if open. */
  get(docId: string): TextDocument | undefined {
    return this.docs.get(docId);
  }

  /** Close + forget a TextDocument. */
  close(docId: string): boolean {
    return this.docs.delete(docId);
  }

  /** All open documents. */
  list(): readonly TextDocument[] {
    return [...this.docs.values()];
  }
}

// ---------------------------------------------------------------------------
// Re-exports for callers
// ---------------------------------------------------------------------------

export {
  applyActions,
  docActionToUpdate,
  updateToDocAction,
  isRunUpdate,
  isWellFormedRunUpdate,
  FIELD_RUN,
  RUN_SUBJECT_TYPE,
};
export type { DocState, RunNode } from "./tree";
export type { Conflict } from "./conflict";
