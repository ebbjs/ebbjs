# Slice 3 Prerequisites: Live Sync Infrastructure

## Summary

Before the live sync endpoints (catch-up, SSE subscription, presence) can be built, three foundational pieces must be in place: a `range_iterator` on RocksDB for GSN-ordered reads, the Fan-Out infrastructure (FanOutRouter, GroupServer, SSEConnection), and integration of the Writer with the Fan-Out notification system.

These components form a distinct vertical slice within Slice 3 -- they are the prerequisite engine that powers the live sync feature but have no HTTP interface of their own.

## Components

| Component                                                      | File                                    | Purpose                                                       |
| -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| [RocksDB range_iterator](01-range-iterator.md)                 | `lib/ebb_server/storage/rocks_db.ex`    | GSN-range reads for catch-up and fan-out                      |
| [FanOutRouter](02-fan-out-router.md)                           | `lib/ebb_server/sync/fan_out_router.ex` | Batch notification ingestion, watermark gating, Group routing |
| [GroupServer](03-group-server.md)                              | `lib/ebb_server/sync/group_server.ex`   | Per-Group subscriber management, Action push                  |
| [SSEConnection](04-sse-connection.md)                          | `lib/ebb_server/sync/sse_connection.ex` | SSE stream writer, keepalive, client disconnect handling      |
| [Writer → FanOut integration](05-writer-fanout-integration.md) | `lib/ebb_server/storage/writer.ex`      | Post-commit watermark update + FanOut notification            |

## Build Order

These five components must be built in this order:

1. **`range_iterator/3`** -- Add the method to `RocksDB`. Tests can use a simple iteration over encoded GSN keys.
2. **FanOutRouter** -- GenServer owning watermark-gated delivery logic. Stub the GroupServer lookup for now.
3. **GroupServer** -- Per-Group subscriber set, push_actions, monitor subscribers, self-stop when empty.
4. **SSEConnection** -- Cowboy-chunked connection process. Receives action/control/presence messages, writes SSE format.
5. **Writer → FanOut integration** -- After `write_batch` succeeds, call `WatermarkTracker.mark_range_committed/2`, `advance_watermark/0`, then `send(FanOutRouter, {:batch_committed, ...})`.

## Dependencies

```
WatermarkTracker (already exists)
       ↑
Writer ──────────────────────────────→ FanOutRouter
                                           ↓
                                    GroupServer
                                           ↓
                                    SSEConnection

RocksDB ──────────────────────────────→ FanOutRouter (range_iterator reads)
       ↘
         → GroupServer (SSEConnection reads Action payloads)
```

## Supervision Tree

```
EbbServer.Supervisor
└── Sync Supervisor (one_for_one)
    ├── FanOutRouter
    ├── GroupDynamicSupervisor
    │   └── GroupServer (transient, one per active Group)
    └── SSEConnectionSupervisor
        └── SSEConnection (temporary, one per client)
```

## Acceptance Criteria

- [ ] `RocksDB.range_iterator/3` returns a lazy stream of `{key, value}` pairs in `[from_key, to_key)`
- [ ] FanOutRouter receives `{:batch_committed, from, to}` and dispatches to correct GroupServer
- [ ] FanOutRouter gates delivery on `WatermarkTracker.committed_watermark/0`
- [ ] GroupServer maintains subscriber set and pushes Actions to all subscribers
- [ ] GroupServer monitors subscriber pids and removes on DOWN
- [ ] GroupServer stops itself when subscriber set is empty
- [ ] SSEConnection writes events in correct SSE format (`event: data\ndata: ...\n\n`)
- [ ] SSEConnection sends keepalive comments every 15 seconds
- [ ] Writer calls `mark_range_committed` + `advance_watermark` + sends to FanOutRouter after each commit
