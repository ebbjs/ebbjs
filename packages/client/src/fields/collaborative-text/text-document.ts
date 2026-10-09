/**
 * TextDocument — user-facing facade for the causal-tree field type.
 *
 * Owns the document's `DocState` plus an outbound action queue for
 * locally-authored edits. Incoming Actions (from SSE / catch-up) flow
 * through `applyActions`; locally-authored edits flow through
 * `localInsert` / `localDelete` which both apply locally AND queue the
 * resulting Action for `client.write()`. When the client binds a write
 * path, a local edit also self-flushes.
 *
 * ## Wire format
 *
 * Each Update targets the document entity (subject_id = docId,
 * subject_type = docType, method: "patch") with run changes encoded in
 * the doc's `content` map field: `data.fields.content.map[<runId>] =
 * { value: <RunNode | null>, update_id, hlc }`. Runs are map keys on the
 * doc, not separate entities — this keeps the server's `<type>.<verb>`
 * permission model applicable to the doc as a whole and avoids the
 * cross-author rewrite problem that `run.update` would have if runs
 * were independent entities. Concurrent writes to different run keys
 * never conflict; a same-run race is one slot and surfaces through
 * `client.conflicts`.
 *
 * ## Usage
 *
 * ```ts
 * const doc = client.textDocument('doc_demo');
 *
 * doc.onUpdate((update) => { ... });
 *
 * // Local edit (optimistic — applied immediately, queued for write)
 * doc.localInsert('hello');
 *
 * doc.applyActions(remoteActions);
 * ```
 */

import {
  generateId,
  ID_PREFIX_ACTION,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import {
  applyRunFieldUpdates,
  createDocState,
  docReducer,
  reconstruct,
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
  parseContentField,
} from "./wire";
import { DOC_CONTENT_FIELD } from "./schema";

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
}

/** Local delete options. */
export interface LocalDeleteOptions {
  readonly runId: string;
  readonly offset: number;
  readonly count: number;
  readonly hlc?: HLCTimestamp;
}

/**
 * Local extend options. Extends an existing run by appending text to it
 * (no new run, no new HLC for the run itself — the existing run's text
 * is replaced atomically). The Action's HLC advances so peers can
 * order the extend relative to other operations, but the run's
 * identity is preserved.
 *
 * Run extension is what lets the cm-bridge avoid creating a new run on
 * every keystroke when typing at the end of your own last run.
 */
export interface LocalExtendOptions {
  readonly runId: string;
  readonly appendText: string;
  readonly hlc?: HLCTimestamp;
}

/** Update listener. */
export type UpdateListener = (update: AppliedUpdate) => void;

/**
 * Write path a document self-flushes through. Structurally the
 * client's `write`; typed narrowly so the document need not import the
 * client's response types.
 */
export type TextDocumentSubmit = (
  action: Action,
) => Promise<{ readonly rejected: readonly { readonly id: string }[] }>;

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
  private readonly updateListeners = new Set<UpdateListener>();
  /** Outbound queue: local edits waiting for `client.write()`. */
  private readonly pending: Action[] = [];
  /** Local HLC state for advancing on local edits. */
  private readonly localHlcState = { l: 0n, c: 0n };
  /** Counter for generating update IDs for local edits. */
  private updateCounter = 0;
  /**
   * Optional write path. When set (the client wires it), a local edit
   * self-flushes instead of waiting for a caller to submit
   * `pendingActions()` by hand. The pending queue is still the record,
   * so a rejected or unreachable submit leaves the edit retryable.
   */
  private submit: TextDocumentSubmit | null = null;

  /**
   * Bind the document to a write path. Idempotent; the client calls
   * this when opening a document so local edits self-flush.
   */
  setSubmit(submit: TextDocumentSubmit | null): void {
    this.submit = submit;
  }

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

  /** Current document text. */
  get text(): string {
    return reconstruct(this.state);
  }

  /**
   * Hydrate the document from a materialized `content` map field.
   *
   * The derived-body accessor resolves the document entity from the
   * relationship index and hands its map field here instead of replaying
   * Actions. Idempotent for the same or older state: a run whose stored
   * HLC is older than the local one is skipped, so a re-read after a
   * local optimistic edit cannot rewind it.
   */
  hydrate(content: FieldValue | undefined): void {
    const runs = parseContentField(content);
    if (runs.size === 0) return;
    this.state = applyRunFieldUpdates(this.state, runs).state;
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
   * wire-format adapter, applies them to the tree, and fires onUpdate
   * listeners.
   */
  applyActions(actions: readonly Action[]): void {
    if (actions.length === 0) return;
    const { state: post, applied, sourceActions } = applyActions(this.state, actions, this.docType);
    this.state = post;

    // Fire update listeners — one per applied DocAction. Each event is
    // paired with the source Action that produced it (threaded through
    // from applyActions; no scanning of the input batch required).
    for (let i = 0; i < applied.length; i++) {
      const docAction = applied[i]!;
      const sourceAction = sourceActions[i]!;
      const evt = appliedToEvent(docAction, sourceAction);
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
    const { hlc, state: newHlcState } = advanceLocalHlc(this.localHlcState);
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
      // Validate up front so the caller sees a rejection (null) instead of an
      // applySplit console.error followed by a mis-positioned insert.
      // applySplit requires offset in [1, text.length).
      const parentNode = next.nodes.get(parentId);
      const validOffset =
        !!parentNode && opts.splitParentAt >= 1 && opts.splitParentAt < parentNode.text.length;
      if (!validOffset) return null;
      next = docReducer(next, {
        type: "SPLIT",
        runId: parentId,
        offset: opts.splitParentAt,
      });
    }
    next = docReducer(next, { type: "INSERT_RUN", node });
    this.state = next;

    // Build the wire-format Action from the pre/post diff.
    const fields = diffRunFields(pre, next, { updateId: `u_${runId}`, hlc: finalHlc });
    if (Object.keys(fields).length === 0) return null;
    const update = docActionToUpdate(fields, {
      docId: this.docId,
      updateId: `u_${runId}`,
      docSubjectType: this.docType,
    });
    if (!update) return null;

    const action: Action = {
      // Globally unique, not derived from the run or a per-instance
      // counter. `action_id` is the server's dedup key, so a reload must
      // not regenerate an id a different edit already committed.
      id: generateId(ID_PREFIX_ACTION),
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);
    this.selfFlush(action);

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
    const update = docActionToUpdate(fields, {
      docId: this.docId,
      updateId: fields[Object.keys(fields)[0]!]!.update_id,
      docSubjectType: this.docType,
    });
    if (!update) return null;

    const action: Action = {
      id: generateId(ID_PREFIX_ACTION),
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);
    this.selfFlush(action);

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

  /**
   * Extend an existing run by appending text.
   *
   * Returns the resulting action id, or null if the local edit was
   * invalid (run not found, run is tombstoned, or appendText is empty).
   *
   * Local-only — applies optimistically to the tree immediately, then
   * queues the resulting Action for `client.write()`. The wire payload
   * carries a single field update for the run with the replaced text;
   * the receiver's wire adapter treats it as an EXTEND_RUN.
   */
  localExtend(opts: LocalExtendOptions): string | null {
    if (opts.appendText.length === 0) return null;

    const node = this.state.nodes.get(opts.runId);
    if (!node || node.deleted) return null;

    const { hlc, state: newHlcState } = advanceLocalHlc(this.localHlcState);
    this.localHlcState.l = newHlcState.l;
    this.localHlcState.c = newHlcState.c;
    const finalHlc = opts.hlc ?? hlc;

    const pre = this.state;
    const post = docReducer(pre, {
      type: "EXTEND_RUN",
      runId: opts.runId,
      appendText: opts.appendText,
      hlc: finalHlc,
    });
    this.state = post;

    // diffRunFields emits a field update when the run's text changes.
    // For an extend, only the extended run's field appears in the diff.
    const fields = diffRunFields(pre, post, {
      updateId: `u_ext_${this.updateCounter++}`,
      hlc: finalHlc,
    });
    if (Object.keys(fields).length === 0) return null;
    const update = docActionToUpdate(fields, {
      docId: this.docId,
      updateId: fields[Object.keys(fields)[0]!]!.update_id,
      docSubjectType: this.docType,
    });
    if (!update) return null;

    const action: Action = {
      id: generateId(ID_PREFIX_ACTION),
      actor_id: this.actorId,
      hlc: finalHlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);
    this.selfFlush(action);

    const evt: AppliedUpdate = {
      action,
      runId: opts.runId,
      kind: "extend",
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
   * Submit a locally-authored Action when a write path is bound. The
   * Action stays in `pending` until the server accepts it; a rejection
   * or a throw leaves it for the caller's `ackPending` / retry path.
   */
  private selfFlush(action: Action): void {
    if (this.submit === null) return;
    void this.submit(action)
      .then((response) => {
        if (response.rejected.length === 0) this.ackPending([action.id]);
      })
      .catch(() => {
        // Leave the edit pending; the caller's retry path owns it.
      });
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

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /** Reset state to empty (for tests / reload). */
  reset(): void {
    this.state = createDocState();
    this.pending.length = 0;
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
 * The source Action is passed in directly (paired by `applyActions`) so
 * we don't have to scan the input batch to find it.
 *
 * Returns null for SPLITs (internal, never exposed).
 *
 * For DELETE_RANGE, the event's `kind` is "tombstone" (the wire value is
 * `null`, but conceptually we surface it as a tombstone to listeners).
 */
const appliedToEvent = (
  docAction: import("./tree").DocAction,
  action: Action,
): AppliedUpdate | null => {
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
  DOC_CONTENT_FIELD,
};
export type { DocState, RunNode, RunFieldValue } from "./tree";
