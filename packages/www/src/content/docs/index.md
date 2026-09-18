---
title: "Current State"
description: "What is actually in the Ebb repo today — components, endpoints, and tests."
---

> **Ebb is pre-alpha.** The documentation is split into two sections:
>
> - **[Current state](#current-state)** (this page) — what's actually shipped: the Elixir sync server, `@ebbjs/core`, `@ebbjs/storage`, the `@ebbjs/server` test harness. Everything here runs and is tested.
> - **[v1 Target API](/docs/v1-target/overview)** — the planned public surface (`defineModel`, `createClient`, `useQuery`, `defineFunction`, etc.). **None of this is implemented yet.** These pages describe where Ebb is going.

## Current state

### Server — `ebb_server/`

An Elixir/OTP application. Single-node sync server with a complete HTTP API. Slices 1–4 of the [server design](https://github.com/ebbjs/ebbjs/blob/main/docs/ebb_server/README.md) are shipped; slices 5 (server functions) and 6 (peer replication) are design only.

| What | Where | Tests |
|---|---|---|
| Action log (RocksDB, single Writer in production; `enable_pipelined_write: true`) | `lib/ebb_server/storage/rocks_db.ex`, `writer.ex` | `test/ebb_server/storage/rocks_db_test.exs`, `writer_test.exs` |
| Entity materialization (lazy, on-demand) | `lib/ebb_server/storage/entity_store.ex`, `sqlite.ex` | `entity_store_test.exs` (~18kb), `sqlite_test.exs` |
| Permissions, Groups, GroupMembers, Relationships | `lib/ebb_server/storage/permission_checker.ex`, `group_cache.ex`, `relationship_cache.ex`, `authorization_context.ex` | `permission_checker_test.exs`, `group_cache_test.exs`, `relationship_cache_test.exs` |
| GSN watermark, dirty tracking | `lib/ebb_server/storage/watermark_tracker.ex`, `dirty_tracker.ex` | `watermark_tracker_test.exs`, `dirty_tracker_test.exs` |
| Auth plug (bypass + external modes) | `lib/ebb_server/sync/auth_plug.ex` | `auth_plug_test.exs` |
| HTTP API (handshake, catch-up, SSE, presence, writes, reads) | `lib/ebb_server/sync/router.ex` | `integration/*_test.exs` (9 files), `sync/*_test.exs` (~12 files) |
| Fan-out (watermark-gated SSE delivery) | `lib/ebb_server/sync/fan_out_router.ex`, `group_server.ex`, `sse_connection.ex` | `fan_out_router_test.exs`, `group_server_test.exs`, `sse_connection_test.exs` |
| Docker self-hosting | `ebb_server/Dockerfile` | — |

**HTTP endpoints (all live):**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sync/handshake` | Actor identity + group membership (requires `x-ebb-actor-id` header in bypass mode) |
| `GET` | `/sync/groups/:group_id?offset=N` | Paginated catch-up (returns `stream-next-offset` and `stream-up-to-date` headers) |
| `GET` | `/sync/live?groups=...&cursor=N` | Server-Sent Events stream of new actions |
| `POST` | `/sync/actions` | Write actions (msgpack body) |
| `POST` | `/sync/presence` | Broadcast ephemeral presence data on an entity |
| `GET` | `/entities/:id` | Materialized entity (requires `actor_id` query param or header) |
| `POST` | `/entities/query` | Query entities by type with optional filter/limit/offset |

See [`ebb_server/openapi.yaml`](https://github.com/ebbjs/ebbjs/blob/main/ebb_server/openapi.yaml) for the full generated OpenAPI 3.1 spec.

### `@ebbjs/core`

TypeScript foundation — schemas, HLC, MessagePack, action creation, ID generation. 97 tests pass.

```ts
import { createAction, createClock, localEvent } from "@ebbjs/core";
import { encodeSync } from "@ebbjs/core";

const clock = createClock();
const { action, hlc } = createAction({
  actorId: "user_123",
  clock,
  updates: [{
    subject_id: "todo_abc",
    subject_type: "todo",
    method: "put",
    data: { fields: { title: { value: "Buy milk", hlc: localEvent(clock) } } },
  }],
});

const bytes = encodeSync({ actions: [action] });
// POST bytes to /sync/actions as application/msgpack
```

The action will get a server-assigned `gsn` after it's accepted.

See [`packages/core/src/`](https://github.com/ebbjs/ebbjs/tree/main/packages/core/src).

### `@ebbjs/storage`

In-memory `StorageAdapter` for the client. 43 tests pass.

```ts
import { createMemoryAdapter } from "@ebbjs/storage";

const storage = createMemoryAdapter();

await storage.actions.append(action);          // append + mark dirty
const entity = await storage.entities.get(id);  // lazy materialization
const todos = await storage.entities.query("todo");
```

Composed of:
- `ActionLog` — append + query actions by entity
- `DirtyTracker` — track entities needing rematerialization, indexed by type
- `EntityStore` — materialize entities on `get`/`query` (HLC + lexicographic `update_id` tiebreak)
- `CursorStore` — per-group GSN cursors

Documented as **v1 is read-only**: write path (outbox, optimistic writes) is deferred to `@ebbjs/client`. See [`packages/storage/README.md`](https://github.com/ebbjs/ebbjs/blob/main/packages/storage/README.md).

### `@ebbjs/server` (TS)

E2E test harness — spawns the Elixir release and exposes a `seed()` helper. **Not a server runtime.**

```ts
import { startServer, seed } from "@ebbjs/server";

const server = await startServer({ dataDir: "/tmp/ebb", port: 4000 });
await seed(server.url, "actor_test", seedData);
await server.kill();
```

Currently one e2e test exists: `packages/server/src/test/e2e/sync.test.ts` (handshake after seed). More tests to come as `@ebbjs/client` is built and exercised against the real server.

## What's NOT in the repo

| Area | State | Where it's described |
|---|---|---|
| `@ebbjs/client` (sync SDK) | Stub (`export {};`) | Design: [`packages/client/docs/design/`](https://github.com/ebbjs/ebbjs/tree/main/packages/client/docs/design/) |
| `@ebbjs/react` | Not started | [`v1-target/getting-started`](/docs/v1-target/getting-started) |
| Server functions (`defineFunction`) | Not started | [`docs/ebb_server/slices/05-...`](/docs/ebb_server/slices/05-server-function-invocation) |
| Peer replication | Not started | [`docs/ebb_server/slices/06-...`](/docs/ebb_server/slices/06-peer-replication) |
| CLI tooling | Not started | — |
| Persistent client storage (SQLite/IndexedDB adapter) | Not started | `@ebbjs/storage` ships in-memory only |
| Causal-tree collaborative text | POC only | [`experiment/collaborative-text/`](https://github.com/ebbjs/ebbjs/tree/main/experiment/collaborative-text) + [devlog](https://github.com/ebbjs/ebbjs/blob/main/packages/www/src/content/devlog/how-collaborative-editing-works.mdx) |

For the marketing-facing roadmap, see [ebb.dev/#roadmap](https://ebb.dev/#roadmap). For an honest, repo-grounded roadmap, see the [GitHub README](https://github.com/ebbjs/ebbjs#current-state).