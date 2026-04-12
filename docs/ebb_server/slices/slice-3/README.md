# Slice 3: Live Sync Infrastructure

## Summary

Before the live sync endpoints (catch-up, SSE subscription, presence) can be built, three foundational pieces must be in place: a `range_iterator` on RocksDB for GSN-ordered reads, the Fan-Out infrastructure (FanOutRouter, GroupServer, SSEConnection), and integration of the Writer with the Fan-Out notification system.

These components form a distinct vertical slice within Slice 3 -- they are the prerequisite engine that powers the live sync feature but have no HTTP interface of their own.

## Components

| #   | Component                                                      | File                                    | Purpose                                                       |
| --- | -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| 0   | [Sync Infrastructure](00-sync-infrastructure.md)               | `lib/ebb_server/sync/`                  | Registry, supervisors, and process naming                     |
| 1   | [SSEConnection](01-sse-connection.md)                          | `lib/ebb_server/sync/sse_connection.ex` | SSE stream writer, keepalive, client disconnect handling      |
| 2   | [GroupServer](02-group-server.md)                              | `lib/ebb_server/sync/group_server.ex`   | Per-Group subscriber management, Action push                  |
| 3   | [FanOutRouter](03-fan-out-router.md)                           | `lib/ebb_server/sync/fan_out_router.ex` | Batch notification ingestion, watermark gating, Group routing |
| 4   | [Writer → FanOut integration](04-writer-fanout-integration.md) | `lib/ebb_server/storage/writer.ex`      | Post-commit watermark update + FanOut notification            |
| -   | [RocksDB range_iterator](prereq-range-iterator.md)             | `lib/ebb_server/storage/rocks_db.ex`    | GSN-range reads for catch-up and fan-out (already exists)     |

## Build Order

These components must be built in this order:

0. **Sync Infrastructure** -- Registry, Sync.Supervisor, GroupDynamicSupervisor, SSEConnectionSupervisor
1. **SSEConnection** -- SSE stream writer with keepalive. No sync infra dependencies. Testable standalone.
2. **GroupServer** -- Per-Group subscriber set, push_actions to SSEConnection, monitor subscribers, self-stop when empty.
3. **FanOutRouter** -- GenServer owning watermark-gated delivery logic. Reads from RocksDB, dispatches to GroupServer.
4. **Writer → FanOut integration** -- After `write_batch` succeeds, call `WatermarkTracker.mark_range_committed/2`, `advance_watermark/0`, then `send(FanOutRouter, {:batch_committed, ...})`.

## Dependencies

```
SSEConnection ──→ GroupServer ──→ FanOutRouter ──→ Writer
                                                    ↑
                                         WatermarkTracker

RocksDB ──────────────────────────→ FanOutRouter (range_iterator reads)
        ↘
          → GroupServer (SSEConnection reads Action payloads for subscriber catch-up)
```

Note: `RocksDB.range_iterator/3` already exists and is not part of the build order.

## Supervision Tree

```
EbbServer.Supervisor
├── EbbServer.Storage.Supervisor
│   ├── RocksDB
│   ├── SQLite
│   ├── SystemCache
│   ├── WatermarkTracker
│   ├── EbbServer.Sync.Supervisor
│   │   ├── FanOutRouter
│   │   ├── GroupDynamicSupervisor
│   │   │   └── GroupServer (transient, one per active Group)
│   │   └── SSEConnectionSupervisor
│   │       └── SSEConnection (temporary, one per client)
│   └── Writer
```

## Acceptance Criteria

- [ ] SSEConnection writes events in correct SSE format (`event: data\ndata: ...\n\n`)
- [ ] SSEConnection sends keepalive comments every 15 seconds
- [ ] GroupServer maintains subscriber set and pushes Actions to all subscribers
- [ ] GroupServer monitors subscriber pids and removes on DOWN
- [ ] GroupServer stops itself when subscriber set is empty
- [ ] FanOutRouter receives `{:batch_committed, from, to}` and dispatches to correct GroupServer
- [ ] FanOutRouter gates delivery on `WatermarkTracker.committed_watermark/0`
- [ ] Writer calls `mark_range_committed` + `advance_watermark` + sends to FanOutRouter after each commit
