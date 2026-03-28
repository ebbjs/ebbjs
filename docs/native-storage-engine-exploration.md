# Native Storage Engine Exploration

> **Deprecated:** This document has been superseded by `storage-architecture-v2.md`. The decision was made to use the `rocksdb` hex package (existing Erlang NIF) instead of building a custom Rust storage engine. This document is retained for historical context — the constraints and research findings informed the v2 architecture.

## Context

This document explores an alternative to the architecture in `storage-architecture-proposal.md`. The current proposal uses:

- Custom Action log in Elixir (batched fsync for 10k+ writes/sec)
- ETS indexes for fast reads
- Bun Materializer (async) writing to SQLite
- SQLite for materialized entity state

The core tension: **the Bun Function Server sits right next to the Action log, but sees stale data because materialization is async**. The data is _right there_, but there's lag due to the Elixir → SSE → Bun → SQLite indirection.

This exploration asks: **can we build a unified native storage engine that eliminates this lag by making materialization synchronous?**

---

## Design Goals (Revised)

1. **High write throughput** — 100k+ Actions/sec with multi-writer concurrency
2. **Zero materialization lag** — server functions always see the latest durable state
3. **Simplified architecture** — one storage system instead of ETS + SQLite + async materializer
4. **Shared access** — Elixir writes, Bun/Node reads from the same embedded engine
5. **Relational queries** — SQL or SQL-like query layer for permission filtering, JOINs, flexible predicates
6. **Evolvable permission model** — permission rules will move toward a declarative model (predicates evaluated against entity data), so the query layer must be flexible enough to support arbitrary filter expressions

## Hard Constraints (Crystallized Through Discussion)

- **No Rust authorship** — the team does not know Rust. The storage engine must be a dependency, not custom Rust code.
- **Embedded** — no separate server process. Must be linkable into both Elixir and Bun.
- **Multi-writer** — single-writer is a throughput ceiling. MVCC or equivalent concurrency is required.
- **Relational queries** — hand-coding join logic and index maintenance in a KV store is too rigid for an evolving permission model.
- **Materialization on write path** — LWW merge and Yjs merge must happen synchronously when Actions are committed, not asynchronously.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Native Storage Engine (Rust/Zig)               │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Action Log                         │   │
│  │  • Append-only, ordered by GSN                       │   │
│  │  • Batched fsync (10ms / 1000 Actions)               │   │
│  │  • CRC32 for crash recovery                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           │ synchronous on write            │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Materialized Entity State               │   │
│  │  • Field-level LWW merge (applied inline)            │   │
│  │  • Current state for every entity                    │   │
│  │  • Tombstones for deleted entities                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                     Indexes                          │   │
│  │  • entity_id → current state                         │   │
│  │  • entity_id → [GSNs] (for sync catch-up)            │   │
│  │  • type → [entity_ids]                               │   │
│  │  • GSN → file offset                                 │   │
│  │  • action_id → GSN (dedup)                           │   │
│  │  • GroupMember: actor_id → [group_ids]               │   │
│  │  • Relationship: source_id → group_id                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
├──────────────────────┬──────────────────────────────────────┤
│    Elixir (NIF)      │           Bun (N-API / FFI)          │
└──────────────────────┴──────────────────────────────────────┘
```

### Write Path

```
Client/Server Function
        │
        ▼
   Elixir (HTTP)
   • Authenticate
   • Permission check (query native engine for GroupMembers)
   • Validate Action structure
        │
        ▼
   Native Engine (via NIF)
   • Assign GSN
   • Append to Action log
   • Apply LWW merge to entity state (synchronous)
   • Update indexes
   • Batch with other writes
   • fsync
   • Return durability confirmation
        │
        ▼
   Elixir
   • Notify fan-out (push to SSE subscribers)
   • Respond to client
```

### Read Path (Server Functions)

```
Bun Server Function
   ctx.get() / ctx.query()
        │
        ▼
   Native Engine (via N-API/FFI)
   • Query includes actor_id
   • Engine looks up actor's groups (GroupMember index)
   • Filters results to entities in those groups (Relationship index)
   • Returns materialized entity state
```

### Read Path (Sync Catch-up)

```
Client catch-up request
        │
        ▼
   Elixir (HTTP)
   • Authenticate, validate cursor
        │
        ▼
   Native Engine (via NIF)
   • Query Actions by GSN range
   • Filter by group membership
   • Return Actions for client to replay locally
```

---

## What Elixir Still Owns

- **Sync protocol** — HTTP/SSE endpoints for clients
- **Authentication** — calling developer's auth URL
- **Permission checks** — querying native engine, enforcing access rules
- **Fan-out** — receiving "batch committed" events, pushing to subscribers
- **Presence** — ephemeral broadcast (not persisted)

## What Goes Away

- Bun Materializer process
- SSE stream from Elixir to Materializer
- Separate ETS cache for system entities
- SQLite for materialized entities (on the hot path)
- Async materialization lag

---

## Risks and Open Questions

### Risk 1: NIF Complexity

The original proposal rejected a Rust NIF for the storage engine due to "coordination complexity at the NIF boundary" — durability notifications, compaction triggers, etc.

**Questions to answer:**

- Is the coordination simpler if the NIF does _more_ (materialization + indexes) rather than less?
- What's the minimal interface between Elixir and the NIF?
- Can we make the NIF "dumb" from Elixir's perspective — just "write this, read that"?

**De-risk approach:**

- [ ] Sketch the exact NIF API (functions, arguments, return types)
- [ ] Identify all cross-boundary coordination points
- [ ] Prototype the NIF boundary with a minimal implementation

---

### Risk 2: Bun Native Binding

Bun needs to read (and potentially write) from the same native engine.

**Questions to answer:**

- N-API addon vs FFI — which is simpler for this use case?
- How does Bun access the same data files/memory as Elixir?
- What's the concurrency model — can Bun read while Elixir writes?

**De-risk approach:**

- [ ] Prototype a minimal native addon that Bun can call
- [ ] Test concurrent access (Elixir writing via NIF, Bun reading via N-API)
- [ ] Measure read latency from Bun

---

### Risk 3: LWW Implementation Correctness

The native engine must implement field-level LWW identically to how clients do it. Divergence = data inconsistency.

**Questions to answer:**

- Can we generate the merge logic from a single spec?
- How do we test equivalence between native and JS implementations?
- What about CRDT (Yjs) entities — does the native engine handle those too?

**De-risk approach:**

- [ ] Write a formal spec for LWW merge semantics
- [ ] Build a test suite that runs against both native and JS implementations
- [ ] Decide: native engine handles JSON LWW only, or also Yjs?

---

### Risk 4: Query Expressiveness

SQLite gives you SQL. A custom engine gives you... whatever you build.

**Questions to answer:**

- What queries do server functions actually need?
- Can we get away with a small, fixed set of query patterns?
- Do we need secondary indexes on arbitrary fields, or just system entity fields?

**De-risk approach:**

- [ ] Enumerate all query patterns from the Ebb API (ctx.get, ctx.query, etc.)
- [ ] Determine which require indexes
- [ ] Prototype the query layer with the most complex query pattern

---

### Risk 5: Operational Complexity

SQLite has decades of tooling. A custom engine has... what you build.

**Questions to answer:**

- How do you inspect the data? (debugging, support)
- How do you back up and restore?
- How do you monitor health and performance?
- What happens on corruption — recovery path?

**De-risk approach:**

- [ ] Define the minimal operational tooling needed for launch
- [ ] Plan the debugging story (dump to JSON? SQLite export for inspection?)
- [ ] Document the recovery process

---

## De-risking Plan

### Phase 1: Validate the NIF + Bun Boundary

**Goal:** Prove Elixir and Bun can both access the same native engine efficiently.

**Build:**

- Minimal Rust library with: append(data) → GSN, read(GSN) → data
- Elixir NIF wrapper
- Bun N-API wrapper
- Test: Elixir writes, Bun reads concurrently

**Success criteria:**

- Bun sees writes within <1ms of Elixir commit
- No corruption under concurrent access
- NIF doesn't block BEAM scheduler

---

### Phase 2: Add LWW Materialization

**Goal:** Prove the native engine can maintain materialized state correctly.

**Build:**

- Extend engine: on append, apply LWW merge to entity state
- Expose read_entity(id) function
- Port the JS LWW test suite to run against native implementation

**Success criteria:**

- Native LWW matches JS LWW for all test cases
- Materialized state is always consistent with Action log

---

### Phase 3: Add Permission-Scoped Queries

**Goal:** Prove queries can be efficiently filtered by actor's group membership.

**Build:**

- Indexes for GroupMember (actor → groups) and Relationship (entity → group)
- Query function that takes actor_id, applies permission filter
- Benchmark with realistic data volume (100k entities, 10k actors, 500 groups)

**Success criteria:**

- Query latency <5ms at target data volume
- Index memory usage acceptable

---

### Phase 4: Integrate with Elixir Sync Protocol

**Goal:** Prove the full write path works end-to-end.

**Build:**

- Replace Writer GenServer internals with NIF calls
- Replace ETS cache reads with native engine queries
- Remove Bun Materializer, point server functions at native engine

**Success criteria:**

- Sync protocol works as before
- Server functions see zero-lag materialized state
- Throughput meets target (10k+ writes/sec)

---

## Alternatives Considered

| Alternative                                                   | Why not (or why maybe)                                    |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| **SQLite for everything**                                     | fsync limits throughput to ~1-3k writes/sec               |
| **Current proposal (Elixir log + Bun Materializer + SQLite)** | Async materialization lag; multiple caches to coordinate  |
| **Elixir does materialization (no Bun Materializer)**         | Still limited by SQLite write throughput for entity table |
| **Keep SQLite for queries, custom log for Actions only**      | Doesn't solve materialization lag                         |

---

## Design Decisions

### CRDT (Yjs) Materialization

**Decision:** Native engine handles both JSON LWW and Yjs CRDT materialization using [yrs](https://github.com/y-crdt/y-crdt) (Rust port of Yjs, maintained by the Yjs author).

**How clients interact with CRDT entities:**

- Client sends Yjs updates as the `data` payload in an Update
- Client receives Yjs update blobs via sync and merges locally using yjs
- Clients are the source of truth for their own local state

**Server function reads:**

```
Native engine (yrs)
  → merges all updates for entity
  → encodeStateAsUpdate (binary blob)
  → returns to Bun

Bun (yjs)
  → new Y.Doc()
  → applyUpdate(blob)
  → doc.toJSON()
```

**Why this approach:**

- yjs remains the interpreter on the JS side — one less divergence surface
- Native engine only merges and serializes, doesn't convert to JSON
- yrs and yjs are maintained by the same author (Kevin Jahns)
- Deterministic CRDT algorithm — same inputs produce same outputs

**Verification strategy:**

- Property-based test suite that generates random Yjs operations
- Applies them in random orders to both yjs and yrs
- Asserts merged state (via `encodeStateAsUpdate`) is byte-identical
- Run in CI on every change

**Risk assessment:**

- Risk is bounded: if yrs/yjs diverge, server functions see different state than clients
- But clients don't depend on server's merged state — they merge locally
- Bug would be observable (server function returns unexpected result) and testable

---

## Open Design Questions

1. **Memory-mapped vs embedded?** Does the native engine use mmap for shared access, or do Elixir and Bun each embed it with file-level coordination?

2. **Cold storage?** The current proposal has a cold tier (old Actions evicted from memory to SQLite). Does the native engine need this, or can it keep everything in memory/mmap?

3. **Compaction?** How does the native engine compact old Actions? Same "snapshot in the past" approach as the current proposal?

4. **Multi-server replication?** How does this design interact with multi-master replication?

---

## Existing Technology Research

### Key Finding

No single existing system provides the full stack. Every candidate requires custom code for LWW materialization, GSN assignment, and permission-scoped queries. The choice of storage engine affects write throughput ceiling, compaction strategy, and build complexity — not the scope of custom code.

### Tier 1 — Most Promising Foundations

**Option A: Fjall (Recommended Starting Point)**

- Pure-Rust LSM-tree storage engine
- Best batch write throughput of all tested (353ms for bulk operations)
- Multiple keyspaces with cross-keyspace atomic writes
- Custom compaction filters — directly supports Action log compaction
- Actively maintained by the SQLSync team (highly relevant domain)
- Clean Rust API ideal for Rustler NIF + napi-rs bindings
- Effort: ~4-8 weeks of core engine work
- Risk: newer than RocksDB, not battle-tested at scale

**Option B: RocksDB (Battle-Tested)**

- Same architecture as Fjall but with C++ dependency
- Mature Elixir NIF ecosystem (`rocksdb` hex package already exists)
- Proven at scales far exceeding Ebb's requirements
- Effort: ~3-6 weeks (RocksDB NIF largely pre-built)
- Risk: C++ build chain, less ergonomic Rust wrapping

**Option C: redb + Custom Action Log File**

- Custom append-only file format for the Action log (CRC32 framing, sequential append)
- redb (pure-Rust B-tree) for entity state and secondary indexes
- Cleanest separation of concerns; each piece is simpler
- Effort: ~6-10 weeks (more custom code)
- Risk: more custom code to audit and maintain

### Tier 2 — For Specific Layers

**yrs (Rust Yjs port):** Use directly in the Rust storage engine to merge Yjs update blobs. Actively maintained, used in production (Zed editor). This is the answer for Yjs CRDT support inside the native engine.

**Loro:** If Yjs wire compatibility is not required, Loro provides an excellent LWW Map + rich text CRDT foundation with `loro-ffi` C bindings. Not a drop-in Yjs replacement.

**DuckDB (read-side only):** Consider as a read-only query replica for server functions. Write path writes to Fjall/redb; a background process maintains a DuckDB database for rich SQL queries. Clean CQRS separation — but reintroduces a read lag.

### Tier 3 — Explicitly Not Recommended

| Candidate               | Reason                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| sled                    | Abandoned. Last release 2021. Superseded by redb/fjall.                                      |
| TigerBeetle             | Wrong abstraction (financial ledger, fixed schema). Inspirational for design, not adoptable. |
| cr-sqlite               | Insufficient write throughput. Maintenance concerns.                                         |
| EventStoreDB / MartenDB | .NET only, non-embeddable.                                                                   |
| Materialize             | Non-embeddable cloud service.                                                                |
| LMDB                    | Single-process constraint blocks Elixir + Bun co-access.                                     |
| Noria                   | Abandoned research prototype.                                                                |
| Differential Dataflow   | No persistence layer, async by nature, no Elixir/JS bindings.                                |

### Dual-Binding Architecture (Rustler + napi-rs)

The pattern for a Rust core with both Elixir NIF and JS/Bun bindings is well-proven (used by Automerge, Loro, and others):

```
ebb-storage/          ← core Rust logic (fjall/redb + LWW + yrs)
ebb_nif/              ← Rustler NIF bindings for Elixir
ebb_napi/             ← napi-rs N-API bindings for Bun
```

Both bindings share the same core crate. Rustler handles Elixir resource objects (`ResourceArc<EbbStorage>`). napi-rs generates TypeScript type definitions automatically. Bun has N-API compatibility so napi-rs-built modules work without modification.

### Minimum Custom Code (Regardless of Storage Engine Choice)

1. GSN assignment and Action log append (~50 lines)
2. LWW merge logic with HLC comparison (~20 lines)
3. Yjs update merging (delegated to `yrs`)
4. Rustler NIF glue (~200-400 lines)
5. napi-rs N-API glue (~200-400 lines)
6. Secondary index maintenance on write (~100 lines)
7. Permission query execution (~100 lines)

---

## Next Steps

- [ ] Review this document — does the direction make sense?
- [ ] Choose between Fjall and RocksDB as the storage foundation
- [ ] Prioritize risks — which is the scariest?
- [ ] Start Phase 1 prototype
