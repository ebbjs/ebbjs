# Storage Architecture Proposal: Hybrid Action Log + SQLite

## Problem Statement

Ebb needs to handle 1,000 collaborative documents with 10 concurrent editors each on a single server instance. With a 100ms buffer, this translates to approximately 100,000 write operations per second - well beyond SQLite's single-writer capabilities.

## Proposed Solution

A two-layer storage architecture that separates high-throughput Action logging from relational metadata queries:

### Layer 1: High-Throughput Action Log (Append-Only File)
- Handles the GSN-ordered Action stream for sync
- Optimized for 100k+ writes/second
- Simple append-only file with in-memory indexing

### Layer 2: Relational Metadata Store (SQLite)
- Stores Groups, GroupMembers, Relationships
- Handles permission lookups and sync routing
- Lower write volume (only group membership changes)

## Detailed Design

### File Format

```
[GSN:8bytes][Size:4bytes][Payload:variable][CRC32:4bytes]
```

- Actions serialized as JSON/MessagePack/Protobuf
- GSN provides natural ordering for sync queries
- Size prefix enables efficient seeking to specific Actions
- CRC32 checksum enables detection of partial/corrupt writes

### Durability Strategy

**Write-ahead approach (default):**
- Buffer Actions in memory with assigned GSN
- Batch fsync every 10ms or 1000 Actions (whichever comes first)
- Only ACK to client after fsync completes
- Tradeoff: ~10ms latency increase for durability guarantee

**Async mode (opt-in for high-throughput scenarios):**
- Immediate ACK, background fsync
- Higher throughput, risk of data loss on crash
- Suitable for non-critical or recoverable data

### Concurrency Model

Single-threaded writer with lock-free ingestion:
- Lock-free MPSC queue for incoming Actions
- Dedicated writer thread assigns GSN and appends
- Batch multiple Actions per fsync for throughput
- No contention on the hot write path

Alternative for lower-volume deployments: Atomic counter with CAS for GSN, mutex on file append

### Indexing Strategy

**Index Tiering for Bounded Memory:**

*Hot tier (in-memory):*
- Last N Actions (e.g., 1 million) covering recent sync queries
- `Map<EntityID, GSN[]>` - Actions containing Updates for each Entity
- `Map<GSN, file_offset>` - Direct file access by GSN
- Optional: `Map<ActorID, GSN[]>` - Actions by creator (debugging/analytics)
- Fixed memory footprint regardless of total Action history

*Cold tier (on-disk):*
- SQLite table: `action_index(gsn, entity_id, file_id, file_offset)`
- Populated during file rotation when Actions age out of hot tier
- Queries spanning hot+cold tiers merge results transparently

**Why Entity-based indexing?**
- Actions contain Updates targeting specific Entities
- Write path: Index directly from Update entity IDs (no SQLite lookup required)
- Read path: Single SQLite query for "Entities in Group X", then index lookups
- Avoids expensive SQLite queries on the hot write path

### Index Persistence (Checkpointing)

To avoid slow startup from scanning large files:
- Write index checkpoint file every N minutes (configurable, default 5 min)
- Checkpoint format: MessagePack serialized Map structures + last checkpointed GSN
- On startup: Load checkpoint, then replay only Actions since checkpoint GSN
- Reduces startup time from O(total_actions) to O(recent_actions)

Checkpoint file structure:
```
[checkpoint_gsn:8bytes][entity_index_size:4bytes][entity_index:variable][gsn_index_size:4bytes][gsn_index:variable]
```

### Sync Query Flow

```
GET /sync?groupId=X&cursor=150
↓
1. SQLite: "Which Entities belong to Group X?"
   SELECT entity_id FROM relationships WHERE target_id = 'X' AND target_type = 'Group'
↓
2. Index: For each entity_id, find Actions with GSN > 150
   entityActions = entityIndex.get(entity_id).filter(gsn => gsn > 150)
↓
3. File: Seek to offsets and read Actions
   actions = gsnOffsets.map(gsn => readActionAtOffset(gsnIndex.get(gsn)))
↓
4. Return paginated Actions to client
```

### Write Flow

```
Action arrives 
→ SQLite: Validate permissions using Groups/GroupMembers
→ Assign next GSN 
→ Append to Action log file
→ Update in-memory indexes
→ Notify SSE subscribers for affected Groups
```

### Real-time Sync (SSE)

- Maintain `Map<GroupID, Set<SSE_connections>>` for active subscriptions
- On Action write: lookup affected Groups via Entity→Group relationships in SQLite
- Push new Actions to subscribers immediately after file write

## Operational Characteristics

### Advantages
- **Simple**: Just a file + SQLite, no external dependencies
- **High performance**: Append-only writes handle 100k+ ops/second
- **Debuggable**: Can inspect Action log file directly
- **Operationally simple**: Aligns with single-server requirement
- **Natural ordering**: GSN-based file structure matches sync needs

### Disadvantages
- **Checkpoint management**: Requires periodic checkpoint writes (mitigated by configurable interval)
- **No built-in compression**: Could add later if file size becomes issue
- **Cold tier queries slower**: Historical queries hit SQLite index instead of memory
- **Complexity**: Two-tier indexing adds implementation complexity vs. simple in-memory approach

### File Management Strategy

**Rotation:**
- Rotate at 1GB or 10M Actions (whichever comes first)
- Maintain manifest file with active log files:
  ```json
  {
    "files": [
      {"id": 1, "path": "actions_001.log", "min_gsn": 1, "max_gsn": 5000000},
      {"id": 2, "path": "actions_002.log", "min_gsn": 5000001, "max_gsn": null}
    ],
    "active_file_id": 2
  }
  ```
- On rotation: finalize current file's max_gsn, create new file, update manifest atomically

**Multi-file queries:**
- Sync queries determine which files span the requested GSN range via manifest
- Read Actions from each relevant file in GSN order
- Merge results transparently to caller

**Cleanup:**
- Track minimum cursor across all connected clients
- Delete files where `max_gsn < min(all_client_cursors)`
- Populate cold tier index before deletion

**Backup:**
- Simple file copying (append-only files have no corruption risk during copy)
- Copy manifest + all log files for consistent backup

### Crash Recovery

**Partial write detection using CRC32:**

On startup or recovery:
1. Load last known-good checkpoint
2. Scan Action log from checkpoint GSN forward
3. For each record:
   - Read header (GSN + Size)
   - Read payload + CRC32
   - Validate CRC32 matches computed checksum
4. On first invalid/incomplete record:
   - Truncate file at that offset
   - Log warning with last valid GSN
5. Rebuild in-memory indexes from valid records only

**Recovery guarantees:**
- No silent data corruption (CRC validates every record)
- At most one Action lost on crash (the in-flight write)
- Automatic truncation of partial writes

## Implementation Phases

### Phase 1: Core Action Log
- Implement append-only file writer
- Build Entity-based indexing
- Basic sync query support

### Phase 2: Integration
- Connect to existing SQLite permission system
- Implement SSE notifications
- Add file rotation

### Phase 3: Optimization
- Add compression if needed
- Optimize index data structures
- Performance tuning

## Alternative Considered

**RocksDB/LevelDB**: Would handle high write throughput but adds operational complexity and external dependencies. The append-only file approach leverages Ebb's specific access patterns (append-only writes, GSN-ordered reads) for maximum simplicity.

## Success Metrics

- Handle 100,000 Actions/second sustained write load
- Sub-100ms sync query response times
- Single-server deployment with minimal operational overhead
- Maintain all existing Ebb consistency and atomicity guarantees