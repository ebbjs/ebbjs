/**
 * CodeMirror 6 bridge for `@ebbjs/client`'s TextDocument.
 *
 * Two-way sync between a CM6 EditorView and a TextDocument:
 *
 * 1. Local CM edits (annotation: NOT `isRemote`) → translated to
 *    `doc.localInsert` / `doc.localExtend` / `doc.localDelete` calls.
 *    - Insertions immediately after the end of the local peer's last
 *      own run use `localExtend` (no new run, no new run id).
 *    - Mid-run insertions use `localInsert` with `splitParentAt`; the
 *      TextDocument handles the split atomically.
 *    - Deletions walk the affected runs and dispatch one
 *      `localDelete` per contiguous same-run segment.
 *
 * 2. Remote `doc.onUpdate` events (catch-up / SSE) → applied to CM.
 *    - 'insert' kind: find the run's parent in the previous spans,
 *      insert the run's text after the parent's end.
 *    - 'extend' kind: replace the run's previous span with the new text.
 *    - 'tombstone' kind: delete the run's previous span.
 *    - Tombstoned placeholder runs (created to satisfy a missing
 *      parent reference on receive) are skipped — they have no visible
 *      text in CM.
 *
 * A CM `StateField` (`idMapField`) mirrors `doc.docState.index.spans`,
 * letting consumers map CM positions to run ids (for presence,
 * cursor anchoring, etc). The field is updated in the same dispatch
 * that applies remote changes — the local listener doesn't need to
 * update it because CM is the source of truth during local edits.
 *
 * Both directions use the `isRemote` annotation to avoid recursive
 * loops: a CM dispatch made by the bridge is marked remote, and the
 * bridge's updateListener skips remote transactions.
 */

import { Annotation, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ROOT_ID, type AppliedUpdate, type RunSpan, type TextDocument } from "@ebbjs/client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Re-export RunSpan so consumers of @ebbjs/codemirror
// don't need to import it separately from @ebbjs/client.
export type { RunSpan };

// Re-export ROOT_ID so consumers can reference the placeholder run
// without pulling from @ebbjs/client.
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
 * A zero-length placeholder span at the document root. Always present
 * in the StateField so empty-doc clicks can resolve to `(ROOT_ID, 0)`
 * for presence anchoring (see #101). The doc tree's `PositionIndex.spans`
 * never contains this — it lives only in the CM-side mirror.
 */
export const ROOT_PLACEHOLDER_SPAN: RunSpan = { runId: ROOT_ID, length: 0 };

/**
 * Ensure the spans array carries the ROOT placeholder. The doc tree
 * uses an empty spans array as the "no runs yet" signal; the CM mirror
 * needs at least the placeholder so cursor anchoring always has a run
 * to land on. Call this at every boundary that dispatches
 * `setIdMapEffect` so the invariant survives the empty→first-run and
 * any-run→empty (remote tombstone of all visible runs) transitions.
 */
export const ensureRootSpan = (spans: readonly RunSpan[]): readonly RunSpan[] =>
  spans.length === 0 ? [ROOT_PLACEHOLDER_SPAN] : spans;

/**
 * The CM StateField holding the current spans. Exposed so consumers
 * (presence, cursor anchoring, etc.) can read it via
 * `view.state.field(idMapField)`.
 *
 * Invariant: the field's value always contains at least the ROOT
 * placeholder. Even when the underlying doc is empty (zero runs),
 * consumers can resolve any CM position to a (runId, offset) pair —
 * which is what makes empty-doc presence clicks work (#101).
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
 * Find the run that contains a given document position, using the
 * StateField. Returns `{ runId, offset, spanIndex }` or undefined.
 *
 * CodeMirror positions are in `[0, doc.length]` inclusive, so a
 * position equal to the sum of all spans' lengths is still inside
 * the last run.
 */
export const getRunAtPosition = (
  state: { field: <T>(f: StateField<T>) => T },
  position: number,
  idMapField: StateField<readonly RunSpan[]>,
): { runId: string; offset: number; spanIndex: number } | undefined => {
  const spans = state.field(idMapField);
  let cumulative = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (position <= cumulative + span.length) {
      return { runId: span.runId, offset: position - cumulative, spanIndex: i };
    }
    cumulative += span.length;
  }
  return undefined;
};

/**
 * Compute the document position of a given (runId, offsetWithinRun).
 * Returns undefined if the run is not visible in the current spans.
 *
 * `offset` may equal `span.length` — that's the position immediately
 * past the last character of the run, a legitimate cursor position.
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
    if (span.runId === runId) {
      if (offset > span.length) return undefined;
      return cumulative + offset;
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
 * to skip applying cmChanges for events raised during a local edit).
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
   * dispatches. `mountEditorBridge` reads it to skip applying
   * cmChanges for events raised during a local edit. Optional — if
   * omitted, the bridge assumes all doc updates are remote.
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
  return [
    config.idMapField,
    EditorView.updateListener.of((update) => {
      const view = config.getView();
      if (!view) return;

      // Only react to local edits with doc changes.
      if (!update.docChanged) return;
      const localTr = update.transactions.find((tr) => tr.docChanged && !tr.annotation(isRemote));
      if (!localTr) return;

      const { idMapField, doc, localEdit } = config;
      const spans = view.state.field(idMapField);

      if (localEdit) localEdit.active = true;
      try {
        localTr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          // ----- Deletions first ----------------------------------------
          if (toA > fromA) {
            let pos = fromA;
            while (pos < toA) {
              const lookup = lookupPositionFromSpans(spans, pos);
              if (!lookup) {
                // Position falls in a gap (shouldn't happen if spans
                // mirror doc.text); advance by one to avoid an infinite
                // loop.
                pos += 1;
                continue;
              }
              const remainingInRun = lookup.spanLength - lookup.runOffset;
              const remainingInDel = toA - pos;
              const count = Math.min(remainingInRun, remainingInDel);

              doc.localDelete({
                runId: lookup.runId,
                offset: lookup.runOffset,
                count,
              });

              pos += count;
            }
          }

          // ----- Insertions ---------------------------------------------
          const insertedText = inserted.toString();
          if (insertedText.length === 0) return;

          if (fromA === 0) {
            // Inserting at position 0 — parent is ROOT. Never an
            // extension (there's no preceding character owned by us).
            doc.localInsert(insertedText, { afterRun: "ROOT" });
            return;
          }

          // Look up the run containing the character just before `fromA`.
          const parentLookup = lookupPositionFromSpans(spans, fromA - 1);
          if (!parentLookup) {
            // Shouldn't happen, but fall back to inserting at ROOT.
            doc.localInsert(insertedText, { afterRun: "ROOT" });
            return;
          }

          const parentRun = doc.docState.nodes.get(parentLookup.runId);
          if (!parentRun || parentRun.deleted) {
            // Parent missing or tombstoned — insert at ROOT.
            doc.localInsert(insertedText, { afterRun: "ROOT" });
            return;
          }

          const isAtEndOfRun = parentLookup.runOffset === parentRun.text.length - 1;
          const isSamePeer = parentRun.actorId === doc.actorId;
          const isNotDeleted = !parentRun.deleted;
          const childrenOfParent = doc.docState.children.get(parentRun.id) ?? [];
          const isLeaf = childrenOfParent.length === 0;

          // Extension optimization: typing right after the end of our
          // own leaf run. Avoids creating a new run per keystroke.
          if (isAtEndOfRun && isSamePeer && isNotDeleted && isLeaf) {
            doc.localExtend({
              runId: parentRun.id,
              appendText: insertedText,
            });
            return;
          }

          // New run path. Compute split offset if mid-run.
          let splitParentAt: number | undefined;
          if (!isAtEndOfRun) {
            // Mid-run: split at runOffset + 1 (after the parent char).
            splitParentAt = parentLookup.runOffset + 1;
          }

          doc.localInsert(insertedText, {
            afterRun: parentRun.id,
            ...(splitParentAt !== undefined && { splitParentAt }),
          });
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
  // Initial sync: replace CM's doc text with the document's current
  // text (if they differ) and seed the spans StateField. The seeded
  // spans always carry the ROOT placeholder when the doc has no real
  // runs, so empty-doc cursor clicks resolve to (ROOT_ID, 0) (#101).
  const initialText = doc.text;
  const initialSpans = ensureRootSpan(spansToRunSpans(doc.docState.index.spans));
  if (view.state.doc.toString() !== initialText) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialText },
      effects: setIdMapEffect.of(initialSpans),
      annotations: isRemote.of(true),
    });
  } else {
    view.dispatch({
      effects: setIdMapEffect.of(initialSpans),
      annotations: isRemote.of(true),
    });
  }

  // Wire doc updates to CM. The localEdit tracker is set by the
  // bridge extension during a local-CM→doc dispatch; reading it
  // here lets us skip applying cmChanges for events raised during
  // a local edit (CM already has the new text in that case, and
  // re-applying would double the characters and push mid-run
  // inserts to the wrong side of the parent because the spans
  // StateField hasn't caught up yet).
  const unsubscribeDoc = doc.onUpdate((evt) => {
    if (!evt) return; // type guard
    applyDocUpdateToCM(view, doc, idMapField, evt, localEdit);
  });

  return {
    detach: () => {
      unsubscribeDoc();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: apply a single doc update to CM
// ---------------------------------------------------------------------------

/**
 * Apply a single AppliedUpdate event to the CM view.
 *
 * The CM state field (`idMapField`) at the moment of entry holds the
 * PRE-update spans (because we haven't dispatched the spans-update
 * effect yet — that happens in this same dispatch). That makes it
 * safe to look up the run's previous position for an extend or
 * tombstone, and the parent's previous position for an insert.
 *
 * The dispatch carries:
 * - `changes`: the text mutation, or empty if the run is a tombstoned
 *   placeholder (no visible change to CM).
 * - `effects`: the new spans array (always).
 * - `annotations`: `isRemote` so the local-CM→doc listener skips it.
 */
function applyDocUpdateToCM(
  view: EditorView,
  doc: TextDocument,
  idMapField: StateField<readonly RunSpan[]>,
  evt: AppliedUpdate,
  localEdit: LocalEditTracker | undefined,
): void {
  const oldSpans = view.state.field(idMapField);
  const node = doc.docState.nodes.get(evt.runId);

  // During a local CM edit, CM already has the new text from the
  // user's input. Re-applying the change here would double the
  // characters and push mid-run inserts to the wrong side of the
  // parent (the spans StateField hasn't caught up to the local edit
  // yet). Skip the cmChanges — but still push the new spans so the
  // field stays in sync.
  const isLocal = !!localEdit?.active;

  let cmChanges: { from: number; to?: number; insert?: string }[] = [];

  if (evt.kind === "tombstone") {
    // Tombstone: find the run in oldSpans and delete its range.
    const range = findRunRange(oldSpans, evt.runId);
    if (range && !isLocal) {
      cmChanges = [{ from: range.start, to: range.end }];
    }
  } else if (evt.kind === "extend") {
    // Extend: find the run in oldSpans, replace its text with the
    // current full text.
    const range = findRunRange(oldSpans, evt.runId);
    if (range && node && !node.deleted && !isLocal) {
      cmChanges = [{ from: range.start, to: range.end, insert: node.text }];
    }
  } else if (evt.kind === "insert") {
    // Insert: the run is new in oldSpans. Insert its text after the
    // parent's end position. Skip tombstoned placeholders (they have
    // no visible text in CM).
    if (node && !node.deleted && !isLocal) {
      const parentRange = findRunRange(oldSpans, node.parentId);
      const insertAt = parentRange ? parentRange.end : 0;
      cmChanges = [{ from: insertAt, insert: node.text }];
    }
  }

  view.dispatch({
    changes: cmChanges,
    effects: setIdMapEffect.of(ensureRootSpan(spansToRunSpans(doc.docState.index.spans))),
    annotations: isRemote.of(true),
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Span returned by `lookupPositionFromSpans` (without a StateField indirection). */
type SpanLookup = {
  readonly runId: string;
  readonly runOffset: number;
  readonly spanIndex: number;
  readonly spanLength: number;
};

/**
 * Pure lookup against a spans array — the same logic as
 * `getRunAtPosition` but takes the spans directly so we can use it
 * from within `tr.changes.iterChanges` (where `view.state` isn't
 * available mid-callback).
 */
export function lookupPositionFromSpans(
  spans: readonly RunSpan[],
  position: number,
): SpanLookup | undefined {
  let cumulative = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (position < cumulative + span.length) {
      return {
        runId: span.runId,
        runOffset: position - cumulative,
        spanIndex: i,
        spanLength: span.length,
      };
    }
    cumulative += span.length;
  }
  return undefined;
}

/**
 * Find the document range occupied by a run in the given spans.
 * Returns `{ start, end }` (end exclusive) or undefined if not found.
 */
export function findRunRange(
  spans: readonly RunSpan[],
  runId: string,
): { start: number; end: number } | undefined {
  let cumulative = 0;
  for (const span of spans) {
    if (span.runId === runId) {
      return { start: cumulative, end: cumulative + span.length };
    }
    cumulative += span.length;
  }
  return undefined;
}

/**
 * Convert the tree's PositionIndex spans to the lighter `RunSpan`
 * shape we expose via the CM StateField. Drops any tombstoned runs
 * (they have no presence in CM).
 *
 * Note: this is intentionally permissive about input shape — the
 * tree's spans are `{ runId, length }` pairs, which is what we want.
 * The function lives here rather than in `@ebbjs/client` because
 * `RunSpan` is a CM-bridge concept.
 */
function spansToRunSpans(
  spans: ReadonlyArray<{ runId: string; length: number }>,
): readonly RunSpan[] {
  return spans.map((s) => ({ runId: s.runId, length: s.length }));
}
