---
title: "The Data Model"
description: "Entities, Actions, Updates, Snapshots, typed fields, and materialization."
---

> **Note — Forward-looking API outline.** This document describes the planned v1 data model. The **server-side storage is implemented** (RocksDB action log + on-demand SQLite materialization; see `ebb_server/`), and **`@ebbjs/core` defines the schemas for Actions, Updates, Entities, and the typed-field envelope**. The high-level model described here — typed fields, typed-field merge dispatch, snapshot pointers, etc. — is the **target design** for the client SDK and the docs may diverge from what the current in-memory `@ebbjs/storage` adapter actually implements (which uses HLC + lexicographic `update_id` tiebreak for all fields rather than a per-type dispatch table).

`@ebbjs/db` is the planned name for the storage layer that will back `@ebbjs/client` and `ebb_server`. Today, those layers ship separately: server storage lives in `ebb_server/` (RocksDB + SQLite), and client storage lives in `@ebbjs/storage` (currently in-memory only). On the server, Ebb uses SQLite. On the client, storage is pluggable—IndexedDB, SQLite, or in-memory, depending on your platform and needs.

Ebb represents your application data as a series of `Entities`, `Actions`, and `Updates`.

`Entities` are the metadata container for your records that maintain their relationships to other Entities.

`Actions` are the atomic unit of change in Ebb. Every write operation—whether creating a single entity or a complex multi-entity operation—is an Action. An Action contains one or more Updates that are accepted, synced, and applied together as a single unit.

`Updates` are the individual mutations within an Action. Each Update targets a single Entity and is comprised of a `subject_id`, `subject_type`, `data` blob, and a `method`. The `method` is either `PATCH`, `PUT`, or `DELETE`. Every Update belongs to exactly one Action.

`PATCH` is used for partial changes. `PUT` is used for a full-state upsert. `DELETE` is used to remove/tombstone an Entity.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Data Model                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐                                                          │
│   │   Entity     │                                                          │
│   ├──────────────┤                                                          │
│   │ id           │◄──────────────────────┐                                  │
│   │ type         │                       │                                  │
│   │ ...metadata  │                       │                                  │
│   └──────────────┘                       │                                  │
│                                          │                                  │
│   ┌──────────────┐       ┌───────────────┴───────────────────────────────┐  │
│   │   Action     │       │              Updates                          │  │
│   ├──────────────┤       ├───────────────────────────────────────────────┤  │
│   │ id           │◄─────┐│ id          │ action_id  │ subject_id│ method │  │
│   │ actor_id     │      ││─────────────┼────────────┼───────────┼────────│  │
│   │ hlc          │      ││ upd_001     │ act_001    │ ent_123   │ PUT    │  │
│   │ gsn          │      ││ upd_002     │ act_001    │ rel_789   │ PUT    │  │
│   └──────────────┘      ││ upd_003     │ act_002    │ ent_123   │ PATCH  │  │
│                         ││ upd_004     │ act_003    │ ent_456   │ PUT    │  │
│   ┌──────────────┐      ││ upd_005     │ act_003    │ rel_012   │ PUT    │  │
│   │  Snapshot    │      │└───────────────────────────────────────────────┘  │
│   ├──────────────┤      │                                                   │
│   │ entity_id ───┼──────┘ (points to last PUT update)                       │
│   │ update_id    │                                                          │
│   └──────────────┘                                                          │
│                                                                             │
│   Sync unit: Action (contains 1+ Updates)                                   │
│   Materialization: Snapshot ──► replay Updates in HLC order ──► View        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Notice how `act_001` contains two Updates: creating an Entity and its Group membership Relationship. These are synced and applied together—there is no window where a client sees the Entity without its Group membership.

Single-entity writes (like `act_002`, a simple patch) are also Actions—just with one Update. This means Actions are the universal primitive for all writes, not a special grouping mechanism layered on top.

Using these tables, Ebb materializes a `View` of an Entity by playing back all of the Updates in the system pertaining to that Entity since its last `Snapshot`.

A `Snapshot` is a pointer to the last `PUT` Update for a given Entity. This is useful for compacting the Update table and speeding up materialization.

## Typed fields

Each field on an Entity declares a **type** that determines how its values are stored and how concurrent updates are merged. The type is embedded in the stored field value itself, making the storage layer self-describing—the server does not need a schema to materialize entities.

Ebb supports the following field types:

**LWW fields** (`e.string()`, `e.number()`, `e.boolean()`) — The field's value is a plain JSON value. Concurrent updates to the same field are resolved using last-write-wins (LWW) based on [HLC](/docs/v1-target/clock) timestamps. This is appropriate for most application data.

**Counter fields** (`e.counter()`) — The field's value is a G-Counter CRDT—a map of actor IDs to per-actor counts. The total value is the sum of all actors' counts. Concurrent increments from different actors never conflict; they are additive by definition. This is appropriate for like counts, view counts, or any value where concurrent increments must all be preserved.

**Collaborative text fields** (`e.collaborativeText()`) — **Planned, not yet implemented.** The intended approach is a causal-tree of character runs (each node carries a parent reference) ordered by [HLC](/docs/v1-target/clock), using the same Action/Update primitives as every other field type. This is the approach described in the [April 2026 devlog post](/devlog/how-collaborative-editing-works) and prototyped in `experiment/collaborative-text/`. **Yjs is not used.**

Types are declared in your model definition and travel with the data at the field level:

```ts
import { defineModel, e } from "@ebbjs/core";

const post = defineModel("post", {
  title: e.string(),
  body: e.collaborativeText(),
  published: e.boolean(),
  likes: e.counter(),
});
```

Different field types can coexist on the same Entity. A `Post` can have LWW fields (`title`, `published`), a counter (`likes`), and a collaborative text document (`body`)—all on a single Entity with no need for separate entities or relationships to model different merge strategies.

### Stored format

Each field value is stored as a self-describing object with a `type` tag:

```json
{
  "fields": {
    "title": { "type": "lww", "value": "My Post", "hlc": 1711234567890000 },
    "published": { "type": "lww", "value": true, "hlc": 1711234567890000 },
    "likes": { "type": "counter", "value": { "alice": 3, "bob": 1 } },
    "body": { "type": "causal-tree", "value": "<encoded run-node tree>" }
  }
}
```

The `type` tag tells the materialization engine which merge function to use for each field independently. This makes the server schema-agnostic—it reads the type from the stored data rather than consulting an external schema registry.

### Client operations

LWW fields use the standard update API:

```ts
await client.post.update(post.id, { title: "New Title" });
```

Counter fields expose increment and decrement operations:

```ts
await client.post.increment(post.id, "likes");
await client.post.decrement(post.id, "likes");
```

Collaborative text fields will provide access to the underlying causal-tree document (target API — not implemented yet):

```ts
// Planned API — not implemented
const tree = client.post.getText(post.id, "body");
```

### Extensibility

The typed field system is a dispatch table—each type registers how to merge, validate, compact, and expose operations. Adding a new field type in the future (e.g., sets, ordered lists, maps) requires registering a new entry in this table without changing the underlying Entity, Action, or Update structures.

## Materialization

Entity data is materialized by replaying Updates field-by-field, dispatching to the appropriate merge function based on each field's `type` tag.

For **LWW fields**, concurrent `PATCH`es to _different_ fields both apply—they don't conflict. Concurrent `PATCH`es to the _same_ LWW field use HLC to pick a winner (higher timestamp wins).

For **counter fields**, concurrent increments from different actors are additive. Each actor's count is tracked independently, and the total is the sum. No HLC comparison is needed—the merge is commutative and conflict-free.

For **collaborative text fields** (planned), the causal tree handles concurrent edits at the character level. Merging follows the same HLC + lexicographic tiebreak as LWW fields — conflict surfacing is handled at the Action/Update layer rather than buried inside the data structure (see [devlog on CRDTs](/devlog/how-collaborative-editing-works)).

To materialize an `Entity`, we start at the last `PUT` update for that entity and play forward all subsequent `PATCH` (or `DELETE`) updates in [HLC](/docs/v1-target/clock) order. For each field in each update, we read the field's `type` tag and dispatch to the corresponding merge function. Materialization operates at the Update level—Action boundaries don't matter here. Updates from different Actions are interleaved by HLC order during replay.

`Snapshots` are a convenience pointer to the last `PUT` update for a given `Entity`—simply an `(entity_id, update_id)` pair. They serve two purposes:

1. **Compaction**: We don't need to replay the entire update history, just everything after the snapshot.
2. **Visibility**: Entities that do not have a snapshot do not appear on the client, even if there are updates for them in the update log. This means an `Entity` only becomes "real" once it receives its first `PUT` update.

**Conflict detection:** When a client makes changes offline and those changes overlap with changes that happened on the server (or other clients) while the client was away, Ebb detects a conflict. The behavior depends on the field type:

**Conflicts for LWW fields:** When a conflict is detected, Ebb performs field-level LWW merge as normal. It then writes two entries to the Conflicts table: the **desired state** (the base state before the conflicting Action was made, with the optimistic Action applied on top) and the **base state** (the Entity state before the conflicting Action, without the optimistic changes). This gives the application everything it needs to show the user what they intended, what the state was before their change, and what the merged result actually is.

**Conflicts for counter fields:** Counter fields are conflict-free by definition—concurrent increments from different actors are additive, not competing. No conflict detection is needed.

**Conflicts for collaborative text fields** (planned): When a collaborative text field changes while the client is offline, Ebb detects the concurrent edits via HLC comparison. The pre-merge state is snapshotted to the Conflicts table — the same approach used for LWW fields, applied at the character-run level. The framework surfaces the conflict rather than silently merging; resolution is a human decision (see [devlog on conflict-surfacing](/devlog/how-collaborative-editing-works)).

**Compaction for collaborative text fields** (planned): Run nodes carry their own history (the `parentId` chain and the HLC of each insertion); no separate snapshot mechanism is needed for the field itself.
