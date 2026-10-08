---
title: "Current State"
description: "What is actually in the Ebb repo today — components, endpoints, and tests."
---

> **Ebb is pre-alpha.** This page documents what's actually in the repo today. Forward-looking API surface (`defineFunction`, the server-side SDK, the CLI, and the remaining React hooks) is tracked as Epics on GitHub; see the [v1 API surface Epic](https://github.com/ebbjs/ebbjs/issues/115) and the [GitHub issues list](https://github.com/ebbjs/ebbjs/issues) for what is being designed and built.

## Current state

### Server — `ebb_server/`

An Elixir/OTP application. Single-node sync server with a complete HTTP API. See the architecture in [`ebb_server/README.md`](https://github.com/ebbjs/ebbjs/blob/main/ebb_server/README.md); slices 1–4 are shipped; slices 5 (server functions) and 6 (peer replication) are tracked as [Epic #112](https://github.com/ebbjs/ebbjs/issues/112) and [Epic #113](https://github.com/ebbjs/ebbjs/issues/113).

| What                                                                              | Where                                                                                                                 | Tests                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Action log (RocksDB, single Writer in production; `enable_pipelined_write: true`) | `lib/ebb_server/storage/rocks_db.ex`, `writer.ex`                                                                     | `test/ebb_server/storage/rocks_db_test.exs`, `writer_test.exs`                       |
| Entity materialization (lazy, on-demand)                                          | `lib/ebb_server/storage/entity_store.ex`, `sqlite.ex`                                                                 | `entity_store_test.exs` (~18kb), `sqlite_test.exs`                                   |
| Permissions, Groups, GroupMembers, Relationships                                  | `lib/ebb_server/storage/permission_checker.ex`, `group_cache.ex`, `relationship_cache.ex`, `authorization_context.ex` | `permission_checker_test.exs`, `group_cache_test.exs`, `relationship_cache_test.exs` |
| GSN watermark, dirty tracking                                                     | `lib/ebb_server/storage/watermark_tracker.ex`, `dirty_tracker.ex`                                                     | `watermark_tracker_test.exs`, `dirty_tracker_test.exs`                               |
| Writer failure policy (abandon + resolve a failed commit)                         | `lib/ebb_server/storage/writer.ex`, `watermark_tracker.ex`                                                            | `writer_failure_policy_test.exs`, `writer_failure_integration_test.exs`              |
| Auth plug (bypass + external modes)                                               | `lib/ebb_server/sync/auth_plug.ex`                                                                                    | `auth_plug_test.exs`                                                                 |
| HTTP API (handshake, catch-up, SSE, presence, writes, reads)                      | `lib/ebb_server/sync/router.ex`                                                                                       | `integration/*_test.exs` (9 files), `sync/*_test.exs` (~12 files)                    |
| Fan-out (watermark-gated SSE delivery)                                            | `lib/ebb_server/sync/fan_out_router.ex`, `group_server.ex`, `sse_connection.ex`                                       | `fan_out_router_test.exs`, `group_server_test.exs`, `sse_connection_test.exs`        |
| Docker self-hosting                                                               | `ebb_server/Dockerfile`                                                                                               | —                                                                                    |

**HTTP endpoints (all live):**

| Method | Path                              | Purpose                                                                             |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------- |
| `POST` | `/sync/handshake`                 | Actor identity + group membership (requires `x-ebb-actor-id` header in bypass mode) |
| `GET`  | `/sync/groups/:group_id?offset=N` | Paginated catch-up (returns `stream-next-offset` and `stream-up-to-date` headers)   |
| `GET`  | `/sync/live?groups=...&cursor=N`  | Server-Sent Events stream of new actions                                            |
| `POST` | `/sync/actions`                   | Write actions (msgpack body)                                                        |
| `POST` | `/sync/presence`                  | Broadcast ephemeral presence data on an entity                                      |
| `GET`  | `/entities/:id`                   | Materialized entity (requires `actor_id` query param or header)                     |
| `POST` | `/entities/query`                 | Query entities by type with optional filter/limit/offset                            |

See [`ebb_server/openapi.yaml`](https://github.com/ebbjs/ebbjs/blob/main/ebb_server/openapi.yaml) for the full generated OpenAPI 3.1 spec.

### `@ebbjs/core`

TypeScript foundation — schemas, HLC, MessagePack, action creation, ID generation. 108 tests pass.

```ts
import { createAction, createClock, localEvent } from "@ebbjs/core";
import { encodeSync } from "@ebbjs/core";

const clock = createClock();
const { action, hlc } = createAction({
  actorId: "user_123",
  clock,
  updates: [
    {
      subject_id: "todo_abc",
      subject_type: "todo",
      method: "put",
      data: { fields: { title: { value: "Buy milk", hlc: localEvent(clock) } } },
    },
  ],
});

const bytes = encodeSync({ actions: [action] });
// POST bytes to /sync/actions as application/msgpack
```

The action will get a server-assigned `gsn` after it's accepted.

See [`packages/core/src/`](https://github.com/ebbjs/ebbjs/tree/main/packages/core/src).

### `@ebbjs/storage`

Storage adapters for the client — in-memory and IndexedDB, plus a durable outbox store. 214 tests pass (1 skipped).

```ts
import { createMemoryAdapter } from "@ebbjs/storage/memory";
// or: import { createIndexedDBAdapter } from "@ebbjs/storage/indexeddb";

const storage = createMemoryAdapter();

await storage.actions.append(action); // append + mark dirty
const entity = await storage.entities.get(id); // lazy materialization
const todos = await storage.entities.query("todo");
```

Composed of:

- `ActionLog` — append + query actions by entity
- `DirtyTracker` — track entities needing rematerialization, indexed by type
- `EntityStore` — materialize entities on `get`/`query` (HLC + lexicographic `update_id` tiebreak)
- `CursorStore` — per-group GSN cursors
- `OutboxStore` — durable buffer of locally-authored Actions awaiting acknowledgement

The root `@ebbjs/storage` entry is types-only; adapter constructors live on per-adapter subpaths (`@ebbjs/storage/memory`, `@ebbjs/storage/indexeddb`) so a memory-only consumer does not pull `idb` into their bundle. The adapter covers the read path and the durable outbox; locally-produced Actions are still submitted by `@ebbjs/client`. See [`packages/storage/README.md`](https://github.com/ebbjs/ebbjs/blob/main/packages/storage/README.md).

### `@ebbjs/client`

Local-first sync SDK — handshake, catch-up, live SSE, and a typed ORM namespace over materialized entities. 575 unit tests pass, plus integration tests that round-trip against a live `ebb_server`.

```ts
import { createClient, defineEntity, defineSchema, e } from "@ebbjs/client";

const todo = defineEntity("todo", { title: e.string(), completed: e.boolean() });
const schema = defineSchema({ entities: { todo }, version: 1 });

const client = createClient({
  serverUrl: "http://localhost:4000",
  actorId: "user_123",
  schema,
});

const { groups } = await client.handshake();
await client.catchUp(groups[0].id, groups[0].cursor);

// Open the live stream; remote actions land in local storage.
client.subscribe(
  groups.map((group) => group.id),
  groups[0].cursor,
  () => {},
);

// Reactive read: fires when the matching set changes.
client.todo.subscribe({ completed: false }, (snapshot) => {
  console.log(snapshot.count, snapshot.entities);
});

// Writes go through the client's outbox seam and POST /sync/actions.
// `groups` must be passed explicitly; the SDK injects the membership rows.
const { rejected } = await client.todo.create(
  { title: "Buy milk", completed: false },
  { groups: groups.map((group) => group.id) },
);

// `toRaw()` exposes the wire envelope (including `id`).
const [row] = await client.todo.query().where("completed", false).toRaw();
if (row !== undefined) {
  await client.todo.update(row.id, { completed: true });
}
```

Shipped primitives:

- **Typed ORM namespace** — `client.<entity>.query()` / `get()` / `create()` / `update()`, plus `link` / `unlink` for relationships. Payloads are validated against the schema with TypeBox at runtime.
- **Reactive subscribe** — `client.<entity>.subscribe(filter, cb)` fires on matching-set changes; `client.onStateChange(cb)` tracks the connection state machine.
- **Presence** — `client.presence` broadcasts and reads ephemeral cursors and selections.
- **Collaborative text** — `client.textDocument(docId)` opens a causal-tree document with a local edit API and conflict events; `@ebbjs/codemirror` bridges it to a CodeMirror 6 view.

See [`packages/client/src/`](https://github.com/ebbjs/ebbjs/tree/main/packages/client/src).

### `@ebbjs/server` (TS)

E2E test harness — spawns the Elixir release and exposes a `seed()` helper. **Not a server runtime.**

```ts
import { startServer, seed } from "@ebbjs/server";

const server = await startServer({ dataDir: "/tmp/ebb", port: 4000 });
await seed(server.url, "actor_test", seedData);
await server.kill();
```

`packages/server/src/test/e2e/sync.test.ts` is the one e2e test (handshake after seed). The `@ebbjs/client` integration tests under `packages/client/src/__tests__/integration/` exercise the fuller round-trip — handshake, catch-up, write, presence, and collaborative-text edits — against a real server.

### `@ebbjs/react`

React bindings for `@ebbjs/client` — a provider, a connection hook, and the data + mutation hooks. Ships `EbbProvider`, `useClient`, `useConnection`, `useQuery`, `useEntity`, and `useEntityMutations`.

```tsx
import { EbbProvider, useClient, useEntity, useEntityMutations, useQuery } from "@ebbjs/react";

function OpenTodos() {
  const client = useClient<Schema>();
  const { data, loading, error } = useQuery(() =>
    client.todo.query().where("completed", false).limit(50),
  );

  if (loading) return <span>loading…</span>;
  if (error) return <span>{error.message}</span>;
  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}

function TodoRow({ id }: { id: string }) {
  const client = useClient<Schema>();
  const todo = useEntity(() => client.todo.get(id), [id]);
  const { update, delete: remove } = useEntityMutations(client.todo);

  if (todo === null) return <span>missing</span>;
  return (
    <div>
      <button onClick={() => void update(id, { completed: !todo.completed })}>{todo.title}</button>
      <button onClick={() => void remove(id)}>delete</button>
    </div>
  );
}
```

See [`packages/react/README.md`](https://github.com/ebbjs/ebbjs/blob/main/packages/react/README.md).

## What's NOT in the repo

| Area                                       | State       | Where it's tracked                                                                |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------- |
| Server functions (`defineFunction`)        | Not started | [Epic #112](https://github.com/ebbjs/ebbjs/issues/112)                            |
| Peer replication                           | Not started | [Epic #113](https://github.com/ebbjs/ebbjs/issues/113)                            |
| Server-side SDK (SSR / external processes) | Not started | [Epic #114](https://github.com/ebbjs/ebbjs/issues/114)                            |
| CLI tooling                                | Not started | —                                                                                 |
| Persistent client storage (SQLite adapter) | Not started | `@ebbjs/storage` ships in-memory + IndexedDB adapters; SQLite is a future adapter |

For the marketing-facing roadmap, see [ebb.dev/#roadmap](https://ebb.dev/#roadmap). For an honest, repo-grounded roadmap, see the [GitHub README](https://github.com/ebbjs/ebbjs#current-state).
