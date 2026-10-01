---
title: "An IndexedDB StorageAdapter"
description: "Adding a persistent web-tier storage adapter to ebbjs, with shared tests and a memory-vs-IDB benchmark."
date: 2026-09-25
---

The original `@ebbjs/storage` shipped a single `StorageAdapter`: the in-memory implementation. It works, but it forgets everything on page reload. For a collaborative app that has to work offline, that's not enough — we need a persistent adapter on the web.

This post covers the new `IndexedDBAdapter` (issue [#145](https://github.com/ebbjs/ebbjs/issues/145)) and the per-operation numbers that fell out of the work.

## The interface stays the same

The `StorageAdapter` interface (`actions`, `entities`, `dirtyTracker`, `cursors`, `isDirty`, `reset`) didn't change. Every adapter — memory, IndexedDB, and the eventual SQLite one — implements the same shape. The reasoning behind the four-store split is in the existing devlog; the takeaway for this post is that any new adapter has to materialize entities from the action log on demand, mark dirty entities for re-materialization, and expose a cursor store for sync resumption.

## One test suite, every adapter

To stop adapters from drifting apart, I extracted the existing per-component tests into shared test suites under `packages/storage/src/testing/`. Each suite — `defineActionLogTests`, `defineCursorStoreTests`, `defineDirtyTrackerTests`, `defineEntityStoreTests`, `defineAdapterTests` — takes a `factory` callback and runs the same `describe`/`it` assertions against whatever the callback returns.

The memory adapter's tests became a 5-line wrapper:

```ts
import { defineAdapterTests } from "../testing/adapter.test-suite";
import { createMemoryAdapter } from "./memory-adapter";

defineAdapterTests({
  name: "Memory",
  factory: () => createMemoryAdapter(),
});
```

The IndexedDB adapter's test is structurally identical, with a `factory` that opens a fresh uniquely-named DB on every invocation. Both adapters run against the **same** 23-test suite, so any divergence in semantics will surface as a test failure on one side.

This pays off later: the SQLite adapter (#146) gets the same suite for free.

Shared fixtures (`buildPutAction`, `buildPatchAction`) live in `packages/storage/src/testing/fixtures.ts` so each suite focuses on assertions rather than re-building the same Action shapes.

## The IndexedDB adapter

`createIndexedDBAdapter()` opens a single database with four object stores:

| Store      | Key              | Indexes      | Purpose                    |
| ---------- | ---------------- | ------------ | -------------------------- |
| `actions`  | `id` (Action.id) | —            | Source-of-truth action log |
| `entities` | `id` (entityId)  | `type`       | Materialized entity cache  |
| `dirty`    | `entityId`       | `entityType` | Re-materialization set     |
| `cursors`  | `groupId`        | —            | Per-group GSN cursors      |

Store creation is centralized in `packages/storage/src/indexeddb/schema.ts` (`createEbbStores`) so the production `upgrade` callback and the per-test `openTestDb` helper share one definition.

Merge semantics (LWW, BigInt HLC handling, the `data.fields` envelope unwrap) are extracted to `packages/storage/src/internal/materialize.ts` so the in-memory and IndexedDB adapters share one materializer — they cannot drift.

`createStorageAdapter()` — new — selects an adapter based on the runtime:

```ts
const adapter = await createStorageAdapter();
// → IndexedDBAdapter on web
// → MemoryAdapter on the server / Node tests
```

`prefer` overrides if you want to force one:

```ts
await createStorageAdapter({ prefer: "memory" }); // always memory
await createStorageAdapter({ prefer: "indexeddb" }); // always IndexedDB
await createStorageAdapter(); // auto (default)
```

The factory is async because `createIndexedDBAdapter` opens a database connection. `await` it even when you know you're on the in-memory adapter.

## The benchmark

`pnpm --filter @ebbjs/storage benchmark` runs four operations (append, get, query, reset) against both adapters on a 1000-action, 100-entity workload. To reproduce:

```sh
cd packages/storage
pnpm benchmark
```

The benchmark installs `fake-indexeddb` on `globalThis` so it can exercise the IndexedDB code paths from Node. Real-browser IDB will likely run faster because the browser's IDB implementation is native and avoids the JS-to-shim boundary.

Output from a developer machine (your numbers will vary):

| Adapter   | append (ops/sec) | get (ops/sec) | query (ops/sec) | reset (ms) |
| --------- | ---------------: | ------------: | --------------: | ---------: |
| Memory    |           67,894 |         9,865 |          18,902 |       0.03 |
| IndexedDB |            4,269 |           799 |             652 |       1.88 |

A few honest reads:

- **append** — the IndexedDB adapter is ~16× slower. Each action is two awaits (`db.put(actions, action)`, then `dirtyTracker.mark()`), and the action log now also denormalizes a `subject_ids[]` array so the secondary index has something to key on. The in-memory path is one synchronous mutation. That's the structural cost of a per-write transaction.
- **get / query** — the gap is ~12–30×, down from ~80–150× before the `subject_id` index landed. `getForEntity` now range-scans the `subject_id` multiEntry index (one index entry per unique subject an action touches) instead of full-table-scanning the action log. The result set is still sorted in-memory by gsn to match the in-memory adapter's contract, so per-entity ordering is preserved. After the first read, subsequent gets come from the materialized cache (still true in IDB) — the cost above is the _cold-materialize_ path.
- **reset** — sub-millisecond on both, but IDB is ~63× slower because clearing a store is still an IDB transaction.

Followed up from the initial numbers in this post via issue #202 (add the `subject_id` index) and #204 (consolidate relationship writes).

## What I'd consider next

If `append` becomes a hot path (long-running offline sessions with thousands of actions queued), the next move is a **batched-append** API: take an array of actions and write them in one transaction. That's a tiny interface change and would close most of the append gap.

Multi-tab coordination is still out of scope. Single-tab ownership is acceptable for v1; multi-tab is a follow-up.
