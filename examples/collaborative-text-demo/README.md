# Collaborative Text Demo

A Vite + React 19 + CodeMirror 6 app that opens a browser-based collaborative text editor against a running ebb sync server.

Two tabs editing the same document see each other's keystrokes in real time, with edits flowing through Actions, the Elixir sync server, and SSE fan-out — **not via `BroadcastChannel`**. Concurrent edits at the same position surface as visible conflicts in the right-hand panel.

## Run it

```bash
# Terminal 1: server
cd ebb_server && mix dev

# Terminal 2: demo
pnpm --filter collaborative-text-demo dev
```

Then open:

- <http://localhost:5173/?actor=drew> in one tab
- <http://localhost:5173/?actor=alice> in another

Type in one tab — the text appears in the other within ~100ms. Concurrent edits at the same position appear in the "Show conflicts" panel on both tabs.

## How it works

1. The `?actor=` URL param sets the actor id (bypass auth mode).
2. On first load the demo calls `seed()` to bootstrap a `grp_demo` group + `doc_demo` document via `POST /sync/actions`.
3. A `SyncClient` opens an SSE subscription for the demo's groups.
4. A CodeMirror 6 view is wired to a `TextDocument` via [`@ebbjs/collaborative-text-editor`](../../packages/collaborative-text-editor/).
5. Edits are flushed to the server every 250ms via `client.write(doc.pendingActions())`.
6. Incoming SSE data events are piped into `doc.applyActions()`, which fires `onUpdate` — the bridge reflects the change in CM.
7. Concurrent edits at the same run are recorded by the conflict detector and surfaced via `doc.onConflict()`.

## Files

```
src/
├── main.tsx           # React entry
├── App.tsx            # Top-level layout (header, editor, footer, conflict panel)
├── bootstrap.ts       # handshake + seed + subscribe
├── seed.ts            # demo data bootstrap (one group + member + empty doc)
├── Editor.tsx         # CM6 + bridge + SSE subscription + flush timer
├── ConnectionBadge.tsx # Connection state indicator
├── ConflictPanel.tsx  # Right sidebar with recorded conflicts
└── index.css          # Tailwind v4 + dark theme
```

## What this slice delivers (slice 3 of the [prototype plan](../../packages/client/docs/prototypes/collaborative-text/README.md))

- ✅ New `examples/collaborative-text-demo/` package
- ✅ Bridge from CM6 to `TextDocument` (in `@ebbjs/collaborative-text-editor`)
- ✅ `?actor=drew|alice` URL param → bypass auth
- ✅ Hardcoded `grp_demo` / `doc_demo`; seeded on first load
- ✅ Connection-state indicator
- ✅ Conflict panel (collapsible)
- ⏭️ Presence (deferred to slice 5 polish — see plan)
- ⏭️ Playwright e2e test (slice 4)
