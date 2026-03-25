---
title: "A Rock(sdb) Solid Start"
description: "How we built a write pipeline that can handle 100K writes/sec using RocksDB, SQLite, and Elixir"
date: 2026-03-21
---

Most sync engines build on [Postgres](https://www.postgresql.org/).

And honestly? That's probably the right call for most projects. Postgres is battle-tested, horizontally scalable with read replicas, has incredible tooling, and you can get a managed instance from about a dozen providers without thinking twice.

[Convex](https://convex.dev), [Zero](https://zerosync.dev), [ElectricSQL](https://electric-sql.com) -- they all lean on Postgres (or something like it) as the backbone. It's a proven path.

But Ebb's write path has a specific shape that kept nagging at me. Every user action -- every keystroke in a collaborative document, every card drag on a kanban board, every checkbox toggle -- appends to a durable log, and every connected client needs to see it within milliseconds. That's a tight hot loop where every millisecond of overhead matters.

Two costs bothered me with Postgres:

**The network hop.** Even talking to Postgres on localhost adds ~0.5-1ms of protocol overhead per round trip. Over a Unix socket, maybe ~0.1-0.3ms. At the throughput I was targeting, that's a meaningful percentage of the time budget spent on the network instead of on actual work.

**Write amplification.** Postgres writes to its WAL, then to the heap, then maintains indexes -- all through a general-purpose storage engine designed for flexibility, not raw append throughput. It's optimized for a much broader set of workloads than "append a lot of things very fast."

I'm not saying Postgres _can't_ hit the numbers. I'm saying I thought we could do better by going embedded -- putting the storage engine in-process, eliminating the network hop entirely, and picking data structures purpose-built for the workload.

The goal was ambitious: **100,000 durable Action writes per second on a single machine.** "Good enough" wasn't the target. "Blazingly fast" was.

## SQLite was the first attempt

[SQLite](https://sqlite.org/) is the obvious embedded choice. Single file, zero config, incredible read performance, full SQL. It's also genuinely one of the most well-engineered pieces of software ever written. I had high hopes.

The first storage architecture used SQLite for everything: the Action log, the materialized entity state, the indexes. I built a benchmark suite to stress-test the write path with realistic data -- batches of 1,000 Actions, each with 2 Updates, full schema with all the indexes you'd actually need in production.

The results:

| Config                          | Actions/sec | Notes                               |
| ------------------------------- | ----------- | ----------------------------------- |
| All indexes, sync               | **5,838**   | Full production schema              |
| Minimal indexes (PK + GSN only) | 9,466       | Dropped all secondary indexes       |
| No durability ceiling           | 15,062      | `MEMORY` journal, `synchronous=OFF` |

5,838 Actions/sec with the real schema. And the absolute ceiling -- with _zero_ durability guarantees -- was 15k.

The bottleneck was clear: **7 B-tree updates per INSERT** across the `actions` and `updates` tables plus their indexes. Every single Action paid for rebalancing multiple B-trees inline, synchronously, on the write path.

I tried everything. Dropping secondary indexes gave a 62% boost. Splitting into two databases with `ATTACH` helped marginally. Disabling auto-checkpoints bought a bit more. The best realistic configuration landed around ~9.5k.

But the fundamental issue isn't a configuration problem. SQLite is a [B-tree](https://en.wikipedia.org/wiki/B-tree). B-trees rebalance on write. That's not a bug -- it's the data structure. It's what makes SQLite incredible for reads. It's also what makes it fundamentally limited for write-heavy append workloads.

The architecture needs 100k with full durability. SQLite's ceiling _without_ durability is 15k. Time to look elsewhere.

## Enter the LSM-tree

If B-trees pay an index cost on every write, the question becomes: is there a data structure that doesn't?

The answer is the [LSM-tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree) (Log-Structured Merge-tree). Instead of updating indexes in-place on every write, an LSM-tree buffers writes in an in-memory table (called a _memtable_). When the memtable fills up, it flushes to disk as a sorted file. Background compaction periodically merges these files together -- that's when the "index maintenance" happens, but it's asynchronous and off the write path.

The trade-off is straightforward: B-trees pay at write time (great reads, slower writes). LSM-trees pay at compaction time (great writes, slightly more work on reads). For an append-heavy Action log, the LSM-tree is the obvious fit.

[RocksDB](https://rocksdb.org/) is Meta's LSM-tree engine. It powers [CockroachDB](https://www.cockroachlabs.com/), [TiKV](https://tikv.org/), and [Kafka Streams](https://kafka.apache.org/documentation/streams/). It's about as battle-tested as storage engines get.

More importantly, there's an existing [Erlang NIF package](https://hex.pm/packages/rocksdb) (`rocksdb` v2.5.0, wrapping RocksDB 10.7.5) that gives us WriteBatch, column families, iterators, snapshots, and compaction filters out of the box. No Rust, no custom native code. Just `{:rocksdb, "~> 2.5"}` in `mix.exs`.

The other contender was [Fjall](https://github.com/fjall-rs/fjall), a Rust LSM-tree. It's a clean design, but using it from Elixir would have required writing a custom [Rustler](https://hexdocs.pm/rustler/Rustler.html) NIF from scratch -- easily 4-8 weeks of work. And as I wrote in the [Why Elixir](/devlog/why-elixir) post, the team (me) doesn't know Rust. Hard constraint.

## The dual-store design

The key insight wasn't "replace SQLite with RocksDB." It was "use both."

RocksDB is great at absorbing writes. SQLite is great at serving reads. Why pick one when you can use each engine for what it's best at?

The architecture that emerged is a [CQRS](https://en.wikipedia.org/wiki/Command_Query_Responsibility_Segregation)-style dual-store:

- **RocksDB** handles the write-heavy Action log. It's the source of truth. Every Action, every Update, every index entry gets written atomically via `WriteBatch` across 5 column families.
- **SQLite** serves as the read-optimized entity cache. It retains everything that makes it great: `json_extract()` predicates, generated columns, partial indexes, permission-scoped JOINs.
- **On-demand materialization** bridges the two. Entity state is only built when something actually reads it -- not on every write. A dirty set (in ETS) tracks which entities have unprocessed updates. When a read comes in for a dirty entity, the system replays the delta from RocksDB, merges each field according to its type (LWW, counter, CRDT), upserts into SQLite, and clears the dirty flag.

This completely decouples write throughput from read patterns. The write path never touches SQLite. The read path only touches RocksDB when an entity has changed since it was last read. Clean reads are pure SQLite lookups.

## The benchmark gauntlet

Time to see if the theory holds up. I built a benchmark that mirrors the exact production write path:

1. Pre-generate a pool of realistic Actions (each with 2 Updates)
2. Per batch: pick 1,000 Actions, assign sequential GSNs, serialize, build a WriteBatch across all 5 column families (8,000 KV pairs total)
3. Commit with `sync: true` -- full durability, fsync on every batch
4. Measure the full cycle: serialization + batch construction + NIF commit

The results blew past my expectations:

| Config                             | Actions/sec | vs SQLite baseline |
| ---------------------------------- | ----------- | ------------------ |
| SQLite (all indexes, sync)         | 5,838       | 1x                 |
| **RocksDB + ETF (1 writer, sync)** | **~60,000** | **10x**            |
| RocksDB + MsgPack (1 writer, sync) | ~52,000     | 9x                 |
| RocksDB + JSON (1 writer, sync)    | ~47,000     | 8x                 |

60,000 Actions/sec with a single writer and full durability. Ten times the SQLite baseline. And this is with _more_ data per Action -- 8 KV puts across 5 column families versus 3 rows into 2 SQLite tables. The data structure advantage is overwhelming.

The serialization format mattered more than I expected. [ETF](https://www.erlang.org/doc/apps/erts/erl_ext_dist.html) (Erlang Term Format) -- the BEAM's native binary format -- encodes a 1,000-Action batch in **1.4ms**. MessagePack takes 3.6ms. JSON takes 5.6ms.

The reason: `:erlang.term_to_binary` is a C BIF inside the BEAM VM. Encoding never leaves C -- there's no Elixir code in the loop. MessagePack and JSON both encode in Elixir userland, which means the BEAM scheduler, garbage collector, and function call overhead all apply. At 100k Actions/sec, this is the difference between ~30% of a CPU core spent on serialization (ETF) and over 100% of a core (MessagePack).

Since Elixir is the exclusive owner of RocksDB -- no other process reads or writes it -- using a format only Erlang can decode is a free lunch. The human-readable view of data is SQLite and JSON over HTTP.

## Finding the real bottleneck

60k is a great start, but the goal is 100k. That's a 66% improvement. Where does it come from?

My first hypothesis: the 8,000 per-item `batch_put` NIF calls must be expensive. Each one crosses the Erlang-to-C boundary, copies binary data via `enif_make_copy`. Surely reducing 8,000 NIF crossings to 1 would help.

So I forked the `rocksdb` hex package and added a `write_multi/3` NIF function that accepts the entire list of write operations in a single call. Roughly 80 lines of C++, plus the Erlang wiring.

**Result: no improvement.** 56.7k/sec versus 58.3k/sec with the standard batch API. If anything, marginally _slower_ -- building the Erlang list to feed `write_multi` costs about the same as the NIF calls it replaces.

This was a significant finding. It proved the bottleneck isn't NIF overhead. It's Elixir computation. Breaking down the ~17ms batch time:

- **Key construction** (binary concatenation, `<<entity_id::binary, gsn::64-big>>`, etc.): ~3-5ms
- **Data structure manipulation** (`Enum.flat_map`, `Map.delete`, tuple construction): ~8-10ms
- **ETF serialization**: ~1.4ms
- **RocksDB commit** (memtable insertion + fsync): ~2-3ms

Items 1-2 are pure Elixir CPU and dominate the batch. The storage engine has headroom. The NIF boundary is cheap. The bottleneck is _our code_.

This is actually good news. If the ceiling is Elixir CPU, we can parallelize.

## Two writers, one database

The BEAM was built for concurrency. If one Writer GenServer maxes out one scheduler at 60k/sec, what happens with two?

The setup: two Writer GenServer processes, each running the full batch pipeline independently, writing to a **single shared RocksDB instance**. GSN assignment uses a shared `:atomics` counter -- lock-free, gap-free, no coordination between writers:

```elixir
# Each writer atomically claims a range of GSNs before building its batch
gsn_end = :atomics.add_get(gsn_counter, 1, batch_size)
gsn_start = gsn_end - batch_size + 1
```

First attempt with RocksDB's default configuration: **only 1.3x scaling** (78k/sec with 2 writers). The problem: RocksDB's default write path serializes both the WAL write and the memtable write. Writer 2 has to wait for Writer 1 to finish _both_ phases before it can start its WAL write. RocksDB's group commit helps a bit, but can't overcome the fundamental serialization.

Then I found [`enable_pipelined_write`](https://github.com/facebook/rocksdb/wiki/Pipelined-Write).

With pipelined writes enabled, RocksDB overlaps WAL and memtable writes across successive write groups. As soon as Writer 1's WAL write finishes, Writer 2 can immediately start its WAL write -- even while Writer 1's memtable insertion is still running in the background.

| Config                    | Actions/sec | Scaling  | Batch p50  |
| ------------------------- | ----------- | -------- | ---------- |
| 1 writer (baseline)       | 57,003      | 1.0x     | 17.5ms     |
| 2 writers (defaults)      | 78,351      | 1.37x    | 25.8ms     |
| **2 writers (pipelined)** | **108,068** | **1.9x** | **18.4ms** |
| 2 writers (unordered)     | 105,067     | 1.84x    | 18.6ms     |

**108,000 Actions/sec.** Nearly linear scaling. Per-writer throughput barely degrades -- 54k vs 57k solo, 95% efficiency. The writers are almost not contending with each other.

And the batch latency tells the story: 18.4ms with pipelined (barely above single-writer's 17.5ms) versus 25.8ms with defaults (where Writer 2 is stuck waiting). Pipelining works so well because our Elixir computation (~14ms) vastly exceeds the memtable insertion time (~1-2ms) -- the memtable write of batch N overlaps with the Elixir computation of batch N+1, making it effectively free.

I also tested `unordered_write`, which was slightly slower (105k) with a higher p99 and sacrifices snapshot immutability. Not worth the trade-off.

### Why not three writers?

The obvious next question: if 2 writers gives 1.9x, what about 3?

| Config                    | Actions/sec  | Scaling   | Per-Writer Efficiency | p99      |
| ------------------------- | ------------ | --------- | --------------------- | -------- |
| 2 writers (pipelined)     | ~108,000     | 1.83x     | 92%                   | 27ms     |
| **3 writers (pipelined)** | **~140,000** | **2.37x** | **79%**               | **37ms** |

140k is a real number. But the efficiency curve is bending. Each writer drops from 54k/sec to 47k/sec -- they're spending more time queued behind each other waiting for the WAL fsync. The p99 jumps 10ms. And in production, three writers means more watermark coordination, more interleaving to reason about, and 30% of BEAM scheduler capacity consumed during batch construction (leaving less headroom for fan-out, SSE connections, and materialization).

The real question is whether the extra 32k/sec is worth it when 108k already exceeds the target. My answer: no. If we ever need more than 108k sustained, the Rust NIF path (which would speed up the Elixir computation bottleneck itself) is a bigger unlock with less operational complexity than adding writers. But it's good to know the headroom is there.

### The ordering problem

There's one correctness requirement that comes with concurrent writers. Writer 2 might claim GSNs 1001-2000 and commit before Writer 1 finishes committing GSNs 1-1000. A catch-up reader scanning by GSN would see a gap.

The solution is a **committed GSN watermark** -- an atomic counter that tracks the highest GSN where _all prior GSNs_ are confirmed durable:

```
Writer 1 claims GSNs 1-1000, Writer 2 claims 1001-2000
Writer 2 commits first -> watermark stays at 0 (gap at 1-1000)
Writer 1 commits        -> watermark advances to 2000 (no gaps)
```

Catch-up reads and SSE fan-out use the watermark -- not the raw max GSN -- as the upper bound for safe reads. Worst case, one batch's SSE delivery waits for the other writer's batch to commit. At ~18ms per batch, streaming latency is ~18-36ms, still comfortably sub-50ms.

## Putting it all together

Here's the full picture, SQLite through RocksDB:

| Config                                     | Actions/sec  | vs SQLite |
| ------------------------------------------ | ------------ | --------- |
| SQLite (all indexes, sync)                 | 5,838        | 1x        |
| SQLite (minimal indexes)                   | 9,466        | 1.6x      |
| SQLite (no durability ceiling)             | 15,062       | 2.6x      |
| RocksDB + ETF (1 writer, sync)             | ~60,000      | **10x**   |
| RocksDB + ETF (2 writers, pipelined, sync) | **~108,000** | **18x**   |

Full durability preserved at every step. `sync: true` on every WriteBatch commit. No Action is acknowledged to a client before it's on disk.

## What's next

A few honest caveats. The 108k number is from a 15-second benchmark run that includes initial burst throughput. Sustained throughput over 60+ seconds -- after memtable flushes and compaction kick in -- will likely be ~85-100k. A longer validation run is on the list.

And this might be over-engineered. Postgres might have been fine. Plenty of successful sync engines are built on it, and they ship features instead of benchmarking storage engines.

But now I have data. I know the write path has headroom. I know the architecture can sustain the throughput I'm targeting without reaching for Rust, without multi-instance sharding, without exotic hardware. RocksDB absorbs the writes, SQLite serves the reads, Elixir orchestrates the whole thing with two concurrent writers on separate BEAM schedulers.

The Rust NIF path remains available as a future ceiling raiser if we ever need >200k Actions/sec. But that's a problem for future me.

Right now, I'm building the production implementation: the Writer GenServers, the EntityStore for on-demand materialization, the committed GSN watermark, and the ordered fan-out that gates SSE delivery. The foundation is solid. Time to build on it.
