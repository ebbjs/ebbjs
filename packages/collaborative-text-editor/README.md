# `@ebbjs/collaborative-text-editor`

CodeMirror 6 bridge for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client)'s `TextDocument`. Wires a CM6 editor view to a causal-tree document so that:

- Local CM edits become `doc.localInsert` / `doc.localExtend` / `doc.localDelete` calls.
- Remote updates (catch-up / SSE) flow into CM as text changes.

A CM `StateField` mirrors `doc.docState.index.spans`, so consumers (presence, cursor anchoring, etc.) can map CM positions to run ids.

## Usage

```ts
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { createClient } from "@ebbjs/client";
import {
  createBridgeExtension,
  createIdMapField,
  mountEditorBridge,
} from "@ebbjs/collaborative-text-editor";

const client = createClient({ serverUrl: "http://localhost:4000", actorId: "alice" });
const doc = client.textDocument("doc_demo");
const idMapField = createIdMapField();

// Capture the view via a closure so the bridge can read it inside
// the CM updateListener (the listener fires synchronously inside
// `view.dispatch`).
const viewRef = { current: null as EditorView | null };
const bridgeExtension = createBridgeExtension({
  doc,
  idMapField,
  getView: () => viewRef.current,
});

const view = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [lineNumbers(), keymap.of(defaultKeymap), bridgeExtension],
  }),
  parent: container,
});
viewRef.current = view;

const bridge = mountEditorBridge(view, doc, idMapField);
// later: bridge.detach(); view.destroy();
```

## API

| Export                                                | What                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `createBridgeExtension({ doc, idMapField, getView })` | CM6 Extension that listens for local edits and dispatches `doc.local*` calls.              |
| `mountEditorBridge(view, doc, idMapField)`            | Subscribes to `doc.onUpdate` and applies remote updates to the view. Returns `{ detach }`. |
| `createIdMapField()`                                  | The `StateField` mirroring `doc.docState.index.spans`.                                     |
| `setIdMapEffect`                                      | The `StateEffect` that replaces the field's value (re-exported for advanced use).          |
| `isRemote`                                            | The `Annotation` marking a CM transaction as originating from the bridge.                  |
| `getRunAtPosition(state, position, idMapField)`       | Lookup helper: which run contains a document position?                                     |
| `getPositionOfRun(state, runId, offset, idMapField)`  | Inverse: what absolute position does a (runId, offset) pair map to?                        |
| `RunSpan`                                             | The `{ runId, length }` shape exposed via the StateField.                                  |

## Peer dependencies

```json
{
  "@codemirror/state": "^6.5.0",
  "@codemirror/view": "^6.30.0",
  "codemirror": "^6.0.0"
}
```

`@ebbjs/client` is a regular dependency.

## How it works

The bridge uses a `isRemote` annotation to mark transactions it dispatches itself (e.g., pushing remote updates into CM). The local-CM→doc `updateListener` skips transactions with this annotation, breaking the recursive loop.

A second listener (subscribed via `doc.onUpdate`) computes the CM changes needed to reflect a remote update, then dispatches them in a single transaction along with the spans-update effect.

The local listener doesn't need to update the spans field — CM is the source of truth during a local edit, and the spans field is updated by the same dispatch that applies remote changes.
