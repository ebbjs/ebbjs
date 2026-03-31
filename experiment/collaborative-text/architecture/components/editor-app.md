# Editor App

## Purpose

The React application shell that renders two side-by-side CodeMirror editor instances, each representing a different peer. It owns the top-level state (Causal Tree reducer, HLC refs, CM view refs), wires all components together, and provides the Tailwind-styled layout. This is the composition root — it doesn't contain business logic, just plumbing.

## Responsibilities

- Render two CodeMirror editor instances side-by-side with distinct peer identities
- Own the `useReducer` for each peer's Causal Tree state
- Own the HLC mutable ref for each peer
- Own the CM `EditorView` ref for each peer
- Wire up the CM Bridge extension, Presence extension, and Relay hook for each peer
- Provide the Tailwind CSS layout (split-pane, labels, cursor colors)
- Serve as the Vite entry point's root component

## Public interface

This component has no public programmatic interface — it's the top-level React component rendered by `main.tsx`.

### Props

None. The Editor App is the root component. Peer IDs and channel name are hardcoded constants (e.g., `PEER_A = "peer-A"`, `PEER_B = "peer-B"`, `CHANNEL = "collab-text"`).

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| HLC | `createHlc`, `increment`, `Hlc` type | [hlc.md](hlc.md#exported-functions) |
| Causal Tree | `createDocState`, `docReducer`, `DocState`, `DocAction` | [causal-tree.md](causal-tree.md#exported-functions) |
| CM Bridge | `createBridgeExtension`, `BridgeConfig` | [cm-bridge.md](cm-bridge.md#exported-functions--extensions) |
| Presence | `createPresenceExtension`, `usePresence` | [presence.md](presence.md#exported-functions--extensions) |
| Relay | `useRelay` | [relay.md](relay.md#exported-functions) |
| React | `useReducer`, `useRef`, `useEffect`, `useCallback` | External |
| CodeMirror 6 | `EditorView`, `EditorState`, `basicSetup` | External (`codemirror`, `@codemirror/view`, `@codemirror/state`) |

## Internal design notes

### Component structure

```
App
  ├── PeerEditor (peerId="peer-A")
  │     ├── useReducer(docReducer, createDocState())
  │     ├── useRef<Hlc>(createHlc("peer-A"))
  │     ├── useRef<EditorView>(null)
  │     ├── usePresence("peer-A")
  │     ├── useRelay({ channelName: "collab-text", peerId: "peer-A", ... })
  │     └── <div ref={editorMount} />  ← CM EditorView attaches here
  │
  └── PeerEditor (peerId="peer-B")
        └── (same structure, different peerId)
```

Extract a `PeerEditor` component that encapsulates one editor instance with all its hooks and state. The `App` component just renders two `PeerEditor`s side by side.

### CodeMirror initialization

In a `useEffect` (runs once on mount):
1. Create the `EditorState` with extensions: `basicSetup`, `createBridgeExtension(config)`, `createPresenceExtension(presenceConfig)`
2. Create the `EditorView` attached to the mount div
3. Store the view in the ref
4. On cleanup, call `view.destroy()`

### State ownership

Each `PeerEditor` owns its own independent:
- `DocState` (via `useReducer`) — the Causal Tree
- `Hlc` (via `useRef`) — the logical clock
- `EditorView` (via `useRef`) — the CM instance
- `PresenceMap` (via `usePresence`) — remote cursors

The two peers share nothing except the `BroadcastChannel` name. They are fully independent, simulating two separate clients.

### Layout

```
┌─────────────────────────────────────────┐
│           Collaborative Text Editor      │
├────────────────────┬────────────────────┤
│   Peer A           │   Peer B           │
│   ┌──────────────┐ │   ┌──────────────┐ │
│   │  CodeMirror  │ │   │  CodeMirror  │ │
│   │              │ │   │              │ │
│   │              │ │   │              │ │
│   └──────────────┘ │   └──────────────┘ │
├────────────────────┴────────────────────┤
│   Status: Connected via BroadcastChannel │
└─────────────────────────────────────────┘
```

Use Tailwind utility classes: `flex`, `gap-4`, `w-1/2`, `border`, `rounded`, etc. Minimal styling — this is a prototype.

### Broadcast integration

When the CM Bridge's updateListener dispatches an INSERT or DELETE action to the reducer, it also needs to trigger a relay broadcast. The `BridgeConfig.dispatch` callback should do both:

```
const dispatch = (action: DocAction) => {
  treeDispatch(action)  // update local Causal Tree
  relay.broadcast(actionToMessage(action, hlcRef.current, peerId))  // send to remote
}
```

This keeps the broadcast logic out of the Bridge and in the composition layer where it belongs.

## Open questions

- **Should `PeerEditor` be a separate file?** It could live in `App.tsx` since it's only used there, or be extracted to `PeerEditor.tsx`. For a prototype, keeping it in `App.tsx` is fine. The implementer can decide.
- **CM6 `basicSetup` includes undo/redo keybindings** which will conflict with the Causal Tree model. Consider using `minimalSetup` instead, or explicitly removing the undo history extension. The implementer should decide based on what feels right during Slice 1.

## Files

- `src/App.tsx` — the root React component
- `src/main.tsx` — Vite entry point (`createRoot` + `<App />`)
- `index.html` — Vite HTML template (mounts `#root`, loads `src/main.tsx`)
- `vite.config.ts` — Vite dev server config with `@vitejs/plugin-react`
- `package.json` — standalone dependencies (react, react-dom, codemirror, tailwindcss, etc.)
- `tsconfig.json` — extends monorepo base with JSX support added

No dedicated test file — the Editor App is tested through the slice acceptance criteria.
