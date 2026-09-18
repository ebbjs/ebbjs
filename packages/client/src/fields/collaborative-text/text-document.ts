/**
 * TextDocument — user-facing facade for the causal-tree field type.
 *
 * Owns the document's `DocState` plus an outbound action queue for
 * locally-authored edits. Incoming Actions (from SSE / catch-up) flow
 * through `applyActions`; locally-authored edits flow through
 * `localInsert` / `localDelete` which both apply locally AND queue the
 * resulting Action for `client.write()`.
 *
 * ## Wire format
 *
 * Each Update targets the document entity (subject_id = docId,
 * subject_type = docType, method: "patch") with run changes encoded as
 * `data.fields["run:<runId>"] = { value: <RunNode | null>, update_id, hlc }`.
 * Runs are fields of the doc, not separate entities — this keeps the
 * server's `<type>.<verb>` permission model applicable to the doc as a
 * whole and avoids the cross-author rewrite problem that `run.update`
 * would have if runs were independent entities.
 *
 * ## Usage
 *
 * ```ts
 * const doc = client.textDocument.open('doc_demo');
 *
 * doc.onUpdate((update) => { ... });
 * doc.onConflict((conflict) => { ... });
 *
 * // Local edit (optimistic — applied immediately, queued for write)
 * doc.localInsert('hello');
 *
 * const { rejected } = await client.write(doc.pendingActions());
 * doc.applyActions(remoteActions);
 * ```
 */

import type { Action, HLCTimestamp, Update } from "@ebbjs/core";
import {
  createDocState,
  docReducer,
  type DocState,
  type RunFieldValue,
  type RunNode,
} from "./tree";
import {
  applyActions,
  diffRunFields,
  diffRunFieldsForDeleteRange,
  docActionToUpdate,
  DEFAULT_DOC_SUBJECT_TYPE,
  formatRunFieldName,
  parseRunFieldName,
  RUN_FIELD_PREFIX,
} from "./wire";
import { ConflictDetector, type Conflict } from "./conflict";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Update as it was applied (post-translation). */
export type AppliedUpdate = {
  readonly action: Action;
  readonly runId: string;
  readonly kind: "insert" | "extend" | "tombstone";
};

/** Local insert options. */
export interface LocalInsertOptions {
  /** Run id to insert the new run after. Defaults to the last visible run. */
  readonly afterRun?: string;
  /**
   * Offset within the parent run to split at (if inserting mid-run).
   * The split is performed locally and the resulting halves are encoded
   * as field updates on the wire (the receiver doesn't need to re-split).
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
 * Advance a local HLC state for a local event. If `now > state.l`, set
 * l=now, c=0. Otherwise bump c. Returns the new HLC and the new state
 * (mutated).
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
  /**
   * The subject_type of the document entity. Defaults to
   * "text_document"; override only if you need a custom type.
   */
  readonly docType: string;

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

  constructor(opts: { docId: string; actorId: string; docType?: string }) {
    this.docId = opts.docId;
    this.actorId = opts.actorId;
    this.docType = opts.docType ?? DEFAULT_DOC_SUBJECT_TYPE;
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
   */
  applyActions(actions: readonly Action[]): void {
    if (actions.length === 0) return;
    const pre = this.state;
    const { state: post, applied } = applyActions(pre, actions, this.docType);
    this.state = post;

    // Fire update listeners — one per applied DocAction.
    for (let i = 0; i < applied.length; i++) {
      const docAction = applied[i]!;
      const evt = appliedToEvent(docAction, actions);
      if (!evt) continue;
      for (const cb of this.updateListeners) {
        try {
          cb(evt);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[TextDocument] onUpdate handler threw:", err);
        }
      }
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

  /**
   * Apply a single Update. Wraps it in a synthetic Action and forwards to
   * applyActions.
   */
  applyUpdate(update: Update): void {
    const action: Action = {
      id: update.id,
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
   * queues the resulting Action for `client.write()`. The wire payload
   * carries the field updates produced by the local edit (new run +
   * any split halves + any tombstones).
   *
   * Default behavior: append at the end of the document (after the
   * last visible run). Pass `afterRun: <runId>` to insert at a
   * specific position, or `afterRun: 'ROOT'` to insert among the
   * root children.
   *
   * Returns the new run's id (or null if the local edit was rejected).
   */
  localInsert(text: string, opts: LocalInsertOptions = {}): string | null {
    const parentId = opts.afterRun ?? this.findLastVisibleRunId() ?? "ROOT";

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

    // Apply locally — optimistic. Capture pre/post for the field diff.
    const pre = this.state;
    let next = pre;
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
    next = docReducer(next, { type: "INSERT_RUN", node });
    this.state = next;

    // Build the wire-format Action from the pre/post diff.
    const fields = diffRunFields(pre, next, { updateId: `u_${runId}`, hlc: finalHlc });
    if (Object.keys(fields).length === 0) return null;
    const update = docActionToUpdate({ type: "INSERT_RUN", node }, fields, {
      docId: this.docId,
      updateId: `u_${runId}`,
      docSubjectType: this.docType,
    });
    if (!update) return null;

    const action: Action = {
      id: `a_${runId}`,
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);

    const evt: AppliedUpdate = {
      action,
      runId,
      kind: "insert",
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
   * Returns the resulting action id, or null if the local edit was
   * invalid (e.g., run not found, range out of bounds).
   */
  localDelete(opts: LocalDeleteOptions): string | null {
    const node = this.state.nodes.get(opts.runId);
    if (!node || node.deleted) return null;

    if (opts.offset < 0 || opts.count <= 0 || opts.offset + opts.count > node.text.length) {
      return null;
    }

    const { hlc, state: newHlcState } = advanceLocalHlc(this.localHlcState);
    this.localHlcState.l = newHlcState.l;
    this.localHlcState.c = newHlcState.c;
    const finalHlc = opts.hlc ?? hlc;

    const pre = this.state;
    const post = docReducer(pre, {
      type: "DELETE_RANGE",
      runId: opts.runId,
      offset: opts.offset,
      count: opts.count,
    });
    this.state = post;

    const fields = diffRunFieldsForDeleteRange(pre, post, {
      updateId: `u_del_${this.updateCounter++}`,
      hlc: finalHlc,
    });
    if (Object.keys(fields).length === 0) return null;
    const update = docActionToUpdate(
      { type: "DELETE_RANGE", runId: opts.runId, offset: opts.offset, count: opts.count },
      fields,
      {
        docId: this.docId,
        updateId: fields[Object.keys(fields)[0]!]!.update_id,
        docSubjectType: this.docType,
      },
    );
    if (!update) return null;

    const action: Action = {
      id: `a_del_${this.updateCounter++}`,
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);

    const evt: AppliedUpdate = {
      action,
      runId: opts.runId,
      kind: "tombstone",
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
    return [...this.pending];
  }

  /**
   * Remove actions from the pending queue. Called by callers after
   * `client.write()` rejects or accepts actions.
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an applied DocAction into the public AppliedUpdate event shape.
 * Returns null for SPLITs (internal, never exposed).
 *
 * For DELETE_RANGE, the event's `kind` is "tombstone" (the wire value is
 * `null`, but conceptually we surface it as a tombstone to listeners).
 */
const appliedToEvent = (
  docAction: import("./tree").DocAction,
  actions: readonly Action[],
): AppliedUpdate | null => {
  const action = actions.find((a) =>
    a.updates.some(
      (u) =>
        (u.subject_type === DEFAULT_DOC_SUBJECT_TYPE || u.subject_type === "text_document") &&
        u.data &&
        typeof u.data === "object" &&
        Object.keys(u.data as Record<string, unknown>).some((k) => k.startsWith("run:")),
    ),
  );
  if (!action) return null;
  switch (docAction.type) {
    case "INSERT_RUN":
      return { action, runId: docAction.node.id, kind: "insert" };
    case "EXTEND_RUN":
      return { action, runId: docAction.runId, kind: "extend" };
    case "DELETE_RANGE":
      return { action, runId: docAction.runId, kind: "tombstone" };
    case "SPLIT":
      return null;
  }
};

// ---------------------------------------------------------------------------
// Registry — one TextDocument per (client, docId)
// ---------------------------------------------------------------------------

/**
 * In-memory registry of TextDocuments. The `SyncClient.textDocument()`
 * accessor pulls from / populates this map.
 */
export class TextDocumentRegistry {
  private readonly docs = new Map<string, TextDocument>();

  /** Get or create a TextDocument for the given docId. */
  open(opts: { docId: string; actorId: string; docType?: string }): TextDocument {
    const existing = this.docs.get(opts.docId);
    if (
      existing &&
      existing.actorId === opts.actorId &&
      (opts.docType ?? DEFAULT_DOC_SUBJECT_TYPE) === existing.docType
    ) {
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
  diffRunFields,
  DEFAULT_DOC_SUBJECT_TYPE,
  RUN_FIELD_PREFIX,
  formatRunFieldName,
  parseRunFieldName,
};
export type { DocState, RunNode, RunFieldValue } from "./tree";
export type { Conflict } from "./conflict";

// Use the parsed-field helper to keep imports referenced for tree-shakers.
const _keepRefsAlive = parseRunFieldName;
const _keepRefsAlive2 = formatRunFieldName;
void _keepRefsAlive;
void _keepRefsAlive2;
