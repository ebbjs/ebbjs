# Rust NIF Optimization Path for Writer GenServer

> **Deprecated:** This document has been superseded by `storage-architecture-v2.md`. The v2 architecture uses the `rocksdb` hex package (existing Erlang C++ NIF) instead of a custom Rust NIF. No custom Rust code is required. This document is retained for historical context.

## Context

The Ebb storage engine's Writer GenServer is implemented entirely in Elixir. This document captures the evaluation of a Rust NIF alternative and defines when/how to pursue it if needed.

This is a **future optimization** — not part of the current implementation plan. The Writer GenServer's message-passing interface is designed so the internals can be swapped without changing the rest of the system.

## Evaluation Summary

We evaluated a Rust NIF (via Rustler) for the storage engine. While Rust offers predictable performance and strong binary manipulation, the NIF boundary created significant coordination complexity:

- **Durability notifications**: After fsync, the NIF needs to notify individual BEAM processes (HTTP handlers waiting for `{:durable, gsn}`). This requires either dirty scheduler callbacks or a polling mechanism — both add latency or complexity.
- **Memory-pressure-triggered compaction**: The Compactor process needs to coordinate with the Writer. Across a NIF boundary, this becomes shared-state coordination rather than simple message passing.
- **Cold-tier index population**: ETS updates after each batch flush are trivial from Elixir but require NIF↔BEAM round-trips from Rust.
- **System entity cache updates**: The Writer extracts system entity state from Action payloads after each flush. Doing this in Rust means either duplicating the extraction logic or crossing the NIF boundary for each batch.

The complexity cost outweighed the performance benefit at realistic load (10–20k Actions/sec).

## When to Reconsider

A Rust NIF becomes justified if:

1. **Sustained throughput exceeds 10–20k Actions/sec** and profiling shows Elixir serialization (JSON encoding, binary construction) as the dominant cost — not fsync.
2. **Batch serialization latency** (not fsync latency) becomes the bottleneck. On fast NVMe storage where fsync is <1ms, Elixir's ~10–20ms serialization for a full 1,000-Action batch could become the ceiling.
3. **GC pauses in the Writer process** cause measurable tail latency spikes. The Writer accumulates batch state that creates garbage — a Rust implementation has no GC.

## What a Rust NIF Would Replace

Only the inner loop of `flush_batch/1`:

1. Serialize batch to binary format (`<<gsn::64, size::32, payload::binary, crc::32>>`)
2. CRC32 computation
3. File append + fsync

Everything else stays in Elixir:

- Batch accumulation and timer management (GenServer state)
- GSN assignment
- ETS index updates
- Durability notifications (message passing)
- Fan-out notification
- System entity cache updates

This minimizes the NIF surface area and avoids the coordination problems identified in the evaluation.

## Performance Comparison

| Metric                              | Elixir Writer          | Rust NIF Writer (estimated) |
| ----------------------------------- | ---------------------- | --------------------------- |
| Serialization (1K Actions, 1KB avg) | ~10–20ms               | ~1–2ms                      |
| CRC32 computation                   | ~1ms (`:erlang.crc32`) | ~0.1ms                      |
| fsync                               | 1–5ms (disk-bound)     | 1–5ms (same disk)           |
| **Total flush latency**             | **12–26ms**            | **2–8ms**                   |
| **Theoretical ceiling**             | ~20–40k Actions/sec    | ~100k+ Actions/sec          |

The gap only matters when batches are consistently large and disk is fast. Under moderate load (batches of 10–100 Actions), both implementations are fsync-bound and perform similarly.

## Alternatives Considered

| Alternative                          | Assessment                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rust NIF for full storage engine** | Too much coordination complexity across the NIF boundary. Evaluated and rejected.                                                                                                            |
| **Rust for everything (no Elixir)**  | Strong performance but lacks Elixir's operational resilience: supervision trees, hot code reloading, per-process GC, process isolation. The sync/fan-out layer benefits enormously from OTP. |
| **Rust sidecar process (not NIF)**   | Avoids NIF scheduling issues but adds IPC overhead (~0.5ms per round-trip on localhost). Similar coordination complexity to the NIF approach, plus deployment complexity.                    |
| **Zig NIF**                          | Smaller runtime, easier C interop, but less mature ecosystem and tooling than Rustler. Not worth the ecosystem risk for a component that may never be needed.                                |
| **MessagePack instead of JSON**      | ~30% size reduction and faster serialization. Should be tried before a Rust NIF — lower complexity, meaningful improvement. Documented in Phase 6 of the architecture proposal.              |
