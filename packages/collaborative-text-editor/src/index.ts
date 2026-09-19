/**
 * @ebbjs/collaborative-text-editor — CodeMirror 6 bridge for TextDocument.
 *
 * Wires a CodeMirror 6 editor view to a `@ebbjs/client` TextDocument so
 * that:
 *
 * - Local CM edits (typing, deleting) become `doc.localInsert` /
 *   `doc.localExtend` / `doc.localDelete` calls on the document.
 * - Remote updates (from SSE / catch-up) are applied to the CM document.
 *
 * Run IDs are exposed to consumers via a CM `StateField` mirroring
 * `doc.docState.index.spans`. Each span carries the run id + length so
 * callers can map between CM positions and run references (for
 * presence, cursor anchoring, etc).
 *
 * The package exports:
 *
 * - `mountEditorBridge(view, doc)` — wires both directions
 * - `createIdMapField()` — the StateField (re-exported)
 * - `setIdMapEffect` / `isRemote` — the annotation / effect (re-exported)
 * - `getRunAtPosition` / `getPositionOfRun` — helpers for presence
 */

export {
  mountEditorBridge,
  createBridgeExtension,
  createIdMapField,
  setIdMapEffect,
  isRemote,
  getRunAtPosition,
  getPositionOfRun,
  type EditorBridge,
  type BridgeExtensionConfig,
  type LocalEditTracker,
  type RunSpan,
} from "./bridge";
