# Slice 4: Multi-Writer Concurrent Writes

## Goal

Two Writer GenServers process Actions concurrently against a shared RocksDB instance with pipelined writes, and the committed GSN watermark ensures Actions are delivered to SSE subscribers in correct GSN order despite out-of-order commits.

## Components Involved

| Component | Interface Subset Used |
|-----------|----------------------|
| [Writer](../components/writer.md) | 2 instances + `WriterRouter.route_write/1` + batching (10ms timer / 1000 max) |
| [System Cache](../components/system-cache.md) | `claim_gsn_range/1` (concurrent from 2 Writers), `mark_range_committed/2`, `advance_watermark/0`, `committed_watermark/0` |
| [RocksDB Store](../components/rocksdb-store.md) | Concurrent `write_batch/1` from 2 Writers |
| [Fan-Out](../components/fan-out.md) | Watermark-gated delivery -- buffer out-of-order notifications, push in order |
| [HTTP API](../components/http-api.md) | `POST /sync/actions` routed through WriterRouter |

## Flow

### Scenario: Out-of-Order Commit with Correct Delivery

1. **Two clients send Actions concurrently.** Client A and Client B each POST an Action at roughly the same time.

2. **WriterRouter routes.** Client A's Action → Writer 1, Client B's Action → Writer 2 (round-robin).

3. **Both Writers claim GSN ranges concurrently.**
   - Writer 1: `SystemCache.claim_gsn_range(1)` → `{1, 1}` (GSN 1)
   - Writer 2: `SystemCache.claim_gsn_range(1)` → `{2, 2}` (GSN 2)
   - Both calls are lock-free (`:atomics.add_get`)

4. **Writer 2 commits first.** (Due to scheduling, smaller payload, etc.)
   - `RocksDB.write_batch(...)` with `sync: true` → durable
   - `SystemCache.mark_range_committed(2, 2)`
   - `SystemCache.advance_watermark()` → watermark stays at 0 (GSN 1 not yet committed)
   - Sends `{:batch_committed, 2, 2}` to Fan-Out Router
   - Replies `{:ok, {2, 2}}` to Client B's HTTP handler

5. **Fan-Out Router receives notification but buffers.** Checks `committed_watermark()` → 0. GSN 2 is not contiguous with watermark. Buffers `{2, 2}`.

6. **Writer 1 commits.** 
   - `RocksDB.write_batch(...)` with `sync: true` → durable
   - `SystemCache.mark_range_committed(1, 1)`
   - `SystemCache.advance_watermark()` → watermark advances to 2 (both GSNs 1 and 2 are committed)
   - Sends `{:batch_committed, 1, 1}` to Fan-Out Router
   - Replies `{:ok, {1, 1}}` to Client A's HTTP handler

7. **Fan-Out Router pushes in order.** Checks `committed_watermark()` → 2. Both `{1, 1}` and `{2, 2}` are now pushable. Reads Actions for GSNs 1-2 from RocksDB, routes to Group GenServers in GSN order.

8. **SSE subscribers receive Actions 1, then 2.** Correct order despite Writer 2 committing before Writer 1.

### Scenario: Batch Accumulation Under Load

9. **High-throughput burst.** 500 Actions arrive in 5ms.

10. **WriterRouter distributes.** ~250 Actions to Writer 1, ~250 to Writer 2.

11. **Each Writer batches.** First Action starts the 10ms timer. Subsequent Actions buffer. At 10ms (or 1000 Actions), the batch flushes.

12. **Writer 1 claims GSNs 1-250, Writer 2 claims GSNs 251-500.** Both build WriteBatches and commit concurrently. RocksDB's `enable_pipelined_write` overlaps WAL and memtable writes.

13. **Watermark advances.** Whichever Writer commits second triggers the watermark to advance to 500 (both ranges contiguous).

14. **Fan-Out pushes GSNs 1-500 in order.**

## Acceptance Criteria

- [ ] Two Writer GenServers start and process Actions concurrently
- [ ] WriterRouter distributes Actions across both Writers
- [ ] GSN assignment is gap-free (no missing GSNs) under concurrent claiming
- [ ] GSN assignment is unique (no duplicate GSNs)
- [ ] Out-of-order commits do not cause out-of-order SSE delivery
- [ ] Committed watermark correctly tracks the contiguous committed frontier
- [ ] Fan-Out buffers notifications until the watermark allows delivery
- [ ] Under sustained load, both Writers achieve near-linear scaling (~1.8-1.9x single-writer throughput)
- [ ] Batch timer (10ms) and batch size limit (1000) work correctly
- [ ] Low-load optimization: single Action flushes immediately (no 10ms wait)
- [ ] Writer crash and restart (via supervisor) does not lose committed data or corrupt GSN sequence

## Build Order

1. **Add WriterRouter.** `EbbServer.Storage.WriterRouter` -- round-robin routing to Writer 1 and Writer 2. Simple `:atomics` counter for round-robin index.

2. **Start 2 Writer instances.** Update `WriterSupervisor` to start `Writer1` and `Writer2` as named children. Each Writer receives its `writer_id` in opts.

3. **Add batching to Writer.** Implement the 10ms timer + 1000 max batch size state machine. Add the low-load optimization (flush immediately if buffer was empty).

4. **Implement full watermark tracking.** In System Cache, implement the committed ranges ETS table and the `advance_watermark` CAS loop. Test with concurrent `mark_range_committed` calls.

5. **Update Fan-Out Router for watermark gating.** Buffer `{:batch_committed, ...}` notifications. On each notification, check watermark and push all contiguous ranges. Test the out-of-order scenario.

6. **Update HTTP API to use WriterRouter.** `POST /sync/actions` calls `WriterRouter.route_write/1` instead of `Writer.write_actions/2` directly.

7. **Concurrency stress test.** Spawn 100 concurrent processes, each writing 100 Actions. Verify:
   - All 10,000 GSNs are assigned (1-10000, no gaps)
   - All Actions are durable in RocksDB
   - SSE delivery is in GSN order
   - No data corruption

8. **Throughput benchmark.** Measure Actions/sec with 1 Writer vs. 2 Writers. Verify near-linear scaling (expect ~1.8-1.9x). Compare against the 108k benchmark from `docs/rocksdb-throughput-results.md`.

9. **Crash recovery test.** Kill a Writer mid-batch. Verify:
   - Supervisor restarts the Writer
   - No GSN gaps (uncommitted GSNs are reclaimed or the gap is acceptable)
   - Watermark does not advance past uncommitted ranges
   - System recovers and continues processing
