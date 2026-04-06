/**
 * CodeMirror Bridge (Run-Optimized)
 *
 * Bidirectional translation layer between CodeMirror 6's text document model
 * and the run-length Causal Tree. Maintains a StateField that mirrors the
 * PositionIndex spans, intercepts local edits and translates them into
 * run-level actions (INSERT_RUN, DELETE_RANGE, SPLIT).
 *
 * Key changes from the per-character bridge:
 * - StateField holds RunSpan[] (not string[])
 * - Multi-character inserts produce a SINGLE INSERT_RUN
 * - Mid-run insertions dispatch SPLIT before INSERT_RUN
 * - Deletions dispatch DELETE_RANGE (with splits if needed)
 * - Remote inserts/deletes apply full run text in one CM transaction
 */

import { Annotation, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { increment, toString, type Hlc } from "./hlc.ts";
import {
  lookupPosition,
  ROOT_ID,
  type DocAction,
  type DocState,
  type RunSpan,
  type PositionLookup,
} from "./causal-tree.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeConfig = {
  readonly peerId: string;
  readonly getHlc: () => Hlc;
  readonly setHlc: (hlc: Hlc) => void;
  readonly dispatch: (action: DocAction) => void; // Dispatch to Causal Tree reducer
  readonly getDocState: () => DocState; // Read current Causal Tree state
};

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Annotation to mark transactions as remote, so the updateListener skips them.
 * This breaks the infinite loop: remote edits → CM → listener → skip.
 */
export const isRemote = Annotation.define<boolean>();

// ---------------------------------------------------------------------------
// StateField: span array (mirrors PositionIndex)
// ---------------------------------------------------------------------------

/** Effect to replace the entire span array in the StateField. */
export const setIdMapEffect = StateEffect.define<readonly RunSpan[]>();

/**
 * Creates the CM6 StateField that holds the current span array, mirroring
 * DocState.index.spans. Updated via setIdMapEffect after every tree mutation.
 */
export const createIdMapField = (): StateField<readonly RunSpan[]> =>
  StateField.define<readonly RunSpan[]>({
    create: () => [],
    update: (value, tr) => {
      for (const effect of tr.effects) {
        if (effect.is(setIdMapEffect)) {
          return effect.value;
        }
      }
      return value;
    },
  });

// ---------------------------------------------------------------------------
// Position ↔ Run helpers (for Presence and external consumers)
// ---------------------------------------------------------------------------

/**
 * Look up which run contains a given document position, using the StateField.
 * Returns { runId, offset, spanIndex } or undefined if out of bounds.
 */
export const getRunAtPosition = (
  state: { field: <T>(f: StateField<T>) => T },
  position: number,
  idMapField: StateField<readonly RunSpan[]>,
): PositionLookup | undefined => {
  const spans = state.field(idMapField);
  // Walk the spans to find the one containing the position
  let cumulative = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (position < cumulative + span.length) {
      return { runId: span.runId, offset: position - cumulative, spanIndex: i };
    }
    cumulative += span.length;
  }
  return undefined;
};

/**
 * Find the document position of a given run ID + offset within it,
 * using the StateField.
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
      if (offset >= span.length) return undefined;
      return cumulative + offset;
    }
    cumulative += span.length;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Bridge Extension
// ---------------------------------------------------------------------------

/**
 * Returns a CM6 Extension that bundles the span StateField + an updateListener
 * that intercepts local edits and translates them into run-level Causal Tree
 * actions.
 */
export const createBridgeExtension = (
  config: BridgeConfig,
  idMapField: StateField<readonly RunSpan[]>,
): Extension => {
  return [
    idMapField,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      // Skip remote transactions
      for (const tr of update.transactions) {
        if (tr.annotation(isRemote)) return;
      }

      // Process local changes
      const view = update.view;

      for (const tr of update.transactions) {
        if (!tr.docChanged || tr.annotation(isRemote)) continue;

        tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          const docState = config.getDocState();
          const { index } = docState;

          // ----------------------------------------------------------
          // Handle deletions first (fromA to toA in the old doc)
          // ----------------------------------------------------------
          if (toA > fromA) {
            // Find which runs are affected by the deletion range.
            // We need to delete characters at positions [fromA, toA) in the
            // old document. Walk from toA-1 back to fromA, grouping
            // consecutive chars that belong to the same run.
            //
            // Strategy: iterate through the deletion range, identify
            // contiguous segments within the same run, and dispatch one
            // DELETE_RANGE per segment.
            let pos = fromA;
            while (pos < toA) {
              const lookup = lookupPosition(index, pos);
              if (!lookup) {
                pos++;
                continue;
              }

              // How many chars from this run are in the deletion range?
              const span = index.spans[lookup.spanIndex]!;
              const charsRemainingInSpan = span.length - lookup.offset;
              const charsRemainingInDeletion = toA - pos;
              const count = Math.min(charsRemainingInSpan, charsRemainingInDeletion);

              config.dispatch({
                type: "DELETE_RANGE",
                runId: lookup.runId,
                offset: lookup.offset,
                count,
              });

              pos += count;
            }
          }

          // ----------------------------------------------------------
          // Handle insertions
          // ----------------------------------------------------------
          const insertedText = inserted.toString();
          if (insertedText.length > 0) {
            // After deletions, the doc state may have changed.
            // Re-read it for correct position resolution.
            const currentState = config.getDocState();
            const currentIndex = currentState.index;

            // ----------------------------------------------------------
            // Run extension check: can we append to an existing run?
            //
            // Conditions for extending instead of creating a new run:
            // 1. Inserting after position 0 (there's a preceding character)
            // 2. The preceding character is at the END of its run
            // 3. That run belongs to the SAME peer
            // 4. That run is not deleted
            // 5. That run is a leaf (no children) — prevents inserting
            //    between a split left-half and its right-half continuation
            // ----------------------------------------------------------
            if (fromA > 0) {
              const prevLookup = lookupPosition(currentIndex, fromA - 1);
              if (prevLookup) {
                const prevRun = currentState.nodes.get(prevLookup.runId);
                if (prevRun) {
                  const isAtEnd = prevLookup.offset === prevRun.text.length - 1;
                  const isSamePeer = prevRun.peerId === config.peerId;
                  const isNotDeleted = !prevRun.deleted;
                  const isLeaf = (currentState.children.get(prevRun.id) ?? []).length === 0;

                  if (isAtEnd && isSamePeer && isNotDeleted && isLeaf) {
                    // Extend the existing run — no new HLC, no new node
                    config.dispatch({
                      type: "EXTEND_RUN",
                      runId: prevRun.id,
                      appendText: insertedText,
                    });
                    // Skip the INSERT_RUN path below
                    return;
                  }
                }
              }
            }

            // ----------------------------------------------------------
            // Standard INSERT_RUN path (new run needed)
            // ----------------------------------------------------------

            // Determine the parent run for the insertion.
            // The parent is the run containing the character just before
            // the insert position (fromA) in the ORIGINAL document.
            // After deletions, we need to work with the current state.
            //
            // If fromA === 0 → parent is ROOT
            // If fromA > 0 → find the char at position fromA - 1
            //   (but we need to account for any chars that were deleted
            //    before fromA in this same change)
            //
            // In a replacement (delete then insert at same from), after
            // the delete the chars before fromA are still there.
            // The parent for the insert is whatever is at position fromA-1
            // in the state AFTER deletion.
            let parentId: string;
            let splitParentAt: number | undefined;

            // Compute the effective position in the post-deletion state.
            // Deletions before fromA don't happen (fromA is the start of
            // the deleted range). So position fromA-1 in the original doc
            // is still at position fromA-1 in the post-deletion doc
            // (characters before fromA are unchanged).
            if (fromA === 0) {
              parentId = ROOT_ID;
            } else {
              // Find the run at position fromA-1 in the current (post-deletion) state
              const parentPos = fromA - 1;
              const parentLookup = lookupPosition(currentIndex, parentPos);
              if (!parentLookup) {
                parentId = ROOT_ID;
              } else {
                const parentRun = currentState.nodes.get(parentLookup.runId);
                if (!parentRun) {
                  parentId = ROOT_ID;
                } else {
                  // If the parent char is at the END of its run, no split needed
                  // If it's in the middle, we need to split the run first
                  if (parentLookup.offset < parentRun.text.length - 1) {
                    // Mid-run: split at offset+1 (after the parent char)
                    const splitOffset = parentLookup.offset + 1;
                    config.dispatch({
                      type: "SPLIT",
                      runId: parentLookup.runId,
                      offset: splitOffset,
                    });
                    // Record the split offset so the relay can include it
                    // in the broadcast — the receiving peer needs it to
                    // perform the same split before inserting.
                    splitParentAt = splitOffset;
                  }
                  // Parent is the left half (keeps original ID)
                  parentId = parentLookup.runId;
                }
              }
            }

            // Create a single RunNode for the entire inserted text
            const newHlc = increment(config.getHlc());
            config.setHlc(newHlc);
            const nodeId = toString(newHlc);

            config.dispatch({
              type: "INSERT_RUN",
              node: {
                id: nodeId,
                text: insertedText,
                parentId,
                peerId: config.peerId,
                deleted: false,
              },
              splitParentAt,
            });
          }
        });
      }

      // Rebuild the span field from the Causal Tree's index and dispatch
      // it as a follow-up transaction. Marked as remote so the listener
      // skips it.
      const spans = config.getDocState().index.spans;
      view.dispatch({
        effects: setIdMapEffect.of(spans),
        annotations: isRemote.of(true),
      });
    }),
  ];
};

// ---------------------------------------------------------------------------
// Remote operation helpers
// ---------------------------------------------------------------------------

/**
 * Dispatch a CM transaction that inserts a run's full text at the given position.
 * Marks the transaction as remote so the updateListener ignores it.
 *
 * Combines the text change and the span field rebuild into a single dispatch
 * so the spans are always consistent with the document.
 */
export const applyRemoteInsert = (
  view: EditorView,
  position: number,
  text: string,
  _runId: string,
  _idMapField: StateField<readonly RunSpan[]>,
  getDocState: () => DocState,
): void => {
  const spans = getDocState().index.spans;
  view.dispatch({
    changes: { from: position, insert: text },
    effects: setIdMapEffect.of(spans),
    annotations: isRemote.of(true),
  });
};

/**
 * Dispatch a CM transaction that deletes `count` characters starting at `from`.
 * Marks as remote via annotation.
 *
 * Combines text change and span field in one dispatch.
 */
export const applyRemoteDelete = (
  view: EditorView,
  from: number,
  count: number,
  _idMapField: StateField<readonly RunSpan[]>,
  getDocState: () => DocState,
): void => {
  const spans = getDocState().index.spans;
  view.dispatch({
    changes: { from, to: from + count },
    effects: setIdMapEffect.of(spans),
    annotations: isRemote.of(true),
  });
};
