# Collaborative Text Prototype — Work Plan

> **Status: Forward-looking — work plan for the next major piece.** The Elixir sync server (`ebb_server/`, slices 1–4), the `@ebbjs/core` package, and the in-memory `@ebbjs/storage` adapter are **shipped and tested**. The local-first sync SDK (`@ebbjs/client`) is a stub. A CodeMirror-based causal-tree POC exists in [`experiment/collaborative-text/`](../../../experiment/collaborative-text/) using `BroadcastChannel` as a stand-in for the server. This document describes the work to ship a working browser-based collaborative text prototype against `mix dev`, replacing the BroadcastChannel relay with the real Action / SSE / catch-up stack.

## Goal

Two browser tabs editing the same document see each other's keystrokes in real time, with edits flowing through Actions, the Elixir sync server, and SSE fan-out — not via `BroadcastChannel`. The "Colour scenario" from the [April 2026 devlog](../../../packages/www/src/content/devlog/how-collaborative-editing-works.mdx) must surface as a human-visible conflict, not be silently merged.

Non-goals (explicitly out of scope for this prototype):

- Persistent client storage (in-memory is fine)
- Auth beyond `x-ebb-actor-id` header bypass
- Multi-entity / multi-group apps
- A general-purpose `@ebbjs/react` package — the demo will use React 19 directly
- Outbox / offline writes / retries
- Production-grade error handling, telemetry, observability hooks
- CLI tooling, peer replication, server functions

## What's already done (leverage these)

| Piece | Where | Tests |
|---|---|---|
| HLC generation + comparison + msgpack | `@ebbjs/core/src/hlc`, `msgpack` | 60 tests pass |
| Action / Update / Entity schemas | `@ebbjs/core/src/types` | 23 tests pass |
| `createAction`, `createClock`, `localEvent`, `encodeSync` | `@ebbjs/core/src/{action,hlc,msgpack}/index` | — |
| In-memory `StorageAdapter` (ActionLog, DirtyTracker, EntityStore, CursorStore) | `@ebbjs/storage/src/memory` | 43 tests pass |
| Handshake / catch-up / SSE / presence / writes / reads | `ebb_server/lib/ebb_server/sync/router.ex` | 12 sync + 9 integration tests |
| E2E test harness (`startServer`, `seed`) | `@ebbjs/server` | 1 e2e test (handshake) |
| Causal tree + CodeMirror UI + React 19 + HLC | [`experiment/collaborative-text/src/`](../../../experiment/collaborative-text/src/) | Vitest + happy-dom (POC, not wired to ebb) |
| Causal tree "optimization pass" architecture | [`experiment/collaborative-text/architecture/`](../../../experiment/collaborative-text/architecture/) | — |

## Slice plan

Five vertical slices, ordered by what unblocks what. Each slice ends with a runnable demo and passing tests.

### Slice 1 — `@ebbjs/client` (read path)

**Goal:** A TS client can connect to a running `ebb_server`, do handshake + catch-up, and receive live SSE updates.

**Tasks:**

1. `client.handshake({ serverUrl, actorId })` → `{ actor_id, groups[], cursors }`
2. `client.catchUp(groupId, fromGsn)` → paginated `/sync/groups/:group_id?offset=N`, append actions to storage
3. `client.subscribe(groupId, onAction)` → open `/sync/live?groups=...&cursor=N`, parse SSE, dispatch to onAction
4. Hook: action receipt → `storage.actions.append(action)` → entity cache lazy-materializes
5. Test: seed a group + entity via `@ebbjs/server`'s `seed()` helper, connect, assert materialized entity matches.

**Acceptance:** A small `examples/ebb-client-smoke` script connects to a running server, seeds a group, and prints the materialized entity to stdout. No UI yet.

### Slice 2 — Causal tree as a `@ebbjs/client` field type

**Goal:** Port `experiment/collaborative-text/src/causal-tree.ts` and `src/hlc.ts` (mostly already pure) into a typed field type that hooks into the client sync layer.

**Tasks:**

1. Move `causal-tree.ts` to `packages/client/src/fields/collaborative-text/`
2. Add a thin `defineField('collaborativeText', () => CausalTree.empty())` API surface (full `defineModel` deferred)
3. Wire incoming Action/Update events into the causal tree (`PUT` = insert run, `PATCH` = append to run, `DELETE` = tombstone range)
4. Conflict surfacing: snapshot pre-merge state when concurrent edits touch the same run
5. Test: `packages/client/src/fields/collaborative-text/causal-tree.test.ts` ports the POC tests and adds network-driven tests.

**Acceptance:** `client.applyActions([...])` on a text entity produces the same document as the BroadcastChannel POC for the same edit sequence.

### Slice 3 — Demo app (React 19 + CodeMirror 6)

**Goal:** A Vite + React 19 app with CodeMirror 6 that uses the real client, opens two tabs against `mix dev`, and shows live collaborative editing.

**Tasks:**

1. New package `examples/collaborative-text-demo/` (Vite + React 19 + CodeMirror 6 + Tailwind, matching the POC stack)
2. Wire `experiment/collaborative-text/src/cm-bridge.ts` to the new client
3. URL param `?actor=drew` → hardcoded actor ID → bypass auth
4. Hardcoded group ID `grp_demo`; seed via `@ebbjs/server`'s `seed()` on first load
5. Connection state indicator (connecting / live / offline)
6. Conflict surfacing UI: small panel showing the latest conflict's pre-merge snapshot and the resolved result

**Acceptance:** `pnpm --filter collaborative-text-demo dev` + `cd ebb_server && mix dev` in two terminals → open `http://localhost:5173/?actor=drew` and `?actor=alice` → typing in one appears in the other in <100ms over the Action/SSE stack.

### Slice 4 — End-to-end Playwright test

**Goal:** CI catches regressions in the demo.

**Tasks:**

1. Add Playwright to `examples/collaborative-text-demo/`
3. Two-page test: open the demo in two browser contexts, type in page A, assert page B sees the text
4. Conflict test: two pages type in the same position, assert conflict panel surfaces on both
5. Wire into `.github/workflows/` so it runs on PR

**Acceptance:** `pnpm --filter collaborative-text-demo test:e2e` passes locally and in CI.

### Slice 5 — Demo polish (deferred)

Things we'd want for a public-facing demo, but defer:

- README walkthrough with a screenshot
- Docker compose (server on :4000, demo on :5173)
- One-deploy-target config (Render/Fly) using the existing `Dockerfile`
- A second example app (e.g., shared todo list) to show the framework generalizes beyond text

These are post-prototype; the slice plan stops at "two browser tabs working against `mix dev`."

## Open questions

These should be resolved *during* the work, not before:

1. **Where does the causal tree live?** Options: inside `@ebbjs/client` as a field-type module, or as a separate `@ebbjs/causal-text` package. Lean toward `@ebbjs/client` (it's a field type, the framework concept) unless the package starts carrying its own deps.
2. **How does `e.collaborativeText()` actually wire into `defineModel`?** Slice 1 deliberately skips `defineModel` because it's a bigger refactor. The demo will call the client API directly. Add `defineModel` support after the demo proves the field type works.
3. **Do we need a `defineSchema` v0?** The schema question is downstream of the prototype. Skip until needed.
4. **Conflict surfacing API shape.** The devlog sketches the concept (CouchDB-style snapshot table) but doesn't commit to an interface. Slice 2 picks one and iterates.
5. **Persistence.** In-memory storage means a refresh loses everything and reconnects from scratch. That's fine for the prototype — but if the demo gets any traction, add SQLite (`better-sqlite3` is already in `devDependencies`) as the next slice.

## Files to create / modify

When this work starts, the likely touch points are:

```
packages/client/                          # currently a stub; becomes the sync SDK
packages/client/src/sync/                 # new — handshake, catchUp, subscribe
packages/client/src/fields/               # new — causal-text field type
packages/storage/src/memory/              # add hooks for incoming-action wiring
packages/storage/src/types/               # add subscribe(callback) for live updates

examples/collaborative-text-demo/         # new — Vite + React + CodeMirror
experiment/collaborative-text/src/        # port causal-tree.ts OUT of here into packages/client
```

The last item is the key migration: `experiment/collaborative-text/src/causal-tree.ts` becomes the production implementation in `@ebbjs/client`. The POC stays as a thin test harness (with its BroadcastChannel relay replaced by a stub that talks to the in-memory storage adapter) so the algorithm itself remains easy to iterate on.

## Reference

- [April 2026 devlog: CRDTs Aren't Conflict Free](../../../packages/www/src/content/devlog/how-collaborative-editing-works.mdx) — the design rationale
- [Server design: docs/ebb_server/README.md](../../ebb_server/README.md) — the sync protocol the client must speak
- [Current state](../../packages/www/src/content/docs/) — what ships today
- [Storage adapter README](../../../packages/storage/README.md) — the `StorageAdapter` interface the sync client writes into