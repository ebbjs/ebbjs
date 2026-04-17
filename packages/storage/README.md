# @ebbjs/storage

Local-first storage adapters for the ebbjs client. Provides an interface for caching and querying entity data, with a full in-memory implementation for v1.

## Components

| Component          | Purpose                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| **ActionLog**      | Stores received actions. Provides entity-level queries for materialization.                                  |
| **DirtyTracker**   | Tracks which entities need rematerialization. Queryable by type.                                             |
| **EntityStore**    | Materialized entity cache. Handles `get` (by ID) and `query` (by type).                                      |
| **CursorStore**    | Per-group GSN cursor tracking for sync resumption.                                                           |
| **StorageAdapter** | Unified interface composing all components. `createMemoryAdapter()` returns a full in-memory implementation. |

## Usage

```typescript
import { createMemoryAdapter } from "@ebbjs/storage";

const storage = createMemoryAdapter();

// Append an action (marks affected entities dirty)
await storage.actions.append(action);

// Get a single entity (materializes if dirty)
const entity = await storage.entities.get("todo_1");

// Query all entities of a type
const todos = await storage.entities.query("todo");
```

## Architecture

Entities are materialized on-demand from the action log when they are dirty. This mirrors the server's materialized cache behavior — actions are the source of truth, entities are derived views.

```
Client receives action
        │
        ▼
  ActionLog.append()
        │
        ▼
  DirtyTracker.mark() — marks affected entity IDs dirty
        │
        ▼
  EntityStore.get() / .query() — materializes dirty entities
        │
        ▼
  Replays actions for each dirty entity, clears dirty flag
```

## Constraints

- **v1 is read-only** — write path (outbox, optimistic updates) deferred to future iteration
- **Actions are append-only** — never modified or deleted; rollbacks handled by compensating actions
- **Materialization is lazy** — entities only rematerialized when read, not eagerly on action receipt
- **HLC + lexicographic tiebreak** — same merge semantics as server (higher HLC wins, tiebreak by `update_id`)

## Future Adapters

- **SQLite** — persistent browser/storage adapter
- **IndexedDB** — persistent browser adapter
