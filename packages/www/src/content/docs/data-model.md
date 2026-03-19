---
title: "The Data Model"
description: "Entities, Actions, Updates, Snapshots, entity formats, and materialization."
---

`@ebbjs/db` contains the complete set of interfaces and adapters that allow Ebb apps to work offline and still stay in sync. On the server, Ebb uses SQLite. On the client, storage is pluggable—IndexedDB, SQLite, or in-memory, depending on your platform and needs.

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

## Entity formats

Each Entity type declares a format that determines how its `data` blob is structured and how updates are merged. Ebb supports two formats:

**JSON format** (default) — The Entity's data is a JSON object. `PUT` writes the full state; `PATCH` writes a partial update to specific fields. Merging uses field-level last-write-wins (LWW) based on HLC timestamps. This is the format described throughout this document and is appropriate for most application data.

**CRDT format** — The Entity's data is a Yjs document. `PUT` writes the full document state (`Y.encodeStateAsUpdate`); `PATCH` writes an incremental Yjs update. Merging uses Yjs's built-in CRDT merge algorithm. This format is appropriate for collaborative text documents, whiteboards, or other content where character-level concurrent editing is expected.

The format applies to the whole Entity—you cannot mix formats within a single Entity. If you need LWW metadata alongside a CRDT document (e.g., a `Post` with a title and a collaborative body), model them as two Entities with a [Relationship](/docs/relationships): a JSON-format `Post` and a CRDT-format `PostBody`.

**Conflict detection:** When a client makes changes offline and those changes overlap with changes that happened on the server (or other clients) while the client was away, Ebb detects a conflict. In both cases, Ebb automatically merges the changes and records the conflict in the Conflicts table so that applications can surface or resolve it if needed.

**Conflicts for JSON Entities:** When a conflict is detected for a JSON Entity, Ebb performs field-level LWW merge as normal. It then writes two entries to the Conflicts table: the **desired state** (the base state before the conflicting Action was made, with the optimistic Action applied on top) and the **base state** (the Entity state before the conflicting Action, without the optimistic changes). This gives the application everything it needs to show the user what they intended, what the state was before their change, and what the merged result actually is.

**Conflicts for CRDT Entities:** When a CRDT Entity changes while the client is offline, Yjs merges the updates automatically. Ebb still detects this scenario and snapshots the pre-merge state to the Conflicts table. This allows developers to surface "here's what the document looked like before the merge" if needed—even though the merge has already happened.

**Compaction for CRDT Entities:** CRDT Entities rely on Yjs's internal compaction via `encodeStateAsUpdate`. The full document history is embedded in the Yjs state rather than managed through Ebb's Snapshot mechanism.

## Materialization

Entity data is modeled as a field-level last-write-wins (LWW) register. `PUT` updates are full state writes. `PATCH` updates are JSON patches that modify individual fields.

This means concurrent `PATCH`es to _different_ fields both apply—they don't conflict. Concurrent `PATCH`es to the _same_ field use HLC to pick a winner (higher timestamp wins).

To materialize an `Entity`, we start at the last `PUT` update for that entity and play forward all subsequent `PATCH` (or `DELETE`) updates in [HLC](/docs/clock) order until we arrive at the current state. Materialization operates at the Update level—Action boundaries don't matter here. Updates from different Actions are interleaved by HLC order during replay.

`Snapshots` are a convenience pointer to the last `PUT` update for a given `Entity`—simply an `(entity_id, update_id)` pair. They serve two purposes:

1. **Compaction**: We don't need to replay the entire update history, just everything after the snapshot.
2. **Visibility**: Entities that do not have a snapshot do not appear on the client, even if there are updates for them in the update log. This means an `Entity` only becomes "real" once it receives its first `PUT` update.
