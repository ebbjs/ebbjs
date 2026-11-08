/**
 * CodeMirror 6 bridge for `@ebbjs/client`'s TextDocument.
 *
 * Two-way sync between a CM6 EditorView and a TextDocument. The document is
 * a set of immutable runs plus additive cuts; a run is never split or
 * rewritten, only re-anchored around. The document's projection
 * (`doc.docState.index.spans`) is therefore one `{ runId, offset, length }`
 * span per *visible fragment*, and one run can yield several spans whenever
 * another run is anchored inside it.
 *
 * 1. Local CM edits (annotation: NOT `isRemote`) → translated to
 *    `doc.localInsert` / `doc.localExtend` / `doc.localDelete` calls.
 *    - Deletions walk the affected visible fragments and dispatch one
 *      `localDelete` per contiguous same-run segment.
 *    - Insertions look up the run owning the character before the cursor.
 *      Typing right after the end of the peer's own leaf run appends with
 *      `localExtend`; anything else anchors a new run at a run-text offset.
 *
 * 2. Remote `doc.onUpdate` events (catch-up / SSE) → applied to CM by
 *    diffing CM's text against `doc.text`. The document owns the layout,
 *    so re-deriving one incremental CM change per event would have to
 *    re-implement the whole projection; diffing one replacement range keeps
 *    CM equal to `doc.text` for every event kind (insert, cut, or several
 *    cells in one batch).
 *
 * A CM `StateField` (`idMapField`) mirrors `doc.docState.index.spans`,
 * letting consumers map CM positions to run ids (for presence, cursor
 * anchoring, etc). The field is pushed on every doc update — including the
 * ones raised by a local edit, where CM already holds the new text.
 *
 * Both directions use the `isRemote` annotation to avoid recursive loops: a
 * CM dispatch made by the bridge is marked remote, and the bridge's local
 * listener skips remote transactions.
 */

import { Annotation, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ROOT_ID, type RunSpan, type TextDocument } from "@ebbjs/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Re-export RunSpan so consumers of @ebbjs/codemirror
// don't need to import it separately from @ebbjs/client.
export type { RunSpan };

export { ROOT_ID };

// ---------------------------------------------------------------------------
// Annotations & effects
// ---------------------------------------------------------------------------

/**
 * Marks a CM transaction as originating from the bridge (i.e., a
 * remote doc update being pushed into CM, not a user keystroke).
 * The local-CM→doc listener skips transactions with this annotation
 * to avoid recursive loops.
 */
export const isRemote = Annotation.define<boolean>();

/** Replace the spans StateField's value with a fresh array. */
export const setIdMapEffect = StateEffect.define<readonly RunSpan[]>();

// ---------------------------------------------------------------------------
// StateField — mirrors doc.docState.index.spans
// ---------------------------------------------------------------------------

/**
 * Zero-length span at the document root. The CM-side `idMapField`
 * always carries this so empty-doc clicks resolve to `(ROOT_ID, 0)`
 * for presence anchoring. The doc's `PositionIndex.spans` never
 * contains this — it lives only in the CM mirror.
 */
export const ROOT_PLACEHOLDER_SPAN: RunSpan = { runId: ROOT_ID, offset: 0, length: 0 };

/** Ensure the spans array carries the ROOT placeholder so the CM mirror never goes empty. */
export const ensureRootSpan = (spans: readonly RunSpan[]): readonly RunSpan[] =>
  spans.length === 0 ? [ROOT_PLACEHOLDER_SPAN] : spans;

/**
 * CM StateField mirroring `doc.docState.index.spans`. Always carries
 * at least the ROOT placeholder so empty-doc clicks resolve to
 * `(ROOT_ID, 0)`.
 */
export const createIdMapField = (): StateField<readonly RunSpan[]> =>
  StateField.define<readonly RunSpan[]>({
    create: () => [ROOT_PLACEHOLDER_SPAN],
    update: (value, tr) => {
      for (const effect of tr.effects) {
        if (effect.is(setIdMapEffect)) {
          return ensureRootSpan(effect.value);
        }
      }
      return value;
    },
  });

// ---------------------------------------------------------------------------
// Position ↔ run helpers
// ---------------------------------------------------------------------------

/**
 * Find the visible fragment containing a document position.
 *
 * `runOffset` is the offset within the run's own text: a run interrupted by
 * an insert yields two spans with the same `runId` and different offsets, so
 * the span's `offset` is the base and the position contributes only the
 * distance into this fragment.
 */
export function lookupPositionFromSpans(
  spans: readonly RunSpan[],
  position: number,
): SpanLookup | undefined {
  let cumulative = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    if (position < cumulative + span.length) {
      return {
        runId: span.runId,
        runOffset: span.offset + (position - cumulative),
        spanIndex: i,
        spanLength: span.length,
      };
    }
    cumulative += span.length;
  }
  return undefined;
}

/**
 * Find the run that contains a given document position, using the
 * StateField. Returns `{ runId, offset, spanIndex }` or undefined.
 *
 * CodeMirror positions are in `[0, doc.length]` inclusive, so a position
 * equal to the total span length resolves to the end of the last span.
 */
export const getRunAtPosition = (
  state: { field: <T>(f: StateField<T>) => T },
  position: number,
  idMapField: StateField<readonly RunSpan[]>,
): { runId: string; offset: number; spanIndex: number } | undefined => {
  const spans = state.field(idMapField);
  const lookup = lookupPositionFromSpans(spans, position);
  if (lookup !== undefined) {
    return { runId: lookup.runId, offset: lookup.runOffset, spanIndex: lookup.spanIndex };
  }

  const lastIndex = spans.length - 1;
  const last = spans[lastIndex];
  if (last === undefined) return undefined;
  const total = spans.reduce((sum, span) => sum + span.length, 0);
  if (position !== total) return undefined;
  return { runId: last.runId, offset: last.offset + last.length, spanIndex: lastIndex };
};

/**
 * Compute the document position of a given `(runId, offsetWithinRun)`.
 * Returns undefined if no visible fragment of the run covers the offset.
 *
 * `offset` is a run-text offset, and a fragment covers
 * `[span.offset, span.offset + span.length]` — the inclusive end is the
 * cursor position immediately past the fragment's last character. When two
 * fragments of the same run share a boundary, the earlier fragment wins:
 * the position before anything anchored at that offset.
 */
export const getPositionOfRun = (
  state: { field: <T>(f: StateField<T>) => T },
  runId: string,
  offset: number,
  idMapField: StateField<readonly RunSpan[]>,
): number | undefined => {
  const spans = state.field(idMapField);
  let cumulative = 0;
  for (const span of spans) {
    if (span.runId === runId && offset >= span.offset && offset <= span.offset + span.length) {
      return cumulative + (offset - span.offset);
    }
    cumulative += span.length;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Bridge extension — local CM edits → doc
// ---------------------------------------------------------------------------

/**
 * Shared mutable state between the bridge extension (which sets the
 * flag during a local edit) and `mountEditorBridge` (which reads it
 * to skip re-applying text CM already has).
 *
 * Lives in a plain object so the reference is stable across the
 * two closures — both `createBridgeExtension` and `mountEditorBridge`
 * receive the same object.
 */
export interface LocalEditTracker {
  /** Set to true while inside a local-CM→doc transaction. */
  active: boolean;
}

/** Options for {@link createBridgeExtension}. */
export interface BridgeExtensionConfig {
  readonly doc: TextDocument;
  readonly idMapField: StateField<readonly RunSpan[]>;
  /**
   * Returns the current EditorView. The bridge captures this lazily
   * via a closure so the caller can set the view after constructing
   * the EditorState.
   */
  readonly getView: () => EditorView | null;
  /**
   * Shared tracker that the bridge flips on/off around local-CM→doc
   * dispatches. `mountEditorBridge` reads it to skip the text diff for
   * events raised during a local edit. Optional — if omitted, the bridge
   * assumes all doc updates are remote.
   */
  readonly localEdit?: LocalEditTracker;
}

/**
 * Create the CM6 Extension that pipes local edits to the document.
 *
 * The extension bundles `idMapField` plus an `updateListener` that
 * intercepts non-remote transactions and dispatches the corresponding
 * `doc.local*` calls. Remote transactions are skipped.
 */
export const createBridgeExtension = (config: BridgeExtensionConfig): Extension => {
  const { doc, idMapField, localEdit } = config;
  return [
    idMapField,
    EditorView.updateListener.of((update) => {
      const view = config.getView();
      if (!view) return;

      // Only react to local edits with doc changes.
      if (!update.docChanged) return;
      const localTr = update.transactions.find((tr) => tr.docChanged && !tr.annotation(isRemote));
      if (!localTr) return;

      // The pre-transaction mirror: `fromA` / `toA` are positions in the
      // document the change was computed against, and the spans the bridge
      // pushes mid-listener describe that same document.
      const spans = localTr.startState.field(idMapField);

      if (localEdit) localEdit.active = true;
      try {
        localTr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          applyLocalChange(doc, spans, fromA, toA, inserted.toString());
        });
      } finally {
        if (localEdit) localEdit.active = false;
      }
    }),
  ];
};

// ---------------------------------------------------------------------------
// doc.onUpdate → CM dispatch
// ---------------------------------------------------------------------------

/** A handle returned by {@link mountEditorBridge} for tearing down. */
export interface EditorBridge {
  /** Stop listening to doc updates. */
  detach: () => void;
}

/**
 * Wire the document's `onUpdate` stream to the given CM view. After
 * calling this, remote updates (catch-up / SSE) flowing through the
 * TextDocument will be applied to the editor.
 *
 * The CM view must already have been created with
 * {@link createBridgeExtension} in its extensions list.
 *
 * If `doc.text` differs from the view's current text (e.g., the
 * document was populated before the bridge was attached, via catch-up),
 * the initial state is synced via a remote-annotated dispatch.
 */
export function mountEditorBridge(
  view: EditorView,
  doc: TextDocument,
  idMapField: StateField<readonly RunSpan[]>,
  localEdit?: LocalEditTracker,
): EditorBridge {
  const currentText = view.state.doc.toString();
  const replacement = diffDocument(currentText, doc.text);
  const effect = {
    effects: setIdMapEffect.of(ensureRootSpan(doc.docState.index.spans)),
    annotations: isRemote.of(true),
  };
  view.dispatch(replacement === undefined ? effect : { ...effect, changes: replacement });

  const unsubscribeDoc = doc.onUpdate(() => {
    applyDocUpdateToCM(view, doc, idMapField, localEdit);
  });

  return {
    detach: () => {
      unsubscribeDoc();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: local change translation
// ---------------------------------------------------------------------------

/** Translate one CM change into the document's cell operations. */
function applyLocalChange(
  doc: TextDocument,
  spans: readonly RunSpan[],
  fromA: number,
  toA: number,
  insertedText: string,
): void {
  // ----- Deletions first ---------------------------------------------
  let pos = fromA;
  while (pos < toA) {
    const lookup = lookupPositionFromSpans(spans, pos);
    if (lookup === undefined) {
      // Position falls in a gap (there shouldn't be one if spans mirror
      // doc.text); advance by one to avoid an infinite loop.
      pos += 1;
      continue;
    }
    const span = spans[lookup.spanIndex]!;
    const remainingInSpan = span.offset + span.length - lookup.runOffset;
    const count = Math.min(remainingInSpan, toA - pos);
    doc.localDelete({ runId: lookup.runId, offset: lookup.runOffset, count });
    pos += count;
  }

  // ----- Insertions ---------------------------------------------------
  if (insertedText.length === 0) return;

  if (fromA === 0) {
    // Inserting at position 0 — parent is ROOT. Never an extension
    // (there's no preceding character owned by us).
    doc.localInsert(insertedText, { afterRun: ROOT_ID });
    return;
  }

  // The run owning the character just before `fromA`.
  const parentLookup = lookupPositionFromSpans(spans, fromA - 1);
  const parent = parentLookup ? doc.docState.runs.get(parentLookup.runId) : undefined;
  if (parentLookup === undefined || parent === undefined) {
    // Shouldn't happen, but fall back to inserting at ROOT.
    doc.localInsert(insertedText, { afterRun: ROOT_ID });
    return;
  }

  const isAtEndOfRun = parentLookup.runOffset === parent.text.length - 1;
  const isOwnRun = parent.author === doc.actorId;
  const isLeaf = !hasAnchoredChild(doc, parent.id);

  // Typing right after the end of our own leaf run appends to it
  // (`localExtend` is an insert anchored at the run's end, so the run
  // keeps its text and id either way).
  if (isAtEndOfRun && isOwnRun && isLeaf) {
    doc.localExtend({ runId: parent.id, appendText: insertedText });
    return;
  }

  // Any other insert anchors a new run after the parent character. At the
  // run's end this is the same anchor an extend would use.
  doc.localInsert(insertedText, {
    afterRun: parent.id,
    splitParentAt: parentLookup.runOffset + 1,
  });
}

/** Does any run in the document anchor itself inside `runId`? */
const hasAnchoredChild = (doc: TextDocument, runId: string): boolean => {
  for (const run of doc.docState.runs.values()) {
    if (run.anchor.runId === runId) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Internal: remote doc updates → CM
// ---------------------------------------------------------------------------

/**
 * Push the document's current text and spans into CM.
 *
 * The document's projection is the only layout authority, so CM is brought
 * in line by diffing rather than by re-deriving an incremental change from
 * the event's run. That keeps CM exactly `doc.text` for inserts, cuts, and
 * batches, including multi-span runs.
 *
 * During a local CM edit, CM already holds the new text from the user's
 * input: skip the text diff but still push the new spans.
 */
function applyDocUpdateToCM(
  view: EditorView,
  doc: TextDocument,
  idMapField: StateField<readonly RunSpan[]>,
  localEdit: LocalEditTracker | undefined,
): void {
  const isLocal = localEdit?.active ?? false;
  const replacement = isLocal ? undefined : diffDocument(view.state.doc.toString(), doc.text);
  const nextSpans = ensureRootSpan(doc.docState.index.spans);

  // Several events in one batch can leave both the text and the spans
  // unchanged (e.g. a cell that projects to nothing); skip the dispatch.
  if (replacement === undefined && sameSpans(view.state.field(idMapField), nextSpans)) return;

  const effect = {
    effects: setIdMapEffect.of(nextSpans),
    annotations: isRemote.of(true),
  };
  view.dispatch(replacement === undefined ? effect : { ...effect, changes: replacement });
}

/** Structural equality of two span arrays. */
const sameSpans = (a: readonly RunSpan[], b: readonly RunSpan[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.runId !== right.runId ||
      left.offset !== right.offset ||
      left.length !== right.length
    ) {
      return false;
    }
  }
  return true;
};

/**
 * One replacement range turning `current` into `target`: the longest common
 * prefix and suffix are kept, everything between them is replaced.
 */
const diffDocument = (
  current: string,
  target: string,
): { from: number; to: number; insert: string } | undefined => {
  if (current === target) return undefined;

  const shortest = Math.min(current.length, target.length);
  let prefix = 0;
  while (prefix < shortest && current.charCodeAt(prefix) === target.charCodeAt(prefix)) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      target.charCodeAt(target.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: current.length - suffix,
    insert: target.slice(prefix, target.length - suffix),
  };
};

/** Span returned by `lookupPositionFromSpans` (without a StateField indirection). */
export type SpanLookup = {
  readonly runId: string;
  /** Offset within the run's own text. */
  readonly runOffset: number;
  readonly spanIndex: number;
  readonly spanLength: number;
};
