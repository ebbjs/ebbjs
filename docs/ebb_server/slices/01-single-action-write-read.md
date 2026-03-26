# Slice 1: Single Action Write + Read-Back

## Goal

A client can POST an Action containing a single entity PUT to the server, receive a durable acknowledgment, and then GET the materialized entity back with the correct field values.

## Components Involved

| Component | Interface Subset Used |
|-----------|----------------------|
| [RocksDB Store](../components/rocksdb-store.md) | `start_link/1`, `write_batch/1`, `get/2`, `prefix_iterator/2`, key encoding functions |
| [SQLite Store](../components/sqlite-store.md) | `start_link/1`, `upsert_entity/1`, `get_entity/1` |
| [System Cache](../components/system-cache.md) | `start_link/1`, `claim_gsn_range/1`, `mark_dirty_batch/1`, `is_dirty?/1`, `clear_dirty/1` |
| [Writer](../components/writer.md) | `start_link/1`, `write_actions/2` (single Writer only -- no WriterRouter yet) |
| [Entity Store](../components/entity-store.md) | `get/2`, `materialize/1` |
| [HTTP API](../components/http-api.md) | `POST /sync/actions`, `GET /entities/:id` (no auth -- hardcoded actor for this slice) |

## Flow

1. **Client sends Action via HTTP.** `POST /sync/actions` with a MessagePack body containing one Action with one PUT Update for a new entity (e.g., `todo_abc123` with `{title: "Buy milk", completed: false}`).

2. **HTTP handler decodes and delegates.** The router decodes the MessagePack body into an Elixir map. In this slice, permission checking is skipped (hardcoded allow-all). The handler calls `Writer.write_actions/2` directly (no WriterRouter -- single Writer).

3. **Writer processes the Action.** Since this is the only Action, it flushes immediately (no batching needed for a single Action under low load):
   - Claims GSN 1 via `SystemCache.claim_gsn_range(1)` → `{1, 1}`
   - Encodes the Action and Update to ETF via `:erlang.term_to_binary/1`
   - Builds WriteBatch with entries in all 5 column families:
     - `cf_actions`: `<<1::64-big>>` → Action ETF
     - `cf_updates`: `<<action_id, update_id>>` → Update ETF
     - `cf_entity_actions`: `<<todo_abc123, 1::64-big>>` → action_id
     - `cf_type_entities`: `<<"todo", "todo_abc123">>` → `<<>>`
     - `cf_action_dedup`: `<<action_id>>` → `<<1::64-big>>`
   - Commits with `sync: true`
   - Calls `SystemCache.mark_dirty_batch(["todo_abc123"])`
   - (No system entity cache updates -- this is a user entity)
   - Advances watermark to 1
   - (No fan-out notification -- Fan-Out not built yet)
   - Replies `{:ok, {1, 1}}` to the HTTP handler

4. **HTTP handler responds.** Returns `200 {"rejected": []}` to the client.

5. **Client reads entity via HTTP.** `GET /entities/todo_abc123?actor_id=test_actor`

6. **HTTP handler delegates to Entity Store.** Calls `EntityStore.get("todo_abc123", "test_actor")`.

7. **Entity Store materializes.** 
   - Checks `SystemCache.is_dirty?("todo_abc123")` → `true`
   - Calls `SQLite.get_entity_last_gsn("todo_abc123")` → `:not_found` (first materialization)
   - Iterates `cf_entity_actions` with prefix `"todo_abc123"` → finds `{<<todo_abc123, 1::64-big>>, action_id}`
   - Reads Update from `cf_updates` → decodes ETF → gets the PUT data
   - Since method is PUT, sets entity data to the Update's data field
   - Calls `SQLite.upsert_entity(%{id: "todo_abc123", type: "todo", data: "{...}", last_gsn: 1, ...})`
   - Calls `SystemCache.clear_dirty("todo_abc123")`
   - Returns the entity

8. **HTTP handler responds.** Returns `200` with JSON entity: `{"id": "todo_abc123", "type": "todo", "data": {"fields": {"title": {"type": "lww", "value": "Buy milk", ...}, ...}}, ...}`

## Acceptance Criteria

- [ ] `POST /sync/actions` with a valid Action returns `200 {"rejected": []}`
- [ ] The Action is durable in RocksDB (survives process restart)
- [ ] `GET /entities/todo_abc123` returns the entity with correct field values
- [ ] The entity is cached in SQLite after first read (second read does not hit RocksDB)
- [ ] The dirty bit is cleared after materialization
- [ ] A second `GET` for the same entity returns the same data without re-materializing
- [ ] GSN is assigned as 1 (first Action in the system)
- [ ] ETF encoding/decoding round-trips correctly (no data loss)

## Build Order

1. **Scaffold the Mix project.** `mix.exs` with dependencies (`rocksdb`, `exqlite`, `msgpax`, `plug_cowboy`, `jason`, `nanoid`). `config/config.exs` with `:data_dir` and `:port`. `EbbServer.Application` with the supervision tree skeleton.

2. **Build RocksDB Store.** `EbbServer.Storage.RocksDB` GenServer -- open database, create 5 column families, store references in `:persistent_term`. Implement key encoding functions. Implement `write_batch/1` and `get/2`. Write unit tests: open/close, write/read round-trip, key encoding correctness.

3. **Build SQLite Store.** `EbbServer.Storage.SQLite` GenServer -- open database, run DDL (entities table only for this slice). Implement `upsert_entity/1`, `get_entity/1`, `get_entity_last_gsn/1`. Write unit tests: DDL runs, upsert/get round-trip.

4. **Build System Cache (minimal).** `EbbServer.Storage.SystemCache` GenServer -- create `dirty_set` ETS table and GSN `:atomics`. Implement `claim_gsn_range/1`, `mark_dirty_batch/1`, `is_dirty?/1`, `clear_dirty/1`. Skip startup population (no system entities yet). Skip watermark (single Writer). Write unit tests: GSN claiming, dirty set operations.

5. **Build Writer (single instance, no batching).** `EbbServer.Storage.Writer` GenServer -- receive Actions via `handle_call`, claim GSN, encode ETF, build WriteBatch, commit, mark dirty, reply. No batching timer for this slice (flush immediately). Write unit tests: write an Action, verify RocksDB contents, verify dirty set.

6. **Build Entity Store (get only).** `EbbServer.Storage.EntityStore` -- implement `get/2` with dirty check → RocksDB read → LWW merge → SQLite upsert → clear dirty. Only LWW merge for this slice (counter and CRDT deferred). Write unit tests: materialize a PUT, verify SQLite contents, verify dirty bit cleared, verify second read is clean.

7. **Build HTTP endpoints (minimal).** `EbbServer.Sync.Router` with `POST /sync/actions` (decode MessagePack, skip auth, skip permission check, call Writer) and `GET /entities/:id` (call Entity Store, encode JSON). No auth plug for this slice.

8. **Integration test the full flow.** HTTP client → POST Action → GET entity → verify response. This is the end-to-end acceptance test for Slice 1.

9. **Wire up the supervision tree.** `EbbServer.Storage.Supervisor` starts RocksDB Store → SQLite Store → System Cache → Writer → Entity Store in `rest_for_one` order. Verify the full application starts and the integration test passes.
