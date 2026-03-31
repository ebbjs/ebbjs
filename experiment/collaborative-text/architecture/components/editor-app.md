# Editor App

## Purpose

The React application shell that renders two side-by-side CodeMirror editor instances, each representing a different peer. It owns the top-level state (Causal Tree reducer, HLC refs, CM view refs), wires all components together, and provides the Tailwind-styled layout. This is the composition root — it doesn't contain business logic, just plumbing.

Changes in the optimization pass are minimal: wire the new `DocAction` types, pass `RunSpan[]` instead of `string[]` for the ID map, and update the inspector instrumentation to display run-level info.

## Responsibilities

- Render two CodeMirror editor instances side-by-side with distinct peer identities
- Own the `useReducer` for each peer's Causal Tree state (now with `INSERT_RUN` / `DELETE_RANGE` / `SPLIT` actions)
- Own the HLC mutable ref for each peer
- Own the CM `EditorView` ref for each peer
- Wire up the CM Bridge extension, Presence extension, and Relay hook for each peer
- Provide the `localDispatch` callback that updates the tree AND broadcasts (same pattern as today, but with run-level actions)
- Provide the Tailwind CSS layout
- Wire the Inspector store for debugging

## Public interface

This component has no public programmatic interface — it's the top-level React component rendered by `main.tsx`.

### Props

None. Peer IDs and channel name are hardcoded constants (`"peer-A"`, `"peer-B"`, `"collab-text"`).

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| HLC | `createHlc`, `Hlc` type | [hlc.md](hlc.md) |
| Causal Tree | `createDocState`, `docReducer`, `DocState`, `DocAction`, `reconstruct` (for debug consistency check) | [causal-tree.md](causal-tree.md) |
| CM Bridge | `createBridgeExtension`, `createIdMapField`, `setIdMapEffect`, `BridgeConfig` | [cm-bridge.md](cm-bridge.md) |
| Presence | `createPresenceExtension`, `usePresence` | [presence.md](presence.md) |
| Relay | `useRelay`, `RelayMessage`, `InsertRunMessage`, `DeleteRangeMessage` | [relay.md](relay.md) |
| Inspector Store | `logEvent`, `updateHlc`, `updateDocState` | (internal module, not a separate component doc) |
| React | `useReducer`, `useRef`, `useEffect`, `useCallback`, `useMemo` | External |
| CodeMirror 6 | `EditorView`, `EditorState`, keymap, extensions | External |

## Internal design notes

### Component structure (unchanged)

```
App
  ├── PeerEditor (peerId="peer-A")
  │     ├── useReducer(docReducer, createDocState())
  │     ├── useRef<Hlc>(createHlc("peer-A"))
  │     ├── useRef<EditorView>(null)
  │     ├── usePresence("peer-A", idMapField)
  │     ├── useRelay({ ..., dispatch: remoteDispatch })
  │     └── <div ref={editorMount} />
  │
  └── PeerEditor (peerId="peer-B")
        └── (same structure, different peerId)
```

### Key wiring change: localDispatch

The `localDispatch` callback now dispatches run-level actions and broadcasts run-level messages:

```
const localDispatch = (action: DocAction) => {
  docStateRef.current = docReducer(docStateRef.current, action)
  treeDispatch(action)
  const message = actionToMessage(action, hlcRef.current, peerId)
  broadcastRef.current?.(message)
}
```

The `actionToMessage` helper converts `INSERT_RUN` → `InsertRunMessage`, `DELETE_RANGE` → `DeleteRangeMessage`. `SPLIT` actions are NOT broadcast — they are local-only (the remote peer will perform its own split when it receives the INSERT_RUN that caused the split).

### Consistency check (unchanged pattern)

```
useEffect(() => {
  const treeText = reconstruct(docState)
  const cmText = view.state.doc.toString()
  if (treeText !== cmText) {
    console.error(`[${peerId}] INCONSISTENCY DETECTED!`)
  }
}, [docState])
```

This remains a debug-only check. `reconstruct()` is O(n) but only runs on state changes, not on the hot path.

### Inspector changes

The inspector store and panel need minor updates to display run-level info:
- Event log: show `INSERT_RUN "hello" (5 chars)` instead of 5 separate `INSERT "h"`, `INSERT "e"`, etc.
- Causal tree visualization: show runs as collapsed chains (already partially implemented in the current `InspectorPanel.tsx`)
- HLC state: unchanged

## Open questions

- **SPLIT broadcast**: Should SPLIT actions be broadcast? **No** — splits are a local consequence of receiving a remote INSERT_RUN. Each peer performs its own splits as needed. Broadcasting splits would be redundant and could cause ordering issues.

## Files

- `src/App.tsx` — the root React component with `PeerEditor`
- `src/main.tsx` — Vite entry point
- `src/inspector-store.ts` — observable store for inspector data
- `src/InspectorPanel.tsx` — tabbed inspector UI
- `index.html` — Vite HTML template
