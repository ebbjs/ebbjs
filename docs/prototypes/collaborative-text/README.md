# Collaborative Text Prototype — Design Doc

> **Status: Forward-looking — authoritative design for the next major piece of work.** The Elixir sync server (`ebb_server/`, slices 1–4), the `@ebbjs/core` package, and the in-memory `@ebbjs/storage` adapter are **shipped and tested**. The local-first sync SDK (`@ebbjs/client`) is a stub. A CodeMirror-based causal-tree POC exists in [`experiment/collaborative-text/`](../../../experiment/collaborative-text/) using `BroadcastChannel` as a stand-in for the server. This document describes the architecture and slice plan for shipping a working browser-based collaborative text prototype against `mix dev`, replacing the BroadcastChannel relay with the real Action / SSE / catch-up stack.

## Goal

Two browser tabs editing the same document see each other's keystrokes in real time, with edits flowing through Actions, the Elixir sync server, and SSE fan-out — **not via `BroadcastChannel`**. The "Colour scenario" from the [April 2026 devlog](../../../packages/www/src/content/devlog/how-collaborative-editing-works.mdx) must surface as a human-visible conflict, not be silently merged.

## Non-goals (explicitly out of scope)

- Persistent client storage (in-memory is fine; refresh loses state)
- Auth beyond `x-ebb-actor-id` header bypass
- Multi-entity / multi-group apps (the prototype is one document)
- A general-purpose `@ebbjs/react` package — the demo uses React 19 directly
- `defineModel` / `defineSchema` / typed query DSL
- Outbox / offline writes / retries
- Production-grade error handling, telemetry, observability hooks
- CLI tooling, peer replication, server functions
- Server-side SDK for SSR

---

## Architecture decisions

Five questions were raised in the initial work plan. They've been resolved as follows.

### Decision 1 — Where the causal tree lives

Two things to keep separate:

| Thing | What it is | Lives in |
|---|---|---|
| **Type marker** (`e.collaborativeText()`) | A data-shape tag (`{ value, update_id, hlc }` where `value` is an opaque encoded tree blob) | `@ebbjs/core/src/fields/collaborative-text.ts` — ~10 lines |
| **Algorithm** (the run-length causal tree, ported from `experiment/collaborative-text/src/causal-tree.ts`) | Pure data structure: takes Updates, produces a document | `@ebbjs/client/src/fields/collaborative-text/` |

**Rationale:**
- The type marker in `@ebbjs/core` matches the v1 docs API (`import { e } from "@ebbjs/core"`).
- The algorithm in `@ebbjs/client` because it's tied to the Action/Update shape and needs to subscribe to incoming actions via the storage adapter — both client concerns.
- Single import surface for users.
- Storage stays dumb — `@ebbjs/storage` continues to do HLC + tiebreak on the field's `value` blob; the client maintains the actual tree in its own per-entity state.

**Storage doesn't know about field types.** When a `causal-tree` field is updated, the storage adapter sees `{ value: <opaque blob>, update_id, hlc }` and materializes it the same way as any LWW field — last action wins for the blob. The client *also* subscribes to the Action stream and replays all Updates on its in-memory causal tree, so the client keeps the live, evolving tree regardless of what storage materializes.

### Decision 2 — `defineModel` is deferred

For the prototype, the demo has exactly one model (a text document). The client exposes a direct API:

```ts
const tree = await client.textDocument.open(docId);
tree.localInsert("hello", { afterRunId: "ROOT", hlc: localHlc(clock) });
tree.onUpdate(action => { /* CodeMirror integration */ });
```

`defineModel` adds value when we have multiple entity types or want type-safe CRUD. That's slice 5+ (a second example app). The prototype hardcodes "one document = one entity with one causal-tree field."

### Decision 3 — `defineSchema` is deferred

Same reason. No schema builder until we have a second model. The client hardcodes the single model type.

### Decision 4 — Conflict surfacing API

**Provide both event-based and query-based APIs.** Detection rule below.

#### Detection rule

A "conflict" is recorded when **all** of these are true:

1. Two or more Updates target the **same RunNode** (or its split descendants).
2. Those Updates have **concurrent HLCs** — neither strictly happens-before the other (i.e., not sequential edits on your own run).
3. The Updates are **non-trivial** — both modify content (insert or extend), not just split or tombstone.

Happens-before: HLC `a` happens-before `b` iff `a.l < b.l`, OR (`a.l == b.l` AND `a.c <= b.c`). Concurrent = neither happens-before the other.

This filters out boring sequential edits (typing at the end of your own run, then someone else types after) and surfaces the real "surprising merge" cases like the Colour scenario.

#### API shape

```ts
type Conflict = {
  readonly id: string;
  readonly entityId: string;
  readonly field: string;
  readonly detectedAt: number;
  readonly preMerge: RunSnapshot;            // tree state BEFORE merging contributing actions
  readonly postMerge: RunSnapshot;           // tree state AFTER merging
  readonly contributingActions: readonly Action[];
};

// Event-based — for UI:
tree.onConflict((conflict: Conflict) => { ... });

// Query-based — for tests and debugging:
tree.conflicts.all();
tree.conflicts.forRun(runId: string);
tree.conflicts.since(timestamp: number);
tree.conflicts.clear();
```

Conflicts live **in-memory on the tree**, not in the storage adapter. Rationale: the action log is the source of truth for *what happened*; conflicts are derived metadata. The server doesn't need to know about them. Re-deriving on reload is cheap (walk the action log, apply the detection rule). If we want conflicts to survive a reload later, we can persist them in `localStorage`.

#### UI behavior

For each conflict, show:
- The pre-merge text and the post-merge text (small diff)
- Who contributed which edits (actor IDs + HLCs)
- Buttons: "Dismiss" / "Revert to pre-merge"

For the prototype: small panel listing the last N conflicts with a "dismiss" button. The framework records and exposes the info; the app decides what to do.

### Decision 5 — Persistence is deferred

For the prototype: in-memory storage is fine. Refresh = empty doc, reconnect, server replays from start. The demo script re-seeds the group via `@ebbjs/server`'s `seed()` helper on load.

Post-prototype (slice 6+):

| Adapter | Use case | Library |
|---|---|---|
| SQLite | Node-side, SSR, tests, server-side state | `better-sqlite3` (already in `devDependencies`) |
| IndexedDB | Browser persistence | Custom (no extra deps) |
| sql.js (WASM) | Browser persistence without IndexedDB | Larger bundle, last resort |

Both adapters share the existing `StorageAdapter` interface. Adding SQLite is ~150 lines + tests — the `ActionLog`/`DirtyTracker`/`EntityStore`/`CursorStore` shape fits a SQL backend well (each is essentially a table).

---

## Component designs

### SyncClient (`@ebbjs/client/src/sync/`)

The HTTP client for the sync server. Three methods plus a few plumbing hooks.

```ts
// @ebbjs/client/src/sync/client.ts (target API)

interface SyncClient {
  /** POST /sync/handshake. Returns actor identity + groups + initial cursors. */
  handshake(): Promise<{ actorId: string; groups: Group[]; cursors: Record<GroupId, number> }>;

  /** GET /sync/groups/:group_id?offset=N. Returns actions ordered by GSN. */
  catchUp(groupId: GroupId, fromGsn: number): Promise<{ actions: Action[]; nextOffset: number | null; upToDate: boolean }>;

  /** GET /sync/live?groups=...&cursor=N. SSE stream; returns unsubscribe fn. */
  subscribe(groupIds: GroupId[], fromGsn: number, onEvent: (event: SSEEvent) => void): () => void;

  /** POST /sync/actions. Submit a batch of actions. */
  write(actions: Action[]): Promise<{ rejected: RejectedAction[] }>;

  /** GET /entities/:id, POST /entities/query. Read materialized entities. */
  getEntity(id: EntityId, actorId: ActorId): Promise<Entity>;
  queryEntities(type: string, opts?: QueryOpts, actorId: ActorId): Promise<Entity[]>;

  /** Connection state for UI indicators. */
  readonly state: Readable<ConnectionState>; // 'connecting' | 'live' | 'reconnecting' | 'offline'
}
```

**Action receipt hook.** When `subscribe` receives an action, the client appends it to the storage adapter (`storage.actions.append(action)`), which marks the affected entities dirty. Field-type subscribers (like the causal tree) get notified via the dirty mark and re-materialize.

```ts
// Inside subscribe():
onEvent((event) => {
  if (event.type === 'data') {
    for (const action of event.actions) {
      storage.actions.append(action);
      // storage internally marks affected entities dirty;
      // field-type modules subscribe via storage.dirtyTracker
    }
  }
});
```

**Optimistic local apply.** When the user types, the client creates an Action, applies it locally to the causal tree immediately (for instant feedback), then calls `write([action])` to send to the server. If the server rejects (permission, HLC drift, dedup), the action is removed and the tree reverts. This matches the devlog's "writes are local facts, applied to the user's replica immediately" philosophy.

### CausalTree field type (`@ebbjs/client/src/fields/collaborative-text/`)

Ports `experiment/collaborative-text/src/causal-tree.ts` (652 lines) and adapts it to consume Action/Update streams from the sync client instead of from the BroadcastChannel relay.

**Key types (from the experiment, preserved):**

```ts
type RunNode = {
  id: string;           // HLC-derived; sort key for siblings
  text: string;
  parentId: string;     // insertion anchor
  peerId: string;
  deleted: boolean;
};

type DocAction =
  | { type: 'INSERT_RUN'; node: RunNode; splitParentAt?: number }
  | { type: 'DELETE_RANGE'; runId: string; offset: number; count: number }
  | { type: 'SPLIT'; runId: string; offset: number }
  | { type: 'EXTEND_RUN'; runId: string; appendText: string };
```

**Wire format.** The experiment's `relay.ts` already produces messages that look like ebb Actions:
- `INSERT_RUN` → `method: 'put'` Update targeting a RunNode entity
- `DELETE_RANGE` → `method: 'delete'` Update with `{ runId, offset, count }`
- `SPLIT` → local-only (split is a local consequence of receiving a remote INSERT_RUN; receivers perform their own splits)
- `EXTEND_RUN` → `method: 'patch'` Update appending to an existing run

The experiment's relay wraps these in `{ type: 'INSERT_RUN', node: ... }` messages. For production, we re-shape to:
```ts
{ id, actor_id, hlc, gsn: 0, updates: [{ id, subject_id: <runId>, subject_type: 'run', method: 'put' | 'patch' | 'delete', data: ... }] }
```

**Run ID format.** From `experiment/collaborative-text/src/causal-tree.ts`: `id: HLC-derived ID (from the first character's HLC)`. The run's ID is a stringification of its HLC. This makes runs orderable by HLC and gives deterministic merge order.

**Conflict surfacing in the merge path.** When the reducer applies an incoming action to the tree:
1. Check if the action targets a RunNode that another in-flight or recently-merged action also touched
2. If yes, snapshot the pre-merge tree state
3. Apply the merge
4. Record a `Conflict` record with pre/post snapshots and the contributing actions
5. Fire `tree.onConflict(conflict)` if subscribed

The detection uses the rule from Decision 4. Implementation: in the reducer, before applying a non-trivial Update to a RunNode, check if the RunNode was modified by another action whose HLC is concurrent with this one. If yes, flag.

### Demo app (`examples/collaborative-text-demo/`)

New package. Vite + React 19 + CodeMirror 6 + Tailwind, matching the POC stack. Wires `experiment/collaborative-text/src/cm-bridge.ts` to the new client.

**Bootstrap flow on first load:**

1. URL param `?actor=drew` (or `?actor=alice`) → actor ID
2. Hardcoded `grp_demo` and `doc_demo` IDs
3. If the group doesn't exist (first run), the demo calls `seed()` from `@ebbjs/server` to bootstrap it via HTTP `POST /sync/actions` with a PUT for the group, a PUT for the group member, and a PUT for the document
4. Open the document: `client.textDocument.open('doc_demo')`
5. Wire CodeMirror to the causal tree

**Connection state indicator** (small badge in the corner): connecting → live → reconnecting → offline.

**Conflict panel** (collapsible right sidebar): shows the last N conflicts with pre/post text and a dismiss button.

**Why this stack.** React 19 + Vite matches what the POC uses. CodeMirror 6 is the right editor for showing the actual document state (the POC already proved it works). Tailwind is a one-line config add.

---

## API surface (target)

### `@ebbjs/core` — type marker only

```ts
// Adds to @ebbjs/core exports
export const e = {
  string: () => ({ type: 'lww' }),
  number: () => ({ type: 'lww' }),
  boolean: () => ({ type: 'lww' }),
  counter: () => ({ type: 'counter' }),
  collaborativeText: () => ({ type: 'causal-tree' }),
};
```

For the prototype, only `collaborativeText()` matters. The others are stubs that the prototype doesn't use.

### `@ebbjs/client` — sync SDK + causal tree field

```ts
// Sync client factory
import { createClient } from '@ebbjs/client';

const client = createClient({
  serverUrl: 'http://localhost:4000',
  actorId: 'drew',  // bypass mode uses this as the actor_id
  storage: createMemoryAdapter(),  // from @ebbjs/storage
});

// Open a text document
const doc = await client.textDocument.open('doc_demo');

// Subscribe to incoming updates (from other clients via SSE)
const unsubscribe = doc.onUpdate((update) => {
  // update: Action that modified this document's tree
  // already applied to the tree; this is for UI re-render
});

// Listen for conflicts (event-based)
doc.onConflict((conflict) => {
  // conflict: Conflict record
  showInConflictPanel(conflict);
});

// Local edit (optimistic)
doc.localInsert('hello world', {
  afterRun: doc.rootRunId,  // 'ROOT' for now
});

// Local delete (optimistic)
doc.localDelete({ runId, offset: 0, count: 5 });

// Send pending actions to the server
const { rejected } = await client.write(doc.pendingActions());
```

### Demo

```bash
# Terminal 1: server
cd ebb_server && mix dev

# Terminal 2: demo
pnpm --filter collaborative-text-demo dev
# Open http://localhost:5173/?actor=drew in one tab
# Open http://localhost:5173/?actor=alice in another
```

---

## Slice plan

Five vertical slices, ordered by what unblocks what. Each slice ends with a runnable demo and passing tests.

### Slice 1 — `@ebbjs/client` (read path)

**Goal:** A TS client can connect to a running `ebb_server`, do handshake + catch-up, and receive live SSE updates.

**Tasks:**

1. `client.handshake()` → `{ actorId, groups[], cursors }`
2. `client.catchUp(groupId, fromGsn)` → paginated `/sync/groups/:group_id?offset=N`
3. `client.subscribe(groupIds, fromGsn, onEvent)` → SSE stream parsing
4. Action receipt → `storage.actions.append(action)` → storage marks dirty
5. `client.write(actions)` → `POST /sync/actions`
6. Connection state machine (connecting → live → reconnecting → offline) with reconnect backoff
7. Test: seed a group + entity via `@ebbjs/server`'s `seed()`, connect, assert materialized entity matches

**Acceptance:** A small `examples/ebb-client-smoke` script connects to a running server, seeds a group, prints the materialized entity to stdout. No UI yet.

### Slice 2 — Causal tree field type

**Goal:** Port `experiment/collaborative-text/src/causal-tree.ts` into `@ebbjs/client/src/fields/collaborative-text/` and wire it into the sync client.

**Tasks:**

1. Move `causal-tree.ts` and `hlc.ts` (HLC is already in `@ebbjs/core`, so use that)
3. Adapt the wire format: experiment's `DocAction`s → ebb Action/Update shape (`subject_type: 'run'`, `subject_id: <runId>`)
4. `client.textDocument.open(docId)` → returns the `CausalTree` instance, subscribed to incoming Updates for that entity
5. `doc.localInsert()` / `doc.localDelete()` → create an Action with the right Update, apply locally, mark pending for `client.write()`
6. `doc.onUpdate()` event for incoming Updates (after local materialization)
7. Conflict detection in the merge path (Decision 4)
8. `doc.onConflict()` event + `doc.conflicts.all()` query
9. Tests: port `experiment/collaborative-text/src/__tests__/` to `packages/client/src/fields/collaborative-text/__tests__/`, add network-driven tests using a mock SSE source

**Acceptance:** `client.applyActions([...])` on a text entity produces the same document as the BroadcastChannel POC for the same edit sequence.

### Slice 3 — Demo app

**Goal:** A Vite + React 19 app with CodeMirror 6 that uses the real client, opens two tabs against `mix dev`, and shows live collaborative editing.

**Tasks:**

1. New package `examples/collaborative-text-demo/` (Vite + React 19 + CodeMirror 6 + Tailwind)
2. Wire `experiment/collaborative-text/src/cm-bridge.ts` to the new client (replace the BroadcastChannel relay with sync client subscriptions)
3. URL param `?actor=drew` → hardcoded actor ID → bypass auth
4. Hardcoded group ID `grp_demo`; seed via `@ebbjs/server`'s `seed()` on first load (POST bootstrap group + member + document if they don't exist)
5. Connection state indicator (connecting / live / offline badge)
6. Conflict panel (collapsible right sidebar showing last N conflicts)
7. Test: manual two-tab test against `mix dev`

**Acceptance:** `pnpm --filter collaborative-text-demo dev` + `cd ebb_server && mix dev` → open two tabs with different actor IDs → typing in one appears in the other in <100ms over the Action/SSE stack.

### Slice 4 — End-to-end Playwright test

**Goal:** CI catches regressions in the demo.

**Tasks:**

1. Add Playwright to `examples/collaborative-text-demo/`
2. Two-page test: open the demo in two browser contexts, type in page A, assert page B sees the text
3. Conflict test: two pages type in the same position, assert conflict panel surfaces on both
4. Wire into `.github/workflows/` so it runs on PR
5. Mock the Elixir server boot or use the `@ebbjs/server` test harness

**Acceptance:** `pnpm --filter collaborative-text-demo test:e2e` passes locally and in CI.

### Slice 5 — Demo polish (deferred)

Things we'd want for a public-facing demo, but defer until slices 1–4 ship:

- README walkthrough with a screenshot
- Docker compose (server on :4000, demo on :5173)
- One-deploy-target config (Render/Fly) using the existing `Dockerfile`
- A second example app (e.g., shared todo list) to prove the framework generalizes beyond text

---

## Files to create / modify

When this work starts, the likely touch points are:

```
packages/core/src/fields/collaborative-text.ts        # new — type marker (~10 lines)
packages/core/src/index.ts                              # modify — export e.collaborativeText()

packages/client/                                        # currently a stub; becomes the sync SDK
packages/client/src/sync/                               # new — handshake, catchUp, subscribe, write
packages/client/src/sync/client.ts                     # new — SyncClient
packages/client/src/sync/sse.ts                        # new — SSE parsing (uses native EventSource)
packages/client/src/sync/storage.ts                     # new — wire action receipt to storage adapter
packages/client/src/fields/                             # new — field type implementations
packages/client/src/fields/collaborative-text/         # new — port causal-tree.ts here
packages/client/src/fields/collaborative-text/tree.ts  # port of experiment/causal-tree.ts
packages/client/src/fields/collaborative-text/types.ts # RunNode, Conflict, etc.
packages/client/src/fields/collaborative-text/conflict.ts  # conflict detection
packages/client/src/text-document.ts                   # new — client.textDocument.open(docId) API

packages/storage/src/memory/                            # modify — add subscribe hook for live updates
packages/storage/src/types/storage-adapter.ts           # modify — add subscribe(callback) for live updates

packages/server/src/seed-client.ts                      # already exists; use as-is for demo bootstrap
packages/server/src/test/e2e/                           # add an e2e test for the demo flow

examples/                                               # new — demo apps
examples/collaborative-text-demo/                       # new — Vite + React 19 + CodeMirror 6
examples/ebb-client-smoke/                              # new — slice 1 acceptance test script

experiment/collaborative-text/                          # stays as a test harness
experiment/collaborative-text/src/causal-tree.ts        # moved OUT — now in packages/client
experiment/collaborative-text/src/relay.ts              # stays — used by experiment for testing the algorithm
experiment/collaborative-text/src/__tests__/            # tests migrate to packages/client
experiment/collaborative-text/PLAN.md                  # update or delete (this doc supersedes it)

docs/prototypes/collaborative-text/                     # new — this design doc
```

**Key migration:** `experiment/collaborative-text/src/causal-tree.ts` becomes the production implementation in `@ebbjs/client/src/fields/collaborative-text/tree.ts`. The experiment stays as a thin test harness — its `relay.ts` (BroadcastChannel) becomes a stub that drives the tree directly with synthetic Actions, so the algorithm itself remains easy to iterate on.

---

## Open questions (remaining)

These came up during design but don't block the prototype. Resolve during or after the work.

1. **HLC skew handling.** Server validates client HLCs against 120s future / 24h past drift. If a client's clock is wrong, their actions get rejected. For the prototype, the demo runs locally so no clock drift. If shared across machines: document the requirement ("use NTP") or add a "discovery" endpoint that lets clients sync HLC state.

2. **Optimistic vs pessimistic local apply.** The design assumes optimistic (apply locally, reconcile if server rejects). If a reject is common (e.g., permission denial), the UI flashes confusingly. Mitigation: do permission checks client-side (the storage has synced GroupMember records) before applying locally. Server-side rejection is then a rare event that should be a UI error, not a "revert the edit" event.

3. **Bootstrap mechanics.** The demo needs to create the group + member + document on first load. Options:
   - Bundle the seed call into the demo's startup (synchronous on page load)
   - Have the demo auto-create on first load via bootstrap Actions
   - Pre-seed via a server-side script
   The simplest is option 1 (call `@ebbjs/server`'s `seed()`). The demo is single-user on initial visit, multi-user on subsequent visits.

4. **Presence.** The April 2026 devlog mentions "presence as the bridge from collaborative text" but the prototype doesn't include cursor presence. The server has `POST /sync/presence` ready. Slice 5+ can add it; it's a small lift once the sync client exists.

5. **HLC for the run ID.** The experiment's `causal-tree.ts` derives run IDs from HLC. This means the HLC is the identity, and ordering is HLC order. Need to verify this matches our HLC packing format (`(logical_time << 16) | counter`) — the experiment uses a string representation that may need adapting.

6. **Per-action conflict detection vs batch.** The detection rule fires on each incoming Action. But sometimes a single Action with multiple Updates is internally consistent (one Update's HLC dominates another's by construction). The detection should only fire when *concurrent* Actions both touch the same run. Implementation: track a small "recently applied per-run" map with the HLC of the last update; an incoming Action with concurrent HLC to that triggers detection.

---

## Reference

- [April 2026 devlog: CRDTs Aren't Conflict Free](../../../packages/www/src/content/devlog/how-collaborative-editing-works.mdx) — the design rationale
- [Server design: docs/ebb_server/README.md](../../../ebb_server/README.md) — the sync protocol the client must speak
- [Current state docs](../../../packages/www/src/content/docs/) — what ships today
- [Storage adapter README](../../../packages/storage/README.md) — the `StorageAdapter` interface the sync client writes into
- [POC architecture docs](../../../experiment/collaborative-text/architecture/) — the optimization-pass design that we're porting
- [V1 data model](../../../packages/www/src/content/docs/v1-target/data-model.md) — the target typed-fields design (we diverge for the prototype)