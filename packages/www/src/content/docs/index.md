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
| Docker self-hosting                                                               | `ebb_server/Dockerfile`, `compose.yaml`, `docs/self-hosting.md`                                                       | `scripts/docker-smoke-test.sh` (CI `docker-image` job)                               |

**HTTP endpoints (all live):**

| Method | Path                              | Purpose                                                                                         |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                        | Readiness probe — `200` once the storage supervisor is up, `503` before then (no auth required) |
| `POST` | `/sync/handshake`                 | Actor identity + group membership (requires `x-ebb-actor-id` header in bypass mode)             |
| `GET`  | `/sync/groups/:group_id?offset=N` | Paginated catch-up (returns `stream-next-offset` and `stream-up-to-date` headers)               |
| `GET`  | `/sync/live?groups=...&cursor=N`  | Server-Sent Events stream of new actions                                                        |
| `POST` | `/sync/actions`                   | Write actions (msgpack body)                                                                    |
| `POST` | `/sync/presence`                  | Broadcast ephemeral presence data on an entity                                                  |
| `GET`  | `/entities/:id`                   | Materialized entity (requires `actor_id` query param or header)                                 |
| `POST` | `/entities/query`                 | Query entities by type with optional filter/limit/offset                                        |

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

Local-first sync SDK — handshake, catch-up, live SSE, and a local query engine over a materialized replica. Reads are typed queries through `client.<entity>.query()`; writes are actions mounted as `client.actions.<name>`. 1119 unit tests pass, plus integration tests that round-trip against a live `ebb_server`.

```ts
import { createClient, defineAction, defineEntity, defineSchema, e } from "@ebbjs/client";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  // Read-time only: absence reads as "normal"; no write fills it.
  priority: e.string().default("normal"),
});
const schema = defineSchema({ entities: { todo }, version: 1 });

// Declared at module scope; the client mounts it as `client.actions.*`.
const createTodo = defineAction(
  schema,
  ({ todo }, params: { title: string; groups: readonly string[] }) =>
    todo.create({ title: params.title, completed: false }, { groups: params.groups }),
);
const completeTodo = defineAction(schema, ({ todo }, params: { id: string }) =>
  todo.update(params.id, { completed: true }),
);

const client = createClient({
  serverUrl: "http://localhost:4000",
  actorId: "user_123",
  schema,
  actions: { createTodo, completeTodo },
});

const { groups } = await client.handshake();
const groupIds = groups.map((group) => group.id);

// Open the live stream; `subscribe` catches up from the cursors cached by
// `handshake()` before streaming, so no explicit cursor is needed.
client.subscribe(groupIds, () => {});

// Reads: a typed chain per collection. Await it for a snapshot, or take
// `.result()` / `useQuery` for the cached, reactive result. Each query row
// carries the entity `id` and its live `groupIds`.
const open = await client.todo.query().where("completed", false);

// Writes: an action. One call is one Action, `groups` files the row into its
// groups in that same Action, and the returned handle carries the minted id.
const { id } = await client.actions.createTodo({ title: "Buy milk", groups: groupIds });
await client.actions.completeTodo({ id });
```

Shipped primitives:

- **Query engine** — `client.<entity>.query()` with `where` / `or` / `orderBy` / `limit` and one-level `with` joins. A chain lowers to a serializable query, so an identical chain shares one cached result; `status` is `unloaded` / `stale` / `current` / `failed`. In React, `useQuery` wraps this surface. Fields may declare a read-time `.default()`; a `null` filter value asks for "no live value" — see [Absence and defaults](/docs/absence-and-defaults).
- **Schema-bound entity namespaces** — `client.<entity>` is the read API: `query()` for typed reads over the replica. Every write is a `defineAction` declared at module scope and mounted as `client.actions.<name>`; one call commits one Action spanning any number of entities and groups, and a rejection throws `ActionRejectedError`. `get()`, the async row accessors, and `subscribe(filter, cb)` are internal.
- **Reactive subscribe** — `client.onStateChange(cb)` tracks the connection state machine; live sync runs through `client.subscribe(groupIds, onEvent)`.
- **Presence** — `client.presence` broadcasts and reads ephemeral cursors and selections.
- **Collaborative text** — `client.textDocument(docId)` opens a causal-tree document with a local edit API; `@ebbjs/codemirror` bridges it to a CodeMirror 6 view. Writes that race while offline surface through [`client.conflicts`](/docs/conflicts).

See [`packages/client/src/`](https://github.com/ebbjs/ebbjs/tree/main/packages/client/src).

### `@ebbjs/testing` (TS)

E2E test harness — spawns the Elixir release and exposes a `seed()` helper. **Not a server runtime.**

```ts
import { startServer, seed } from "@ebbjs/testing";

const server = await startServer({ dataDir: "/tmp/ebb", port: 4000 });
await seed(server.url, "actor_test", seedData);
await server.kill();
```

`packages/testing/src/test/e2e/sync.test.ts` is the one e2e test (handshake after seed). The `@ebbjs/client` integration tests under `packages/client/src/__tests__/integration/` exercise the fuller round-trip — handshake, catch-up, write, presence, and collaborative-text edits — against a real server.

### `@ebbjs/react`

React bindings for `@ebbjs/client` — a provider, a connection hook, the query hooks, the presence hook, and the sync-state hooks, plus `useClient` for actions. Ships `EbbProvider`, `useClient`, `useConnection`, `useQuery`, `usePresence`, `useOutbox`, `useConflicts`, `useEbbStatus`, `useSyncObservable`, and `createEbbHooks` (which binds `useClient`, `useQuery`, `usePresence`, and the sync-state hooks to one client type). `useQuery` is the read root, `usePresence` reads the peers on one presence channel of an entity, `useClient` exposes `client.actions`, and the sync-state hooks are read-only.

```tsx
import { createClient, defineAction } from "@ebbjs/client";
import { EbbProvider, createEbbHooks } from "@ebbjs/react";

// Writes are actions: declared once at module scope, mounted on the client.
const toggleTodo = defineAction(schema, ({ todo }, params: { id: string; completed: boolean }) =>
  todo.update(params.id, { completed: params.completed }),
);
const removeTodo = defineAction(schema, ({ todo }, params: { id: string }) =>
  todo.delete(params.id),
);
const todoActions = { toggleTodo, removeTodo };

const client = createClient({ serverUrl, actorId, schema, actions: todoActions });

// The client's own type, reads and actions together — no library types to
// import. Bind the hooks to it once: components then need no generic and no
// callback annotation.
type TodoClient = typeof client;
export const { useClient: useEbb, useQuery } = createEbbHooks<TodoClient>();

function OpenTodos() {
  const { data, status, loading, error } = useQuery((q) =>
    q.todo.query().where("completed", false).limit(50),
  );

  if (loading) return <span>loading…</span>;
  if (error) return <span>{error.message}</span>;
  return (
    <ul data-status={status}>
      {(data ?? []).map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}

function TodoRow({ id }: { id: string }) {
  const client = useEbb();
  const { data: todos, status } = useQuery((q) => q.todo.query());
  const todo = todos?.find((row) => row.id === id);

  if (status === "unloaded") return <span>loading…</span>;
  if (todo === undefined) return <span>missing</span>;
  return (
    <div>
      <button onClick={() => void client.actions.toggleTodo({ id, completed: !todo.completed })}>
        {todo.title}
      </button>
      <button onClick={() => void client.actions.removeTodo({ id })}>delete</button>
    </div>
  );
}
```

`useQuery` builds one chain and subscribes to its cached result. The grammar is
the engine's: `where` / `or` / `orderBy(field, "asc" | "desc")` / `limit(n)`,
plus one-level `with` joins typed by the schema's relationship map.

```tsx
// Joined rows: `issue.assignee` is typed from the relationship.
useQuery((q) => q.issue.query().where("status", "open").with({ assignee: true }));
```

The bound hook types `q` for you. The free `useQuery` from `@ebbjs/react` is the
same hook unbound: annotate its `q` with the schema
(`(q: QueryRoot<Schema>) => …`) and omit the type arguments — a type argument
instead of the annotation would pin the rows to their defaults, because
TypeScript does not partially infer type arguments.

`status` is `unloaded` (never run; `data` is `undefined`, never `[]`), `stale` (a
usable result at an older revision while a re-run is in flight), `current`, or
`failed` (sticky until a run succeeds). `loading` is true only while no result
exists yet, and `error` mirrors `failed`. A cached remount renders the held
result immediately with `status: "current"` when it matches the replica's
revision (`"stale"` when the replica has moved on), so there is no loading flash.

Windowing is `limit(n)` only — cursor pagination is deferred. There is no `id`
predicate, so a single row is a collection query plus `find`. On-demand document
bodies are not a query yet ([#500](https://github.com/ebbjs/ebbjs/issues/500)).

See [`packages/react/README.md`](https://github.com/ebbjs/ebbjs/blob/main/packages/react/README.md).

## What's NOT in the repo

| Area                                       | State       | Where it's tracked                                                                                  |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------- |
| Server functions (`defineFunction`)        | Not started | [Epic #112](https://github.com/ebbjs/ebbjs/issues/112)                                              |
| Peer replication                           | Not started | [Epic #113](https://github.com/ebbjs/ebbjs/issues/113)                                              |
| Server-side SDK (SSR / external processes) | Not started | [Epic #114](https://github.com/ebbjs/ebbjs/issues/114)                                              |
| CLI tooling                                | Not started | —                                                                                                   |
| Persistent client storage (SQLite adapter) | Not started | `@ebbjs/storage` ships in-memory + IndexedDB adapters; SQLite is a future adapter                   |
| Cursor-paginated queries                   | Not started | `limit(n)` only; deferred past the query engine ([#495](https://github.com/ebbjs/ebbjs/issues/495)) |
| On-demand document bodies as queries       | Not started | [#500](https://github.com/ebbjs/ebbjs/issues/500); use `client.textDocument(id)` for now            |

For the marketing-facing roadmap, see [ebb.dev/#roadmap](https://ebb.dev/#roadmap). For an honest, repo-grounded roadmap, see the [GitHub README](https://github.com/ebbjs/ebbjs#current-state).
