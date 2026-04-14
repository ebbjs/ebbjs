# @ebbjs/storage

## Purpose

Provides a storage adapter interface for @ebbjs/client. The adapter pattern allows different storage backends (memory, IndexedDB, etc.) to be swapped without changing client code. v1 includes only an in-memory adapter.

## Responsibilities

- Define the `StorageAdapter` interface
- Provide an in-memory implementation for v1
- Track per-group cursors (GSN)
- Maintain action outbox with status tracking

## Alignment with Server

The server uses **GSN (Global Sequence Number)** as the cursor for catch-up and SSE:

| Server Concept | Client Storage |
|---------------|----------------|
| GSN | Integer (server assigns on commit) |
| `stream-next-offset` header | Stored as `nextOffset` |
| `/sync/live?cursor={gsn}` | Client passes cursor to SSE |
| `/sync/groups/:group_id?offset={gsn}` | Client passes offset for pagination |

**Important**: Server returns HLC as integer in responses, but cursors are GSN integers. Client stores cursors as numbers for direct server API usage.

## Public interface

### StorageAdapter Interface

```typescript
interface StorageAdapter {
  // Entity cache operations
  entities: {
    get(id: string): Promise<Entity | null>;
    put(entity: Entity): Promise<void>;
    delete(id: string): Promise<void>;
    query(type: string, filters?: Record<string, unknown>): Promise<Entity[]>;
  };

  // Update log operations (for sync tracking)
  updates: {
    // Find updates for catch-up (sorted by HLC, filtered by group)
    findForSync(opts: {
      groupId: GroupId;
      afterHlc: HLCTimestamp;
      limit: number;
    }): Promise<Update[]>;
    put(update: Update): Promise<void>;
  };

  // Group cursor tracking (GSN, not HLC)
  cursors: {
    // Get current GSN cursor for a group
    get(groupId: GroupId): Promise<number | null>;
    // Set cursor after catch-up or SSE event
    set(groupId: GroupId, cursor: number): Promise<void>;
  };

  // Action outbox
  outbox: {
    getPending(): Promise<OutboxEntry[]>;
    put(entry: OutboxEntry): Promise<void>;
    updateStatus(id: string, status: OutboxStatus): Promise<void>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
  };

  // Subscription for real-time updates
  subscribe(callback: (update: Update) => void): () => void;

  // Reset storage (for testing)
  reset(): Promise<void>;
}

// Outbox entry
interface OutboxEntry {
  id: string;            // Action ID
  action: Action;       // The action to sync
  status: OutboxStatus;
  retryCount: number;
  error?: string;
}

type OutboxStatus = "pending" | "syncing" | "failed" | "conflict";
```

### In-Memory Adapter Factory

```typescript
import { createMemoryAdapter } from "@ebbjs/storage";

const storage = createMemoryAdapter();

// Or with initial state
const storage = createMemoryAdapter({
  initialEntities?: Map<string, Entity>;
  initialCursors?: Map<GroupId, number>;
});
```

### Types (from @ebbjs/core)

```typescript
import type { Action, Entity, Update, GroupId, HLCTimestamp } from "@ebbjs/core";
```

## Dependencies

- `@ebbjs/core` — for shared types (`Action`, `Entity`, `Update`, etc.)

## Internal design notes

### Cursor vs HLC

- **Cursors** are GSNs (integers) — used for `/sync/live?cursor=` and `/sync/groups/:group_id?offset=`
- **HLCTimestamps** are HLC strings — used for ordering within storage and comparing update precedence

The storage adapter translates between them:
```typescript
// When server returns action with gsn: 501
storage.cursors.set("group_abc", 501);

// When querying updates
const updates = storage.updates.findForSync({
  groupId: "group_abc",
  afterHlc: "1711036800001",  // HLC string for ordering
  limit: 100
});
```

### In-Memory Implementation

```typescript
class MemoryStorage implements StorageAdapter {
  private entities = new Map<string, Entity>();
  private updates: Update[] = [];
  private cursors = new Map<GroupId, number>();
  private outboxEntries = new Map<string, OutboxEntry>();
  private listeners = new Set<(update: Update) => void>();

  updates.findForSync = async ({ groupId, afterHlc, limit }) => {
    // Filter updates after cursor, sort by HLC, limit
    return this.updates
      .filter(u => u.hlc > afterHlc)
      .sort((a, b) => compareHLC(a.hlc, b.hlc))
      .slice(0, limit);
  };

  cursors.get = async (groupId) => this.cursors.get(groupId) ?? null;
  cursors.set = async (groupId, cursor) => this.cursors.set(groupId, cursor);
}
```

### Key Design Decisions

- Cursors stored as **numbers** (GSN) for direct server API usage
- Updates stored as flat array, filtered/sorted by **HLC** on read
- Outbox uses status field for filtering (no separate pending/complete stores)
- Subscriptions fire synchronously on `put` for immediate invalidation
- No persistence in v1 — data lost on page refresh

## Open questions

- Should the memory adapter support transactions for testing?
- Do we need snapshot storage for materialization in v1?
- Any need for batch operations in the interface?

## References

- Server: `lib/ebb_server/sync/router.ex` — SSE and catch-up endpoints
- Server: `lib/ebb_server/sync/sse_connection.ex` — SSE streaming
- zuko storage adapter: [zuko storage adapter interface](https://github.com/drewlyton/zuko/tree/main/packages/core/src/adapters/storage.ts)