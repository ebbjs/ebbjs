# Phase 8: Wiring

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 2](02-rocksdb-store.md), [Phase 3](03-sqlite-store.md), [Phase 4](04-system-cache.md), [Phase 5](05-writer.md), [Phase 7](07-http-api.md)
> **Produces:** `EbbServer.Storage.Supervisor` and a fully-wired `EbbServer.Application` that starts the complete system

---

## Task 20. Storage Supervisor

**Files:** `ebb_server/lib/ebb_server/storage/supervisor.ex` (create)

Create `EbbServer.Storage.Supervisor`:

- `use Supervisor`
- `start_link/1` accepts opts, calls `Supervisor.start_link(__MODULE__, opts, name: __MODULE__)`
- `init/1`:
  - `data_dir = Application.get_env(:ebb_server, :data_dir, "./data")`
  - Children (in order — `rest_for_one` strategy):
    1. `{EbbServer.Storage.RocksDB, data_dir: data_dir}`
    2. `{EbbServer.Storage.SQLite, data_dir: data_dir}`
    3. `{EbbServer.Storage.SystemCache, []}`
    4. `{EbbServer.Storage.Writer, []}`
  - `Supervisor.init(children, strategy: :rest_for_one)`

**Note:** EntityStore is a module (not a GenServer), so it's not in the supervision tree.

The `rest_for_one` strategy ensures that if RocksDB crashes, everything downstream restarts in order. This is critical for correctness — SystemCache and Writer depend on RocksDB being open.

---

## Task 21. Wire Application module with HTTP server

**Files:** `ebb_server/lib/ebb_server/application.ex` (modify)

Update `EbbServer.Application.start/2` to start:

1. `EbbServer.Storage.Supervisor` (starts RocksDB → SQLite → SystemCache → Writer)
2. `{Plug.Cowboy, plug: EbbServer.Sync.Router, scheme: :http, port: port}` where `port = Application.get_env(:ebb_server, :port, 4000)`

Children list:
```elixir
[
  EbbServer.Storage.Supervisor,
  {Plug.Cowboy, plug: EbbServer.Sync.Router, scheme: :http, port: port}
]
```

Supervisor options: `strategy: :one_for_one, name: EbbServer.Supervisor`

---

## Verification

```bash
cd ebb_server && mix run --no-halt
```

The server starts without errors, listening on port 4000. RocksDB and SQLite databases are created in `./data/`. You can hit endpoints manually:

```bash
curl http://localhost:4000/nonexistent
# Expect: 404

curl http://localhost:4000/entities/foo?actor_id=a_test
# Expect: 404 {"error":"not_found"}
```
