/**
 * TextDocument — the user-facing facade for the collaborative-text field type.
 *
 * Holds the document's merged `content` field and the projection derived from
 * it. Local edits create new cells, merge them optimistically, and queue one
 * Action for `client.write()` (or self-flush when the client binds a write
 * path). Incoming Actions are delivery: their cells merge into the same map
 * and the projection is recomputed. There is one read path —
 * `project(mergedCells)` — and no state-carrying action reducer.
 *
 * ## Wire format
 *
 * Each Update targets the document entity (subject_id = docId,
 * subject_type = docType, method: "patch") and carries two fields:
 *
 * - `content`: a map keyed by cell id, each `{ value: RunCell | CutCell,
 *   update_id, hlc }`;
 * - `version`: the cell-format leaf, written by every edit.
 *
 * Runs are immutable and cuts are additive, so a write only ever adds map
 * keys. The map's per-key merge therefore never drops a peer's edit, and a
 * same-run race is no longer a conflict position.
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
  applyCellFields,
  createDocState,
  makeCutId,
  makeRunId,
  ROOT_ID,
  type CellFieldValue,
  type CutCell,
  type DocState,
  type RunCell,
  type TextCell,
} from "./tree";
import {
  applyActions,
  assertAppendOnly,
  assertKnownVersion,
  docActionToUpdate,
  DEFAULT_DOC_SUBJECT_TYPE,
  parseContentField,
} from "./wire";
import { DOC_CONTENT_FIELD } from "./schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cell as it was delivered or authored, paired with its Action. */
export type AppliedUpdate = {
  readonly action: Action;
  readonly cellId: string;
  /** A run is an insertion; a cut is a retraction. */
  readonly kind: "insert" | "cut";
};

/** Local insert options. */
export interface LocalInsertOptions {
  /** Run id to insert into. Defaults to the last visible run (or ROOT). */
  readonly afterRun?: string;
  /** Character offset within the parent run. Defaults to the run's end. */
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
 * Local extend options: append after the end of an existing run.
 *
 * An extend is an insert, not a rewrite. It creates a new run anchored at
 * `(runId, run.text.length)`, so the original run's text never changes.
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

/** A local HLC state: logical time and counter. */
type LocalHlcState = { readonly l: bigint; readonly c: bigint };

/**
 * Advance a local HLC state for a local event. If `now > state.l`, set
 * l=now, c=0. Otherwise bump c.
 */
const advanceLocalHlc = (
  state: LocalHlcState,
  now: bigint = BigInt(Date.now()),
): { readonly hlc: HLCTimestamp; readonly state: LocalHlcState } => {
  const next = now > state.l ? { l: now, c: 0n } : { l: state.l, c: state.c + 1n };
  const packed = (next.l << 16n) | (next.c & 0xffffn);
  return { hlc: packed.toString() as HLCTimestamp, state: next };
};

// ---------------------------------------------------------------------------
// TextDocument
// ---------------------------------------------------------------------------

export class TextDocument {
  /** Document id (the entity id hosting the cells). */
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
  private localHlcState: LocalHlcState = { l: 0n, c: 0n };
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

  /** The projected document. Read-only. */
  get docState(): DocState {
    return this.state;
  }

  /** The projected document text. */
  get text(): string {
    return this.state.text;
  }

  /** Sentinel id of the root — convenience for "insert at start". */
  get rootRunId(): string {
    return ROOT_ID;
  }

  /**
   * Merge a materialized `content` map field into the document and
   * re-project.
   *
   * A repeat read of the same content version is a no-op. A stale read never
   * rewinds the document: the map merge keeps every key the local state
   * already has. `version` is the body's declared cell format; an unknown
   * value fails the read rather than projecting a wrong view.
   */
  hydrate(content: FieldValue | undefined, version?: FieldValue): void {
    assertKnownVersion(version);
    if (content === undefined) return;
    this.state = applyCellFields(this.state, parseContentField(content));
  }

  /** The id of the last visible run in document order, or null. */
  private findLastVisibleRunId(): string | null {
    const spans = this.state.index.spans;
    if (spans.length === 0) return null;
    return spans[spans.length - 1]!.runId;
  }

  // -------------------------------------------------------------------------
  // Apply external Actions (from sync / catch-up / SSE)
  // -------------------------------------------------------------------------

  /**
   * Deliver a list of Actions: merge their cells, re-project once, and fire
   * `onUpdate` for each cell that was not already present.
   */
  applyActions(actions: readonly Action[]): void {
    if (actions.length === 0) return;

    const { state, applied, sourceActions } = applyActions(this.state, actions, this.docType);
    if (state === this.state) return;
    this.state = state;

    for (let i = 0; i < applied.length; i += 1) {
      const cell = applied[i]!;
      const action = sourceActions[i]!;
      this.emit({
        action,
        cellId: cell.cellId,
        kind: cell.cell.kind === "run" ? "insert" : "cut",
      });
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
   * Insert text as a new run anchored at `(afterRun, splitParentAt)`.
   *
   * Defaults to appending after the last visible run. Nothing is split or
   * rewritten: the target run keeps its text and id forever, and the new run
   * is placed at the given character offset.
   *
   * Returns the new run's id, or null if the edit was invalid.
   */
  localInsert(text: string, opts: LocalInsertOptions = {}): string | null {
    if (text.length === 0) return null;

    const parentId = opts.afterRun ?? this.findLastVisibleRunId() ?? ROOT_ID;
    const parent = parentId === ROOT_ID ? undefined : this.state.runs.get(parentId);
    if (parentId !== ROOT_ID && parent === undefined) return null;

    const parentLength = parent?.text.length ?? 0;
    const offset = opts.splitParentAt ?? parentLength;
    if (offset < 0 || offset > parentLength) return null;

    const finalHlc = opts.hlc ?? this.advanceHlc();
    const cell: RunCell = {
      kind: "run",
      id: makeRunId(finalHlc, this.actorId, generateId("run")),
      text,
      author: this.actorId,
      stamp: finalHlc,
      anchor: { runId: parentId, offset },
    };

    return this.commit([cell]) === null ? null : cell.id;
  }

  /**
   * Delete a range within a run by adding one cut cell.
   *
   * Returns the resulting action id, or null if the edit was invalid.
   */
  localDelete(opts: LocalDeleteOptions): string | null {
    const run = this.state.runs.get(opts.runId);
    if (run === undefined) return null;

    if (opts.offset < 0 || opts.count <= 0 || opts.offset + opts.count > run.text.length) {
      return null;
    }

    const finalHlc = opts.hlc ?? this.advanceHlc();
    const cell: CutCell = {
      kind: "cut",
      id: makeCutId(finalHlc, this.actorId, opts.runId, opts.offset, opts.offset + opts.count),
      runId: opts.runId,
      from: opts.offset,
      to: opts.offset + opts.count,
      author: this.actorId,
      stamp: finalHlc,
    };

    const action = this.commit([cell]);
    return action === null ? null : action.id;
  }

  /**
   * Append text after the end of an existing run by adding a new run
   * anchored at its end. The original run is never rewritten.
   *
   * Returns the resulting action id, or null if the edit was invalid.
   */
  localExtend(opts: LocalExtendOptions): string | null {
    if (opts.appendText.length === 0) return null;

    const parent = this.state.runs.get(opts.runId);
    if (parent === undefined) return null;

    const finalHlc = opts.hlc ?? this.advanceHlc();
    const cell: RunCell = {
      kind: "run",
      id: makeRunId(finalHlc, this.actorId, generateId("run")),
      text: opts.appendText,
      author: this.actorId,
      stamp: finalHlc,
      anchor: { runId: parent.id, offset: parent.text.length },
    };

    const action = this.commit([cell]);
    return action === null ? null : action.id;
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  private advanceHlc(): HLCTimestamp {
    const { hlc, state } = advanceLocalHlc(this.localHlcState);
    this.localHlcState = state;
    return hlc;
  }

  /**
   * Apply one batch of new cells: refuse a rewrite, merge optimistically,
   * then queue and self-flush the Action.
   */
  private commit(cells: readonly TextCell[]): Action | null {
    if (cells.length === 0) return null;

    // The write path's discipline is checked before anything is queued.
    assertAppendOnly(
      cells.map((cell) => cell.id),
      this.state.cells.keys(),
    );

    const hlc = cells[0]!.stamp;
    const updateId = `u_${cells[0]!.id}`;
    const update = docActionToUpdate(cells, {
      docId: this.docId,
      updateId,
      docSubjectType: this.docType,
    });
    if (update === null) return null;

    const batch = new Map<string, CellFieldValue>(
      cells.map((cell) => [cell.id, { value: cell, update_id: updateId, hlc: cell.stamp }]),
    );
    this.state = applyCellFields(this.state, batch);

    const action: Action = {
      // Globally unique, not derived from the run or a per-instance
      // counter. `action_id` is the server's dedup key, so a reload must
      // not regenerate an id a different edit already committed.
      id: generateId(ID_PREFIX_ACTION),
      actor_id: this.actorId,
      hlc,
      gsn: 0,
      updates: [update],
    };
    this.pending.push(action);
    this.selfFlush(action);

    for (const cell of cells) {
      this.emit({ action, cellId: cell.id, kind: cell.kind === "run" ? "insert" : "cut" });
    }
    return action;
  }

  private emit(update: AppliedUpdate): void {
    for (const cb of this.updateListeners) {
      try {
        cb(update);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[TextDocument] onUpdate handler threw:", err);
      }
    }
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
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (idSet.has(this.pending[i]!.id)) this.pending.splice(i, 1);
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

  /** Reset state to empty (for tests / reload). The clock stays monotonic. */
  reset(): void {
    this.state = createDocState();
    this.pending.length = 0;
  }
}

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

export { applyActions, docActionToUpdate, DEFAULT_DOC_SUBJECT_TYPE, DOC_CONTENT_FIELD };
export type { DocState, RunCell, CutCell, TextCell, CellFieldValue } from "./tree";
