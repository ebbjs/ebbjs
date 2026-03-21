# Ebb Server Architecture: Storage + Sync

## Problem Statement

Ebb needs a server architecture that can:

- Handle 1,000 collaborative documents with 10 concurrent editors each
- Support 10,000 concurrent client connections per server instance
- Sustain 10,000-20,000 Action writes/second (theoretical ceiling: 100,000/sec)
- Scale horizontally via multi-master replication
- Guarantee durability: never sync an Action to clients before it's on disk

Cursor/presence updates are ephemeral broadcasts only — not persisted to storage.

## Technology Choice: Elixir

The entire server (sync protocol + storage engine) is built in Elixir.

**Why Elixir:**
- OTP supervision trees provide operational resilience (priority over raw performance)
- Process-per-connection model handles 10k+ SSE connections naturally
- Built-in fault isolation — one bad connection doesn't crash the server
- Per-process GC (not stop-the-world) — dedicated Writer GenServer has minimal GC impact
- Excellent binary pattern matching for the Action log format: `<<gsn::64, size::32, payload::binary-size(size), crc::32>>`
- ETS (Erlang Term Storage) provides lock-free concurrent reads for in-memory indexes
- All internal coordination is native message passing — no cross-language boundaries
- Single language to debug, deploy, and reason about
- Hot code reloading for the entire system

**Why not Rust/Go for the storage layer:**
We evaluated a Rust NIF (via Rustler) for the storage engine in depth. While Rust offers predictable performance and strong binary manipulation, the NIF boundary created significant coordination complexity: durability notifications, memory-pressure-triggered compaction, and cold-tier index population all required cross-boundary message passing. The complexity cost outweighed the performance benefit at realistic load. If Elixir becomes a bottleneck at extreme scale, the Writer GenServer's message-passing interface can be replaced with a Rust NIF without changing the rest of the system.

## Architecture Overview

The system consists of three co-located servers:

- **Elixir Sync/Storage Server** — the core: sync protocol, Action log, real-time fan-out
- **Auth Server** — developer-provided (Clerk, Better Auth, custom JWT, etc.), called via HTTP during handshake
- **Bun Application Server** — runs developer-defined server functions (`defineFunction`) with direct data access

```
┌─────────────────┐   ┌──────────────────────────────────────┐   ┌─────────────────┐
│   Auth Server    │   │       Elixir Sync/Storage Server     │   │ Bun Application │
│                  │   │                                      │   │ Server          │
│  Clerk,          │   │  ┌────────────────────────────────┐  │   │                 │
│  Better Auth,    │◄──│  │          Sync Server           │  │   │ defineFunction  │
│  custom JWT,     │   │  │                                │  │──►│ server-side     │
│  etc.            │   │  │  HTTP Handlers                 │  │   │ client with     │
│                  │   │  │  - Handshake (calls auth URL)  │  │   │ direct data     │
│  Developer-      │   │  │  - Catch-up reads              │  │   │ access          │
│  provided        │   │  │  - Action writes               │  │   │                 │
└─────────────────┘   │  │  - Permission checks            │  │   └─────────────────┘
                      │  │                                │  │
                      │  │  Fan-out Router + Group procs   │  │
                      │  │  - Per-Group GenServers         │  │
                      │  │  - Per-client SSE connections   │  │
                      │  │  - Presence broadcasting        │  │
                      │  │                                │  │
                      │  │  Replication Manager            │  │
                      │  │  - Per-peer HTTP connections    │  │
                      │  └──────────┬─────────┬───────────┘  │
                      │             │ msg pass│ ETS reads     │
                      │  ┌──────────▼─────────▼───────────┐  │
                      │  │       Storage Engine            │  │
                      │  │                                │  │
                      │  │  Writer GenServer               │  │
                      │  │  In-Memory Indexes (ETS)        │  │
                      │  │  Compactor Process               │  │
                      │  │  Checkpoint Manager              │  │
                      │  │  Action Log Files                │  │
                      │  └──────────┬─────────────────────┘  │
                      │             │                         │
                      │  ┌──────────▼─────────────────────┐  │
                      │  │    SQLite (shared, WAL mode)     │  │
                      │  │  Materialized entity views       │◄─── Bun writes
                      │  │  Generated column indexes        │
                      │  │  Actors, Cold-tier Action index  │◄─── Elixir writes (infrequent)
                      │  │  Snapshots                       │
                      │  └────────────────────────────────┘  │
                      └──────────────────────────────────────┘
```

---

## Storage Engine

### Overview

The storage engine has two layers:

**Layer 1: Append-Only Action Log** — handles high-throughput writes
- Single global log file, ordered by GSN (Global Sequence Number)
- Batched fsync for durability (10ms windows or 1000 Actions)
- Three in-memory ETS indexes for fast concurrent reads

**Layer 2: Single SQLite database** — shared by Bun and Elixir in WAL mode

Bun is the primary writer (materialized entity views after each batch flush). Elixir writes infrequently (cold-tier Action index during memory pressure eviction, actor records on first authentication). WAL mode supports concurrent readers and these low-frequency Elixir writes without meaningful contention.

The database uses generated columns to automatically extract and index fields from the JSON `data` blob on system entity types (Relationships, GroupMembers). This eliminates the need for separate denormalized tables — SQLite maintains the indexes as Bun writes materialized state.

```sql
-- SQLite Schema (WAL mode)

-- =============================================================================
-- MVP Action Log Tables (Phase 1: SQLite-backed storage)
-- These tables replace the custom append-only binary log for the MVP.
-- In Phase 4, the Action log moves to the custom file format with ETS indexes,
-- and these tables become unnecessary for writes — but may be retained as a
-- queryable archive or removed entirely.
-- =============================================================================

-- Actions: the atomic unit of change. Each Action contains one or more Updates.
-- Written by the Elixir Writer GenServer.
CREATE TABLE actions (
  id TEXT PRIMARY KEY,              -- globally unique action ID (nanoid)
  actor_id TEXT NOT NULL,           -- actor who created this Action
  hlc INTEGER NOT NULL,             -- Hybrid Logical Clock timestamp (assigned by creating node)
  gsn INTEGER NOT NULL UNIQUE,      -- Global Sequence Number (assigned by this server, monotonic)
  created_at INTEGER NOT NULL       -- epoch ms (server wall clock, for operational use only)
);
CREATE INDEX idx_actions_gsn ON actions(gsn);
CREATE INDEX idx_actions_actor ON actions(actor_id);

-- Updates: individual mutations within an Action. Each targets a single Entity.
-- Written by the Elixir Writer GenServer alongside the parent Action.
CREATE TABLE updates (
  id TEXT PRIMARY KEY,              -- globally unique update ID (nanoid)
  action_id TEXT NOT NULL,          -- parent Action
  subject_id TEXT NOT NULL,         -- entity being mutated
  subject_type TEXT NOT NULL,       -- entity type, e.g., "todo", "relationship", "groupMember"
  method TEXT NOT NULL,             -- 'PUT', 'PATCH', or 'DELETE'
  data TEXT,                        -- JSON blob (full state for PUT, partial for PATCH, NULL for DELETE)
  FOREIGN KEY (action_id) REFERENCES actions(id)
);
CREATE INDEX idx_updates_action ON updates(action_id);
CREATE INDEX idx_updates_subject ON updates(subject_id);
CREATE INDEX idx_updates_subject_type ON updates(subject_type);

-- =============================================================================
-- Persistent Tables (used in both MVP and target architecture)
-- =============================================================================

-- Actors: identity records, auto-created on first authentication.
-- Exist outside the sync mechanism. Not Entities — no materialization, no Actions.
-- Written by Elixir (infrequent — once per new user).
CREATE TABLE actors (
  id TEXT PRIMARY KEY,              -- e.g., "a-abc123..." (nanoid with prefix)
  created_at INTEGER NOT NULL       -- epoch ms
);

-- Materialized entity state: the current view of every entity.
-- Written by the Bun Materializer after each batch flush.
-- Read by Bun for server functions and by Elixir for permission checks.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,              -- entity ID (nanoid with type prefix)
  type TEXT NOT NULL,               -- entity type, e.g., "todo", "group", "groupMember", "relationship"
  data TEXT,                        -- JSON blob (current materialized state), NULL for tombstones
  format TEXT NOT NULL DEFAULT 'json', -- 'json' or 'crdt'
  created_hlc INTEGER NOT NULL,     -- HLC of the first PUT
  updated_hlc INTEGER NOT NULL,     -- HLC of the most recent Update applied
  deleted_hlc INTEGER,              -- HLC of DELETE (tombstone), NULL if alive
  deleted_by TEXT,                  -- actor_id who deleted, NULL if alive
  last_gsn INTEGER NOT NULL,        -- GSN of the most recent Action that touched this entity

  -- Generated columns: auto-extracted from data blob for Relationship entities.
  -- Used by Elixir for permission checks and sync routing (entity→Group lookups).
  source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.source_id')) STORED,
  target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.target_id')) STORED,
  rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) STORED,    -- relationship type, e.g., "todo"
  rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.field')) STORED,  -- relationship field, e.g., "list"

  -- Generated columns: auto-extracted from data blob for GroupMember entities.
  -- Used by Elixir for permission checks (actor→Group→permissions lookups).
  actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.actor_id')) STORED,
  group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.group_id')) STORED,
  permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.permissions')) STORED
);

-- General indexes
CREATE INDEX idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL;
CREATE INDEX idx_entities_type_gsn ON entities(type, last_gsn);

-- Relationship indexes (for sync routing and permission checks)
CREATE INDEX idx_entities_source ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
CREATE INDEX idx_entities_target ON entities(target_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;

-- GroupMember indexes (for permission checks)
CREATE INDEX idx_entities_actor_group ON entities(actor_id, group_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL;

-- Snapshots: pointer to the last PUT update for each entity.
-- Used for compaction and visibility (entity only "exists" once it has a snapshot).
CREATE TABLE snapshots (
  entity_id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL,          -- ID of the PUT Update
  action_id TEXT NOT NULL,          -- ID of the Action containing the PUT
  hlc INTEGER NOT NULL,             -- HLC of the PUT
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

-- =============================================================================
-- Target Architecture Tables (Phase 4+, not needed for MVP)
-- =============================================================================

-- Cold-tier Action index: maps entity_id → GSN for Actions that have been
-- evicted from the in-memory ETS indexes but still exist on disk.
-- Written by Elixir (infrequent — only during memory pressure eviction).
-- Not needed in MVP (SQLite-backed storage has no ETS indexes to evict from).
CREATE TABLE cold_action_index (
  entity_id TEXT NOT NULL,
  gsn INTEGER NOT NULL,
  PRIMARY KEY (entity_id, gsn)
);

-- Function versions: stores deployed server function code and metadata.
-- Written by the deploy CLI (via Bun), read by the Bun Application Server at request time.
-- See server-functions-spec.md for full details.
CREATE TABLE function_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  code TEXT NOT NULL,
  input_schema TEXT,
  output_schema TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | previous
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  UNIQUE(name, version)
);
CREATE INDEX idx_function_active ON function_versions(name, status) WHERE status = 'active';
```

**Bun↔Elixir communication:** Both channels use HTTP on localhost — no special IPC, no new protocol. This reuses the same endpoints that clients and peer servers already use.

- **Bun → Elixir (writes):** Server functions (`ctx.create()`, `ctx.update()`, `ctx.delete()`) send Actions via `POST /sync/actions` on localhost. Synchronous request/response — Bun waits for Elixir to confirm durability before returning to the caller. HTTP overhead (~0.5ms round-trip on localhost) is small relative to the ~5ms average fsync wait.
- **Elixir → Bun (materialization):** The Bun Materializer subscribes to the unfiltered replication stream via `GET /sync/replication?live=sse` — the same endpoint used by peer servers. On each batch of Actions, it materializes entity state using the same JS replay logic the client uses (field-level LWW for JSON entities, Yjs merge for CRDT entities), and writes results to the entities table. Generated columns and indexes are maintained automatically by SQLite. Runs asynchronously — small staleness window (typically single-digit ms) is acceptable.

**System entity cache (race condition mitigation):** Because materialization is async, there's a window where a newly created Group, GroupMember, or Relationship exists in the Action log but not yet in SQLite. If a subsequent Action depends on that system entity for permission checks (e.g., creating a Todo in a just-created Group), the permission check would fail against stale SQLite state.

To handle this, Elixir maintains a small in-memory ETS cache of recently-written system entities (Groups, GroupMembers, Relationships only). After each batch flush, the Writer extracts system entity state from the Action payloads and populates this cache — including tombstones for deleted system entities. Permission checks read from the cache first, falling through to SQLite only on cache miss. This ensures that both grants (new GroupMember) and revocations (deleted GroupMember) take effect immediately, before the Materializer has updated SQLite.

When the Bun Materializer confirms it has processed up to a given GSN (via a lightweight callback or cursor update), cache entries at or below that GSN are evicted.

The cache is small and bounded: only system entity types (not application entities), only covering the materialization lag window (typically single-digit ms), evicted as soon as the Materializer catches up.

**Bun Application Server integration:**
- **Reads:** Bun and Elixir both read the same SQLite database directly. Bun reads for server functions (`ctx.get()`, `ctx.query()`). Elixir reads for permission checks during the write path (system entity cache first, then SQLite via generated column indexes).
- **Writes:** Bun server sends Actions to Elixir via `POST /sync/actions` on localhost, which routes them through the normal write path (permission checks → Writer GenServer → fsync → fan-out)

### Action Log File Format

Each Action is stored as a fixed-format record:

```
[GSN:8bytes][Size:4bytes][Payload:variable][CRC32:4bytes]
```

- **GSN**: Monotonically increasing, gap-free sequence number (assigned by Writer)
- **Size**: Payload length, enables efficient seeking
- **Payload**: Serialized Action as JSON (same format on wire and on disk — no transcoding on write path). Can migrate to MessagePack later for ~30% size reduction if needed.
- **CRC32**: Checksum for detecting partial/corrupt writes on crash recovery

### Writer GenServer

A single GenServer process serializes all writes. This is the heart of the storage engine.

**Batching strategy:**
- Actions arrive via message passing from HTTP handlers
- First Action starts a 10ms timer (`Process.send_after`)
- Subsequent Actions buffer in GenServer state (GSN assigned immediately)
- Batch flushes when timer fires OR 1000 Actions accumulated (whichever first)
- Flush: serialize entire batch → append to file → fsync → update ETS indexes → notify callers

**Why batched fsync:**
- Individual fsync: ~1,000-3,000 writes/second (disk-bound)
- Batched fsync (10ms window): 100,000+ writes/second (many Actions per fsync)
- Latency: 0-10ms per Action (average ~5ms). Under high load, batches fill quickly so most Actions see well under 10ms.

**Durability notifications (two messages after each fsync):**
1. `{:durable, gsn}` → each waiting HTTP handler process (unblocks HTTP response)
2. `{:batch_flushed, from_gsn, to_gsn}` → Fan-out Router (triggers push to SSE subscribers and notifies the Bun Materializer via the same SSE/notification channel)

```elixir
# Simplified Writer GenServer implementation

# State: %{batch: [], timer_ref: nil, next_gsn: N, file: fd, fan_out_pid: pid}

# First Action arrives (no active timer)
handle_cast({:append, payload, caller_pid}, %{timer_ref: nil} = state) ->
  gsn = state.next_gsn
  send(caller_pid, {:buffered, gsn})
  timer_ref = Process.send_after(self(), :flush, 10)
  {:noreply, %{state |
    batch: [{payload, gsn, caller_pid}],
    timer_ref: timer_ref,
    next_gsn: gsn + 1}}

# Subsequent Actions (timer already running)
handle_cast({:append, payload, caller_pid}, state) ->
  gsn = state.next_gsn
  send(caller_pid, {:buffered, gsn})
  new_state = %{state |
    batch: [{payload, gsn, caller_pid} | state.batch],
    next_gsn: gsn + 1}
  if length(new_state.batch) >= 1000 do
    Process.cancel_timer(new_state.timer_ref)
    flush_batch(new_state)
  else
    {:noreply, new_state}
  end

# Timer fires
handle_info(:flush, state) ->
  flush_batch(state)

# Flush: serialize, append, fsync, notify
defp flush_batch(state) ->
  batch = Enum.reverse(state.batch)
  binary = serialize_batch(batch)
  :file.write(state.file, binary)
  :file.sync(state.file)
  update_ets_indexes(batch)
  for {_payload, gsn, caller_pid} <- batch, do: send(caller_pid, {:durable, gsn})
  send(state.fan_out_pid, {:batch_flushed, first_gsn(batch), last_gsn(batch)})
  {:noreply, %{state | batch: [], timer_ref: nil}}
```

**Backpressure:** When the Writer is busy (flushing a batch), incoming messages queue in the BEAM mailbox. Under extreme load, this provides natural backpressure — senders slow down. This is acceptable degradation that prevents data loss.

### In-Memory Indexes (ETS)

Three ETS tables provide fast concurrent reads without blocking the Writer:

| Table | Key | Value | Purpose |
|-------|-----|-------|---------|
| `entity_index` | `entity_id` | `[gsn1, gsn2, ...]` | Find Actions affecting an Entity |
| `gsn_index` | `gsn` | `file_offset` | Seek directly to an Action on disk |
| `action_id_index` | `action_id` | `gsn` | Dedup during replication + point lookup by Action ID |

**Concurrency model:**
- Writer GenServer updates all three ETS tables after each batch flush
- Any process can read ETS concurrently (no message passing to Writer needed)
- ETS operations are atomic at the row level — no explicit locking

### Memory Management

Memory pressure in the hot tier (ETS) is managed by a two-threshold system that self-adjusts based on actual load.

**Soft limit (e.g., 1.5GB): Trigger compaction**

A separate Compactor process (not the Writer) creates synthetic Snapshots:

1. Monitor ETS memory usage periodically (e.g., every 30 seconds)
2. When soft limit is reached, identify entities with the longest GSN lists
3. Pick a snapshot point **in the past** (far enough back to reclaim sufficient memory)
4. Read historical Actions from disk up to that point (immutable data, no Writer involvement)
5. Materialize entity state as of that HLC by replaying Actions in HLC order
6. Create a synthetic PUT Action with that materialized state
7. Submit through the normal write path (Writer GenServer)
8. Once durable, compact all prior Actions for that entity and remove from ETS

**Why "snapshot in the past":**
- Historical data is immutable — Compactor reads from disk without interacting with Writer
- No race condition with in-flight Actions (snapshot point is frozen history)
- Writer GenServer is never blocked during materialization
- Clients materialize correctly: synthetic PUT (with historical HLC) + subsequent PATCHes = same state
- GSN of the synthetic Snapshot is current (for transport ordering), HLC is from the snapshot point (for state ordering)
- Works uniformly for regular entities (JSON PATCHes) and Yjs/CRDT entities (`encodeStateAsUpdate`)

**Hard limit (e.g., 2GB): Emergency eviction**

If compaction can't keep up:
1. Evict oldest index entries from ETS to cold-tier SQLite immediately
2. No data loss — Actions still exist on disk, just require SQLite lookup + file read
3. Degraded read performance for old data only; recent data unaffected

### Storage Engine API

```elixir
# Write path (Writer GenServer)
ActionWriter.start_link(data_dir, config)
ActionWriter.append(payload, hlc, caller_pid)  # → {:ok, gsn}, then {:durable, gsn} after fsync

# Read path (any process, reads ETS + disk directly)
ActionReader.get_actions_for_entities_since(entity_ids, cursor_gsn, limit)
ActionReader.get_actions_since(cursor_gsn, limit)  # server-to-server replication (no group filter)
ActionReader.get_action_at_gsn(gsn)
ActionReader.get_current_gsn()
ActionReader.get_low_water_mark()  # minimum GSN still available (stale cursor detection)
```

### File Management

**Rotation:** Rotate at 1GB or 10M Actions (whichever first). Maintain a manifest file tracking all log segments:

```json
{
  "files": [
    {"id": 1, "path": "actions_001.log", "min_gsn": 1, "max_gsn": 5000000},
    {"id": 2, "path": "actions_002.log", "min_gsn": 5000001, "max_gsn": null}
  ],
  "active_file_id": 2
}
```

**Multi-file queries:** Sync queries consult the manifest to determine which files span the requested GSN range, read from each, and merge results in GSN order.

**Cleanup and Compaction:**

The Action log is append-only — individual records can't be deleted from the middle of a file. Compaction works at the segment level by rewriting old segments (similar to LSM-tree compaction in RocksDB/LevelDB and Kafka log compaction).

*Segment rewriting (when a segment has significant obsolete Actions):*
1. Read old segment, skip Actions that have been compacted (superseded by synthetic Snapshots)
2. Write new segment containing only live Actions
3. Update manifest atomically to point to new segment
4. Delete old segment

*Segment deletion (when all Actions in a segment are below all client cursors):*
- Track minimum cursor across all connected clients
- Delete segments where `max_gsn < min(all_client_cursors)`
- Populate cold-tier SQLite index before deletion

*Constraints:*
- Only compact cold segments (never the active write file)
- Temporarily uses 2x disk space for the segment being compacted
- Manifest update must be atomic (write new manifest, then rename over old)
- Runs in the Compactor process (background, doesn't interfere with Writer)

**Backup:** Simple file copying — append-only files have no corruption risk during copy.

### Index Checkpointing

To avoid slow startup from scanning large files:
- Write index checkpoint file every N minutes (configurable, default 5 min)
- Checkpoint includes all three ETS tables (`entity_index`, `gsn_index`, `action_id_index`) + last checkpointed GSN
- On startup: load checkpoint, then replay only Actions since checkpoint GSN
- Reduces startup time from O(total_actions) to O(recent_actions)

### Crash Recovery

**Partial write detection using CRC32:**

1. Load last known-good checkpoint
2. Scan Action log from checkpoint GSN forward
3. For each record: read header (GSN + Size), read payload + CRC32, validate checksum
4. On first invalid/incomplete record: truncate file at that offset, log warning
5. Rebuild in-memory indexes from valid records only

**Guarantees:**
- No silent data corruption (CRC validates every record)
- At most one Action lost on crash (the in-flight write during fsync)
- Automatic truncation of partial writes

---

## Sync Protocol

### Overview

Sync uses a three-phase approach inspired by the [Durable Streams](https://durablestreams.com) protocol:

1. **Handshake** — authenticate, validate cursors, determine Group subscriptions
2. **Catch-up** — per-Group HTTP requests (CDN-friendly, parallel)
3. **Live subscription** — single SSE connection per client

This split is deliberate: catch-up is where bulk data transfer happens and where CDN caching has the most impact. Live mode is lightweight (just new Actions trickling in) where connection count matters more than bandwidth.

### Phase 1: Handshake

```
POST /sync/handshake

Request headers:
  (whatever auth headers the client app uses — Bearer token, cookie, etc.)

Request body:
{
  "cursors": {                    // per-Group GSN cursors from last session
    "group_a": 500,
    "group_b": 200
  },
  "schema_version": 3
}
```

**Server handshake flow:**

1. **Authenticate:** Forward client's headers to the configured auth URL:
   ```
   POST {auth_url}
   (forwards all original client headers)

   → 200 OK: { "actor_id": "user_123" }
   → 401: reject handshake
   ```
   The auth endpoint is developer-provided (Clerk, Better Auth, custom JWT validation, etc.). The Elixir sync server is auth-mechanism-agnostic — it just needs an actor ID back.

2. **Load Group memberships:** Query SQLite for Groups this actor belongs to

3. **Validate cursors:** For each Group, check if the client's cursor is still valid (cursor ≥ low-water mark)

4. **Validate schema version:** Check client schema version meets minimum supported version

5. **Respond:**
   ```
   200 OK
   {
     "actor_id": "user_123",
     "groups": [
       {"id": "group_a", "cursor_valid": true},
       {"id": "group_b", "cursor_valid": false, "reason": "below_low_water_mark"},
       {"id": "group_c", "cursor": null}
     ]
   }
   ```
   - `cursor_valid: true` — client can catch up from its existing cursor
   - `cursor_valid: false` — client needs full resync for this Group (start from beginning)
   - `cursor: null` — new Group (client wasn't previously subscribed), start from beginning

**Auth URL configuration:**
```elixir
config :ebb_sync,
  auth_url: "http://localhost:3001/auth"
```

The developer implements this endpoint however they want. The Elixir sync server forwards the client's original headers and expects `{ "actor_id": "..." }` on success or 401 on failure. Latency is negligible since handshakes only occur on initial connect and reconnection.

### Phase 2: Catch-up (per-Group, CDN-friendly)

Client makes parallel HTTP requests for each subscribed Group:

```
GET /sync/groups/{group_id}?offset={gsn}

Response headers:
  Stream-Next-Offset: <next_gsn>       # cursor for next request
  Stream-Up-To-Date: true              # present when caught up (fewer than 200 Actions returned)
  Cache-Control: public, max-age=60    # immutable historical data
  ETag: <group_id>:<start_gsn>:<end_gsn>

Response body:
  JSON array of up to 200 Actions for this Group with GSN > offset
```

**Pagination rules:**
- Page size: 200 Actions (configurable, starting default)
- If 200 Actions returned: more data likely available, client should request next page using `Stream-Next-Offset`
- If fewer than 200 Actions returned: include `Stream-Up-To-Date: true` header — client is caught up
- Never split within an Action (an Action with multiple Updates is always delivered whole)

**CDN collapsing:** Multiple clients catching up on the same Group at the same offset make identical HTTP requests. The CDN caches the response and serves it to all of them — the server handles 1 request instead of N. This is where the Durable Streams protocol's design pays off.

**Server query flow:**
1. SQLite: "Which Entities belong to Group X?" → `SELECT entity_id FROM relationships WHERE target_id = 'X'`
2. ETS: For each entity_id, find GSNs > cursor from `entity_index`
3. Disk: Seek to file offsets via `gsn_index`, read Action payloads
4. Return paginated Actions + `Stream-Next-Offset`

**Per-Group catch-up with a single Action log:**
- The Action log remains a single global append-only file (one GSN sequence)
- Per-Group streams are filtered views, computed on demand via entity→GSN indexes
- GSN is used directly as the Group stream offset (no separate offset sequence needed)
- GSN gaps within a Group are fine — offsets just need to be monotonically increasing

### Phase 3: Live Subscription (single SSE per client)

Once caught up on all Groups, client opens one SSE connection:

```
GET /sync/live?groups=A,B,C&cursors=500,200,800

SSE events:
  event: data
  data: <Action payload>

  event: control
  data: {"group":"A","nextOffset":"501"}
```

- Single connection per client (10,000 clients = 10,000 connections, not 100,000)
- Server fans out new Actions for all subscribed Groups on one connection
- Client may receive duplicate Actions (if an Action touches entities in multiple subscribed Groups) — client deduplicates by GSN

**SSE reconnection strategy:**

Reconnection is event-driven, not timer-based. The server sends a control event to force the client back through the handshake when needed.

| Trigger | Mechanism | Why |
|---|---|---|
| Group membership change | Server sends `{"reconnect": true, "reason": "membership_changed"}` | Client needs updated Group list, catch up on new Groups, drop removed Groups |
| Token expiry | Server detects expired auth token | Client must reauthenticate |
| Safety net | Maximum session lifetime (e.g., 30 min) | Catch any missed permission changes, prevent stale sessions |

**Client reconnection flow:**
1. Receive reconnect control event (or hit safety net timeout)
2. Close SSE connection
3. Go back to handshake (reauthenticate, get updated Group list)
4. Catch up on any new Groups in parallel
5. Open new SSE with updated subscriptions and cursors

### Fan-out Architecture (Process per Group)

Each Group gets its own GenServer process for fan-out. This is idiomatic OTP and enables parallel fan-out across cores.

```
Writer GenServer
  │
  │ {:batch_flushed, from_gsn, to_gsn}
  ▼
Fan-out Router
  │  1. Read flushed Actions from ETS/disk
  │  2. Parse entity IDs from each Action
  │  3. Look up affected Groups (system entity cache → SQLite: entity→Group)
  │  4. Send Actions to each affected Group process
  │
  ├──→ Group "A" GenServer ──→ [SSE conn 1, SSE conn 2, SSE conn 3]
  ├──→ Group "B" GenServer ──→ [SSE conn 2, SSE conn 4]
  └──→ Group "C" GenServer ──→ [SSE conn 1, SSE conn 5, SSE conn 6]
```

**Fan-out Router:**
- Receives `{:batch_flushed, from_gsn, to_gsn}` from Writer GenServer
- Reads the flushed Actions, determines affected Groups
- Group lookup uses the system entity cache first (for newly created Relationships), falling through to SQLite — same pattern as permission checks, avoiding the same Materializer lag race condition
- Dispatches Actions to the appropriate Group GenServers
- Single process, but its job is lightweight (routing, not delivery)

**Group GenServer (one per active Group):**
- Maintains `MapSet<connection_pids>` of active SSE subscribers
- On receiving Actions: sends to each subscriber pid
- Also handles presence broadcasting for the Group
- Starts when first client subscribes, stops when last client leaves
- Fan-out happens in parallel across Groups (BEAM schedules across cores)

**SSE connection process (one per client):**
- Receives Actions and presence updates from multiple Group GenServers
- Writes to the client's SSE stream
- Handles subscribe/unsubscribe by registering with Group GenServers
- On client disconnect: unregisters from all Group GenServers

**Why process-per-Group:**
- Popular Groups (5,000 subscribers) don't block other Groups during fan-out
- Natural fault isolation — one Group's slow subscriber doesn't affect others
- Scales naturally with BEAM's lightweight process model (1,000+ Groups is trivial)
- Clean lifecycle — process exists only while subscribers are active

### Presence Broadcasting

Presence updates (cursors, selections, user status) are ephemeral — not persisted to storage. They flow through the existing per-Group GenServer infrastructure.

**Inbound (client → server, authenticated via the same session as the SSE connection):**
```
POST /sync/presence

Request body:
{
  "entity_id": "doc_1",
  "data": { ... }            // opaque, developer-defined (cursor position, selection, status, etc.)
}
```

**Server flow:**
1. Identify actor from authenticated session
2. Look up Groups for `entity_id` (SQLite)
3. Route to each affected Group GenServer
4. Group GenServer broadcasts to all subscribers except the sender

**Outbound (server → client, on the same SSE connection as Actions):**
```
event: presence
data: {"actor_id":"user_123","entity_id":"doc_1","data":{ ... }}
```

**Design decisions:**
- **Fire-and-forget:** Server does not track current presence state. New clients joining a Group wait for the next presence update from each actor.
- **Opaque payload:** The server never parses the `data` field — it's pass-through. Developers define their own presence schema.
- **Throttling:** Client debounces (e.g., at most every 50ms). Server also throttles per actor per entity as a safety net (drops updates that are too frequent).
- **No persistence:** Nothing written to disk, no ETS, no Writer GenServer involvement.

### Server-to-Server Replication

Each server runs a Replication Manager process per configured peer. A peer server is essentially a special client that uses an unfiltered read path over HTTP.

**Two read paths:**

| Path | Used by | Endpoint | Filtering |
|---|---|---|---|
| Per-Group catch-up | Clients | `GET /sync/groups/{id}?offset={gsn}` | Entity→Group filtered |
| Unfiltered stream | Peer servers | `GET /sync/replication?offset={gsn}` | All Actions by GSN |

**Replication Manager (per peer) flow:**

```
1. Catch-up: GET /sync/replication?offset={last_peer_gsn}&limit=1000
   - Returns all Actions from peer with GSN > cursor, ordered by GSN
   - Loop until caught up

2. Live: GET /sync/replication?offset={last_peer_gsn}&live=sse
   - Stream of new Actions as they're written on the peer

3. On receive each Action:
   - Check action_id_index: already have this Action? → skip, advance cursor
   - If new: strip peer's GSN, preserve original HLC
   - Submit to local Writer GenServer (skip permission validation — trust-and-apply)
   - Local Writer assigns new local GSN

4. On failure:
   - Do NOT advance cursor (strict ordering — never skip an Action)
   - Retry with exponential backoff
   - Circuit breaker after repeated consecutive failures
   - Surface error to operators
```

**Deduplication:** In a multi-master topology, the same Action may arrive from multiple peers. Each Action has a stable, globally-unique `id` (distinct from the server-local GSN). The `action_id_index` ETS table enables fast dedup checks.

**Trust-and-apply:** Peer Actions skip permission validation and schema checks. The originating server already validated the Action — re-validation would break convergence.

**Replication lag monitoring:** Track per-peer cursor delta (how far behind this server is relative to each peer). Surface as an operational metric.

### Write Flow (End-to-End)

```
1. Client sends batch of Actions via HTTP POST

2. HTTP handler validates each Action:
    - Structural validation of Action envelope (valid IDs, valid method types, required fields present — not data payload shape)
    - Permission check (reads materialized Relationships and GroupMembers from SQLite B;
      for entity creation, parses Group membership from sibling Relationship Updates within the Action)
    - Bootstrap: Group creation is unpermissioned. Any authenticated actor can create a Group.
      The initial Action typically includes the Group PUT, a GroupMember PUT (granting the
      creator permissions), and a Relationship PUT — all in one atomic Action. After the Writer
      flushes this Action, the system entity cache has the GroupMember, so subsequent Actions
      targeting that Group can be permission-checked normally.
    - HLC drift check
    - Reject invalid Actions immediately in HTTP response
   - NOTE: No schema validation of the `data` blob. The Action log is schema-agnostic; the client SDK validates payload shape locally. Schema validation in Elixir (via a JSON Schema registry synced from Zod definitions on deploy) is a future optimization if bad data proves to be a real problem.

3. Valid Actions → Writer GenServer (message passing)
   - Writer assigns GSN, buffers in batch
   - Writer flushes after 10ms or 1000 Actions:
     serialize → append to file → fsync → update ETS indexes

4. After fsync, Writer sends notifications:
   - {:durable, gsn} → HTTP handler (unblocks response)
   - {:batch_flushed, from_gsn, to_gsn} → Fan-out Router

5. HTTP handler responds to client:
   - Rejected Actions (or empty = all accepted and durable)

6. Fan-out Router:
   - Reads flushed Actions, looks up affected Groups (SQLite: entity→Group)
   - Dispatches to Group GenServers
   - Group GenServers push to SSE subscribers

7. Client sees own Actions in SSE stream, removes from outbox
```

**Key invariants:**
- HTTP response confirms durability (Action is on disk before client hears "accepted")
- SSE subscribers only receive Actions that are on disk
- BEAM schedulers are never blocked by fsync (HTTP handler yields while waiting)

---

## OTP Supervision Tree

```
Application Supervisor (one_for_one)
│
├── Storage Supervisor (rest_for_one)
│   ├── Writer GenServer          (permanent)
│   ├── Checkpoint Manager        (permanent)
│   └── Compactor                 (permanent)
│
├── Sync Supervisor (one_for_one)
│   ├── Fan-out Router            (permanent)
│   ├── Group DynamicSupervisor   (permanent)
│   │   ├── Group "A" GenServer   (transient)
│   │   ├── Group "B" GenServer   (transient)
│   │   └── ...started/stopped dynamically as clients subscribe
│   └── SSE ConnectionSupervisor  (permanent)
│       ├── SSE conn 1            (temporary)
│       ├── SSE conn 2            (temporary)
│       └── ...one per connected client
│
└── Replication Supervisor (one_for_one)
    ├── Peer "X" Manager          (permanent)
    ├── Peer "Y" Manager          (permanent)
    └── ...one per configured peer
```

**Design rationale:**

- **Storage and Sync are separate subtrees.** If the Writer GenServer crashes, SSE connections and catch-up reads keep running from ETS. Writes are temporarily unavailable but reads are unaffected.
- **Storage uses `rest_for_one`.** Checkpoint Manager and Compactor depend on the Writer. If the Writer restarts, they restart too (in order) to re-establish their references. If the Compactor crashes, the Writer is unaffected.
- **Sync uses `one_for_one`.** Fan-out Router, Group processes, and SSE connections are independent. One crashing doesn't affect the others.
- **Group GenServers are `transient`.** They restart on abnormal crash but not on graceful shutdown (e.g., last subscriber left). Started dynamically via DynamicSupervisor as clients subscribe.
- **SSE connections are `temporary`.** Never restarted — if a connection dies, the client reconnects on its own and gets a new process.
- **Replication Managers are `permanent`.** Always restart — peer connections should be maintained continuously.

---

## Implementation Phases

### Implementation Strategy: SQLite-First

The custom append-only Action log with batched fsync, ETS indexes, and segment compaction is the target architecture for high-throughput production use. However, it is also the component with the most implementation unknowns and the least impact on developer experience.

The MVP implements the Writer GenServer interface backed by SQLite. Actions are stored in a SQLite table (not a custom binary log), GSN is assigned via SQLite autoincrement, and reads query SQLite directly (no ETS indexes). This gives ~1-3k writes/sec — sufficient for early users and development.

The Writer GenServer's message-passing interface remains identical. The sync protocol, permission system, fan-out, and client SDK are built against this interface and don't change when the storage backend is swapped. This means the custom storage engine can be built later, benchmarked against the SQLite baseline, and swapped in without touching the rest of the system.

### Phase 1: SQLite-Backed Storage + Bun Materializer
**Goal:** End-to-end write path works. Actions are persisted, materialized, and queryable.

**Elixir:**
- Writer GenServer backed by SQLite (insert Actions/Updates into SQLite tables, assign GSN, WAL mode fsync for durability)
- ActionReader queries against SQLite (no ETS, no custom file format)
- SQLite database setup (WAL mode): `actions`, `updates`, `entities`, `snapshots`, `actors`, `function_versions` tables with generated columns and indexes
- Unfiltered replication SSE endpoint (`GET /sync/replication?live=sse`)
- System entity cache in ETS (Groups, GroupMembers, Relationships — including tombstones) populated by Writer after each flush, evicted when Materializer catches up
- Permission check logic: system entity cache → SQLite fallback, structural validation of Action envelope, HLC drift check
- Intra-Action permission resolution for entity creation (parse Group membership from sibling Relationship Updates)
- Action write endpoint (`POST /sync/actions`)

**Bun:**
- Bun Materializer process: subscribes to replication SSE stream, materializes entity state (JSON LWW + Yjs), writes to SQLite `entities` table
- Materializer GSN cursor tracking (so Elixir knows what's been materialized)

### Phase 2: Sync Protocol
**Goal:** Clients can authenticate, catch up, and subscribe to live updates.

- Auth URL integration (HTTP callback to developer's auth server)
- Actor auto-creation on first authentication (SQLite `actors` table)
- Handshake endpoint (authenticate, validate cursors, return Groups)
- Per-Group catch-up HTTP endpoint (with CDN-friendly headers, 200-Action pagination)
- Single SSE live subscription endpoint (with event-driven reconnection)
- Fan-out Router + per-Group GenServers (Group lookup via system entity cache → SQLite)
- Presence broadcasting endpoint

### Phase 3: Bun Application Server
**Goal:** Server functions can read and write Ebb data.

- Bun↔Elixir write integration: server functions send Actions via `POST /sync/actions` on localhost
- Function context (`ctx`) reads from shared SQLite directly
- `defineFunction` execution (vm sandbox, timeout enforcement)
- Function store, deployment CLI, version management

### Phase 4: Custom Storage Engine (Performance)
**Goal:** Swap SQLite-backed Writer for the high-throughput append-only Action log. 10-100x write performance improvement.

This phase replaces the internals behind the Writer GenServer interface. Nothing above the interface changes.

- Append-only Action log file format (binary records with CRC32)
- Writer GenServer with batched fsync (10ms windows or 1000 Actions)
- ETS indexes (`entity_index`, `gsn_index`, `action_id_index`)
- Crash recovery (CRC32 validation + truncation)
- Benchmark against SQLite baseline to verify performance improvement
- ActionReader queries switch from SQLite to ETS + disk reads

### Phase 5: Operational Maturity
**Goal:** Production-ready compaction, checkpointing, and multi-server replication.

- File rotation + manifest management
- Segment rewriting (compaction of old log segments)
- Index checkpointing (all three ETS tables)
- Memory management (soft/hard limits, synthetic snapshot compaction)
- Cold-tier SQLite index population
- Server-to-server replication (Replication Manager, dedup, trust-and-apply)
- Replication lag monitoring
- Storage stats and integrity validation

### Phase 6: Optimization
**Goal:** Performance tuning and efficiency improvements as needed.

- Compression (if file size becomes an issue)
- Payload format migration (JSON → MessagePack if needed)
- CDN integration and cache tuning
- Performance profiling and tuning
- Schema validation in Elixir via JSON Schema registry (if bad data proves to be a problem)
- Evaluate Rust NIF for Writer GenServer if needed

---

## Alternatives Considered

| Alternative | Why not |
|---|---|
| **RocksDB/LevelDB** | Adds operational complexity and external dependencies. Append-only file leverages Ebb's specific access patterns (append-only writes, GSN-ordered reads). |
| **SQLite-only for Actions** | Durability requirement (fsync before ACK) limits to ~1,000-3,000 writes/second. Long sync reads could block writes. |
| **Bun/Node.js** | Single-threaded event loop struggles with 10k concurrent SSE connections alongside file I/O. Lacks process isolation and supervision. |
| **Rust NIF + Elixir** | NIF boundary created significant coordination complexity for durability notifications, compaction, and cold-tier indexing. Complexity cost outweighed performance benefit at realistic load. |
| **Rust for everything** | Strong performance but lacks Elixir's operational resilience (supervision trees, hot code reloading, process isolation). |

## Success Metrics

- 10,000-20,000 Actions/second sustained write load (realistic target)
- Theoretical ceiling of 100,000 Actions/second with batched fsync
- Sub-100ms sync query response times
- 10,000 concurrent client connections per server instance
- CDN-friendly catch-up reads (cache hit rate > 80% for common Groups)
- Maintain all Ebb consistency and atomicity guarantees
- Future optimization path: Writer GenServer → Rust NIF if needed
