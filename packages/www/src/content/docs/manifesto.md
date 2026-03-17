---
title: "ebb"
description: "make the network optional."
---

# ebb

Make the network optional.

## Why?

Ebb was born because building a collaborative, offline-capable app was way too hard.

I wanted to build a simple notes app. Users create notes, edit them, share with others. Write while they're on a plane and sync back when they touch down. Collaborative in real-time with awareness and presence.

How hard could it be?

I started with Postgres and a WebSocket layer. Then I needed offline writes, so I added a local database and a sync protocol. Then I had to handle what happens when two clients edit the same note, so I started building conflict resolution. Then I needed to control who could see and edit what — in a way that worked even when a client hadn't been online in days — so I started building a permission system. Then I needed to handle clients reconnecting with a backlog of pending writes, so I started building an outbox with retry logic and state tracking. Then I needed schema migrations that wouldn't break offline clients still running the old version.

Months in, I was deep in distributed systems plumbing and hadn't shipped a single feature of the actual notes app.

This is the reality of local-first development today. The tools we reach for — Postgres, MySQL, even SQLite — are excellent at what they were designed for. But they were designed for a world where the server is the source of truth and clients are dumb terminals. The moment you need clients to be autonomous — reading, writing, and resolving conflicts without a server in the loop — you're on your own.

Ebb exists because that's absurd. Every offline-capable app needs the same set of hard primitives: sync, conflict resolution, permissions, schema evolution, garbage collection. These are solved problems — they just haven't been packaged in a way that TypeScript developers can actually use.

Ebb packages them. You write application logic, we take care of the rest.

## How?

Ebb gives you a complete stack for building local-first applications:

- **`@ebbjs/db`** — A relational data model built on SQLite (server) and pluggable storage (client) that handles offline writes, partial replication, and eventual consistency out of the box.
- **`@ebbjs/client`** — An ORM and sync client that manages your local data, optimistically applies writes, and keeps everything in sync — online or off.
- **`@ebbjs/server`** — The server runtime that handles sync connections, permission enforcement, Action validation, and server-to-server replication.
- **`@ebbjs/react`** — React bindings that make your UI reactive to data changes with zero boilerplate.

Define your models once. Ebb handles syncing them across every node in your system, enforcing permissions, detecting and surfacing conflicts, evolving your schema, and cleaning up after itself.

## Table of Contents

- [Under the hood](#under-the-hood)
  - [The data model](#the-data-model)
    - [Entity formats](#entity-formats)
    - [Relationships](#relationships)
    - [Groups and membership](#groups-and-membership)
    - [Actors](#actors)
  - [Tic tock (HLC)](#tic-tock)
  - [Sync](#sync)
    - [Dual timestamp system](#dual-timestamp-system)
    - [Server-client](#server-client)
    - [Client failover](#client-failover)
    - [Server-server](#server-server)
    - [Client-to-server writes](#client-to-server-writes)
  - [Permission enforcement](#permission-enforcement)
  - [Materialization](#materialization)
  - [The client](#the-client)
  - [Conflict resolution](#conflict-resolution)
  - [Garbage collection](#garbage-collection)
  - [Schema evolution](#schema-evolution)
  - [Observability & analytics](#observability--analytics)

## Under the hood

The rest of this document explains how Ebb works — the data model, sync protocol, permission system, and everything else that makes the above possible.

### The data-model

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

#### Entity formats

Each Entity type declares a format that determines how its `data` blob is structured and how updates are merged. Ebb supports two formats:

**JSON format** (default) — The Entity's data is a JSON object. `PUT` writes the full state; `PATCH` writes a partial update to specific fields. Merging uses field-level last-write-wins (LWW) based on HLC timestamps. This is the format described throughout this document and is appropriate for most application data.

**CRDT format** — The Entity's data is a Yjs document. `PUT` writes the full document state (`Y.encodeStateAsUpdate`); `PATCH` writes an incremental Yjs update. Merging uses Yjs's built-in CRDT merge algorithm. This format is appropriate for collaborative text documents, whiteboards, or other content where character-level concurrent editing is expected.

The format applies to the whole Entity—you cannot mix formats within a single Entity. If you need LWW metadata alongside a CRDT document (e.g., a `Post` with a title and a collaborative body), model them as two Entities with a Relationship: a JSON-format `Post` and a CRDT-format `PostBody`.

**Conflict detection:** When a client makes changes offline and those changes overlap with changes that happened on the server (or other clients) while the client was away, Ebb detects a conflict. In both cases, Ebb automatically merges the changes and records the conflict in the Conflicts table so that applications can surface or resolve it if needed.

**Conflicts for JSON Entities:** When a conflict is detected for a JSON Entity, Ebb performs field-level LWW merge as normal. It then writes two entries to the Conflicts table: the **desired state** (the base state before the conflicting Action was made, with the optimistic Action applied on top) and the **base state** (the Entity state before the conflicting Action, without the optimistic changes). This gives the application everything it needs to show the user what they intended, what the state was before their change, and what the merged result actually is.

**Conflicts for CRDT Entities:** When a CRDT Entity changes while the client is offline, Yjs merges the updates automatically. Ebb still detects this scenario and snapshots the pre-merge state to the Conflicts table. This allows developers to surface "here's what the document looked like before the merge" if needed—even though the merge has already happened.

**Compaction for CRDT Entities:** CRDT Entities rely on Yjs's internal compaction via `encodeStateAsUpdate`. The full document history is embedded in the Yjs state rather than managed through Ebb's Snapshot mechanism.

#### Relationships

Entities can relate to other Entities. These relationships are themselves Entities — a `Relationship` Entity with a `source_id` and `target_id`.

This means relationships flow through the same sync mechanism, have their own update history, and can be created/deleted like any other Entity. When you create a Todo that belongs to a List, you're actually creating two Entities in a single Action: the Todo and the Relationship linking it to the List.

**Entity IDs** are generated by the creating node—whether that's a client or server. This allows offline creation without coordination. IDs are 26-character nano-IDs with type prefixes (e.g., `g-` for Groups, `a-` for Actors). Action and Update IDs follow the same format.

**Relationship permissions (default):** To create or delete a Relationship, you need `update` permission on the **source** Entity. If you can update a Todo, you can decide which List it belongs to.

This default can be overridden for specific relationship types if your application needs different rules.

**Dangling references:** When you delete an Entity, Ebb does not automatically delete or update Relationships that point to it. This means you can end up with dangling references—a Todo that references a List that no longer exists.

This is intentional. Different applications want different behaviors: cascade delete, nullify the reference, block deletion, or allow the dangle and handle it in the UI. Ebb doesn't pick a policy for you—it's up to your application logic to decide what dangling references mean and how to handle them.

The exception is Group membership. Because Groups define sync boundaries and permissions, an Entity _must_ belong to at least one Group. Deleting a Group is blocked if it still contains Entities (see "Deleting Groups" below).

#### Groups and membership

To manage permissions and sync boundaries, Ebb provides built-in Entity types: `Group`, `GroupMember`, and a special interpretation of Relationships.

These aren't special primitives — they're just Entities with a predefined schema that Ebb understands. They flow through the same sync mechanism, materialize the same way, and follow the same conflict resolution rules as your application Entities. The only difference is that Ebb uses them internally to enforce permissions and determine sync boundaries.

**Two ways to relate to a Group:** Actors _join_ Groups (via `GroupMember` Entities), and Entities _belong to_ Groups (via Relationships). These are different mechanisms with different rules—don't confuse them. Actor membership controls _who_ can access data; Entity membership controls _what data_ lives in a Group.

**Entity membership** is modeled as a Relationship where the target is a Group. Every Entity must belong to at least one Group—this is enforced at both creation and deletion time. When you create an Entity, you must also create its Group membership Relationship in the same Action. And you cannot remove an Entity's last Group membership—if you want the Entity gone, delete the Entity itself.

When Ebb sees a Relationship pointing to a Group, it interprets that as "this Entity is a member of this Group" — which has implications for sync boundaries and permissions.

**Membership permissions:** Unlike regular Relationships, Group membership has a fixed permission rule. To add an Entity to a Group, you need `<type>.create` permission in the **target** Group. This makes sense because you're saying "this Entity should be visible and governed by this Group."

`GroupMember` is a junction Entity between an `Actor` and a `Group`. GroupMembers are implicitly granted read access to all Entities in the Group, but they are explicitly provided write permissions for both Entities and the Group itself through their `permissions` field.

The `permissions` field is an array of strings with the format `<type>.<action>` where `type` is the type of the Entity and `action` is `create`, `update`, or `delete`. To grant full write permissions to a GroupMember, you can simply put `*` in their `permissions` array.

**Membership management**

Adding someone to a Group requires creating a GroupMember—which means you need `groupMember.create` permission in that Group. But to have that permission, you must already be a member. This is intentional: Groups are closed by default, and only existing members can invite new ones.

This means invite flows (links, codes, approval requests) are something you build on top of Ebb's primitives. A common pattern is to use a **service account**—an Actor representing your server or a background process—that holds `groupMember.create` permission across many Groups. Your application handles the invite logic (validating links, checking approvals, etc.), and the service account creates the GroupMember once the request is approved.

Ebb provides the access control primitives; the invite _policy_ is up to you.

**Deleting Groups**

A Group cannot be deleted while it still contains Entities or GroupMembers. Attempting to delete a non-empty Group will fail. This is intentional—it forces you to explicitly decide what happens to the Entities (move them to another Group, delete them individually, etc.) and remove all members before the Group can be deleted.

This also avoids the ambiguity of Entities that belong to multiple Groups. If cascade deletion were automatic, deleting one Group could destroy data that's still accessible through another Group—a surprising and potentially dangerous behavior.

**Online-only operations**

Mutations to Groups and GroupMembers require connectivity—they cannot be performed offline. This includes creating, updating, or deleting Groups, as well as adding, modifying, or removing GroupMembers.

This constraint exists because these entities are structural—they define who can sync what. Allowing these changes offline could create inconsistent states that are difficult to resolve—for example, a user removed from a Group continuing to sync until the change propagates, or a Group deleted on one node while others are still writing to it.

Changing which Groups an _Entity_ belongs to (adding or removing Group membership Relationships) works offline like any other Entity operation. These changes affect what data syncs to whom, but they flow through the normal sync mechanism and converge like any other update.

In practice, the online-only constraint is rarely limiting. Group and GroupMember changes are infrequent compared to regular Entity operations.

#### Actors

**Actors** are Ebb's identity abstraction. An Actor might represent a user, but it could also be a server process, an AI agent, a CRON job, or any other system that needs to read or write data.

To integrate your authentication system with Ebb, you implement an `authenticate` callback on the server. This callback receives the incoming request and returns an `actor_id`—typically a user ID from your auth system, but it could be any stable identifier. Ebb handles the rest: if an Actor with that ID already exists, it proceeds; if not, it creates one automatically.

Actors exist outside the sync mechanism. They're the starting point that lets a client bootstrap into the system: authenticate → get Actor ID → query for GroupMember records → now you know what you can sync.

A newly created Actor has no GroupMember relationships—they start completely isolated with no access to any data. From there, they can either create a new Group (which automatically makes them a GroupMember with full permissions) or be added to an existing Group by someone who has permission to do so.

And _that's it_. That's the entire data model of an Ebb app.

**A note on what gets synced:** The sync stream includes _all_ Entities — not just your application Entities, but also Groups, GroupMembers, Relationships, and any other system Entities. When a client syncs, it receives the GroupMember records for _all_ members of the Groups it belongs to—not just its own. This is how the client knows what it's allowed to do locally, and how it can display information about other members of the same Groups.

**Actors don't sync, but Profiles can:** Since Actors exist outside the sync mechanism, a client only sees other members as `actor_id` references on GroupMember records. If your application needs to display member names, avatars, or other profile data, model a `Profile` as a regular application Entity that belongs to the same Groups as the Actor's GroupMembers. Since GroupMember mutations are online-only, maintaining this—adding a Profile's Group membership whenever a GroupMember is created, removing it when one is deleted—can be handled in the same online context without offline coordination concerns.

### Tic tock

To create a total ordering of all the `Actions` across all nodes, which allows all nodes to materialize the same state given all the same updates, we use a Hybrid-Logical Clock (HLC).

Each `Action` is marked with a 64-bit integer `timestamp` generated by the node that creates it (client or server). All Updates within an Action share this timestamp. Ebb detects clock drift when Actions arrive—if a timestamp is too far in the future relative to the server's clock, the Action is rejected.

The timestamp is comprised of:

1. Logical Time (l) — Upper 48 bits
   - Represents milliseconds since Unix epoch
   - Tracks the physical (wall clock) time
   - Extracted by right-shifting the HLC by 16 bits: hlc >> 16
2. Counter (c) — Lower 16 bits
   - Increments when multiple events occur within the same millisecond
   - Allows distinguishing between events that happen simultaneously
   - Extracted using a mask: hlc & 0xFFFF (65,535 max value)

```
┌─────────────────────────────────────────────────────────────────┐
│                    64-bit HLC Timestamp                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────────────────────────┬────────────────────┐   │
│  │     Logical Time (48 bits)         │  Counter (16 bits) │   │
│  │     ms since Unix epoch            │  0 - 65,535        │   │
│  └────────────────────────────────────┴────────────────────┘   │
│  │◄─────────── hlc >> 16 ────────────►│◄── hlc & 0xFFFF ──►│   │
│                                                                 │
│  Example: Two events in same millisecond                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Event A: 1710000000000 | 0    ──►  0x18E1B5C5800_0000   │  │
│  │  Event B: 1710000000000 | 1    ──►  0x18E1B5C5800_0001   │  │
│  │                                                          │  │
│  │  Event B > Event A (counter breaks the tie)              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

These HLC `timestamps` are what allow the entire system to achieve eventual consistency even with inconsistent connections between nodes.

HLCs are the primitive that enables eventual consistency, but arriving at it is what we can define as...

### Sync

In Ebb, `Groups` are our sync boundary. Each node can be seen as containing a partial replica of all the data in the our application based on a set of `Groups` that node is subscribed to.

We can think of our goal of our sync engine in Ebb as: "How do I ensure two nodes have the same `Actions` for a given `Group`".

This leaves us with a well-defined, but not trivial problem to solve. To solve it, we'll need three main pieces that any replication system needs to have:

1. The replication log.
2. The pub/sub system.
3. The consensus protocol.

The replication log is the ordered list of `Actions`. However, partitioning Actions efficiently by `Group` requires looking up which Entities belong to a Group and then finding Actions that contain Updates targeting those Entities.

This can get quite expensive to do for N `Groups` for M nodes. Especially since often times M nodes will be subscribed to an overlapping set of `Groups`.

So, our pub/sub service actually creates subscriptions on demand to individual `Groups` in the system as a kind of "topic". Then, when a node wants to start subscribe to that topic, they are just added to that topics subscription list.

This allows us to "fan-in" the N `Group` feeds to M nodes. This can mean that, if two `Groups` have a high amount of overlapping `Entities`, the node will receive duplicate Actions. However, in practice since applying an Action is idempotent, the tradeoff is simply bandwidth.

This can be mitigated by periodically auditing your system for `Entity` overlap across `Groups` if it becomes a significant cost.

#### Dual timestamp system

To handle the complexities of distributed sync, each `Action` carries two distinct timestamps:

**Global Sequence Number (GSN)**: A per-server monotonic counter assigned when the server receives/processes an Action. This solves the "client sync gap" problem by ensuring clients can request "everything after cursor X" without missing Actions due to network timing or race conditions. The GSN guarantees reliable, gap-free replication from server to client. Because the GSN is per-Action (not per-Update), an Action and all of its Updates are always a single atomic entry in the replication log.

**Hybrid Logical Clock (HLC)**: Assigned by the node that creates the Action (client or server). This maintains causal ordering across the distributed system, ensuring all nodes apply updates in the same order to materialize identical entity states. The HLC also enables proper conflict detection and is crucial for offline client edits—when a client comes back online, the HLC determines whether their offline Actions conflict with changes that happened while they were away.

The key insight: GSN is about reliable _transport_ (getting all Actions to clients), while HLC is about correct _application_ (applying updates in the right order for consistency).

You can think about replication/sync happening in three phases:

1. **Handshake** — The client authenticates and receives metadata about the sync session. This includes which Groups the client can subscribe to (based on its Actor's GroupMember records), whether the client's cursor is stale and requires a full resync, and whether the client's version is too old to proceed (triggering an "update required" message).

2. **Catch-up** — The client requests all Actions it missed since its last sync, paginated by GSN.

3. **Subscription** — Once caught up, the client subscribes to a continuous push of new Actions.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Sync Protocol Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Client                                      Server                      │
│        │                                           │                        │
│        │  ──────── 1. HANDSHAKE ─────────────────► │                        │
│        │     authenticate(actor_id)                │                        │
│        │  ◄─────────────────────────────────────── │                        │
│        │     { groups: [...], cursor_valid: true } │                        │
│        │                                           │                        │
│        │  ──────── 2. CATCH-UP ──────────────────► │                        │
│        │     GET /sync?group=X&cursor=150          │                        │
│        │  ◄─────────────────────────────────────── │                        │
│        │     [actions 151-200] + control:continue  │                        │
│        │  ────────────────────────────────────────►│                        │
│        │     GET /sync?group=X&cursor=200          │                        │
│        │  ◄─────────────────────────────────────── │                        │
│        │     [actions 201-210] + control:caught_up │                        │
│        │                                           │                        │
│        │  ════════ 3. SUBSCRIPTION ══════════════► │                        │
│        │     subscribe(groups: [X, Y, Z])          │                        │
│        │  ◄══════════════════════════════════════  │                        │
│        │     (continuous push of new actions)      │                        │
│        ▼                                           ▼                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Although the phases follow roughly the same structure, the protocol changes depending on the relationship between the two nodes.

#### Server-client

After coming online, the client requests the server for all of the `Groups` it is allowed to subscribe to based on its `actor_id`.

For each `Group`, the client requests a paginated list of `Actions` starting from a `cursor` that equals the last GSN it saw from that server.

`GET /sync?groupId=<group_id>&cursor=<gsn>`

This endpoint returns Actions ordered by GSN (ensuring no gaps in the client's view), where each Action contains its full set of Updates and its original HLC timestamp for proper state materialization. The response includes a `control` message at the end telling the client to request again or that they are up to date. Pagination always splits between Actions, never within—an Action is never split across pages.

The client continues to request and digest these messages, increasing the `cursor` based on the last GSN received until they get a `control` message notifying them they are up to date.

**GSN-based catch-up**: When a server receives an Action (either from a client or another server), it assigns the next available GSN to that Action before storing it. This means:

1. Actions are stored with both their original HLC (for causal ordering) and a server-assigned GSN (for reliable sync)
2. Clients can safely request "all Actions with GSN > X" knowing they won't miss any due to network timing
3. The server streams Actions in GSN order for client sync, but applies their Updates in HLC order for state materialization
4. Client failover requires connecting to a new server and performing a full resync, since GSNs are server-specific (see below)

#### Client failover

When a client loses its server and connects to a different one, its GSN cursors are meaningless—GSNs are local to the server that assigned them. The client must perform a full resync.

The resync is straightforward because all local writes are idempotent upserts. The client requests complete current state for each subscribed Group. As Actions, Updates, and Snapshots arrive, the client upserts them into its local store. Existing data is overwritten with the server's version; new data is inserted. The local materialized cache is rebuilt from the result.

After the full resync completes, the client inspects its local data for anything the new server didn't send back. This is data that the old server had accepted and synced to the client, but that hadn't propagated to the new server before failover. The client pushes this data to the new server through the normal Outbox flow—the new server validates and either accepts or rejects it like any other incoming Action.

The Outbox is handled the same way: pending Actions are flushed to the new server after catch-up, and conflict detection runs against the new server's state. Actions that "lose" are moved to the Conflicts table as usual.

This approach is simple and correct at the cost of bandwidth. Optimizations like HLC-based catch-up or snapshot diffing can be added later without changing the protocol semantics.

#### Server-server

Server-to-server sync follows the same fundamental model as client-server: catch-up followed by continuous subscription, with Actions as the sync unit. The difference is that it's bidirectional—both servers act as both publisher and subscriber to each other.

**Peer configuration**

Servers are configured with explicit sync peers, similar to CouchDB's replication model. Each server maintains a list of peers it should sync with, and Ebb handles the rest. This means topology is your choice:

- **Full mesh**: Every server connects to every other server. Simple, lowest latency, but connections scale as N². Works well for small clusters (3-5 servers).
- **Hub-and-spoke**: Regional servers connect to a central hub. Reduces connections, but the hub becomes a bottleneck and single point of failure.
- **Regional clusters**: Servers within a region form a full mesh, with one or more servers bridging to other regions. Good balance for geographic distribution.
- **Chain/ring**: Each server connects to one or two neighbors. Minimal connections, but high propagation latency. Rarely the right choice.

There's no "correct" topology—it depends on your latency requirements, operational complexity tolerance, and failure modes you want to optimize for.

**Sync mechanism**

Each server maintains a sync cursor per peer: `(peer_server_id, last_gsn_received)`. When Server A syncs with Server B:

1. **Catch-up**: Server A requests all Actions from Server B with GSN > cursor. Server B responds with Actions ordered by its GSN. Server A stores these Actions, assigning its own GSN to each.
2. **Subscription**: Once caught up, Server A subscribes to a continuous push of new Actions from Server B. Actions are pushed as they arrive, maintaining low latency.

This happens bidirectionally—while A catches up from B, B is also catching up from A.

**GSN handling**

As an Action propagates between servers, each server assigns its own GSN when storing it. The original HLC is preserved (for ordering and materialization), but the GSN is overwritten. This means:

- An Action has exactly one HLC (assigned at creation, never changes)
- An Action has exactly one GSN at any given server (assigned by that server)
- Servers track sync progress with peers using the peer's GSN, not the HLC

**Consistency model**

Because Actions propagate through the configured topology, an Action may take multiple hops to reach all servers. This means:

- Two servers may have temporarily divergent views of an entity
- All servers will _eventually_ converge to the same state (given connectivity)
- Convergence time depends on your topology—full mesh is fastest, sparse topologies add latency

For most applications, this eventual consistency is measured in milliseconds to low seconds. If you need stronger consistency guarantees for specific operations, that's outside Ebb's model—you'd need to build coordination on top.

**Trust-and-apply**

Server-to-server replication does not re-validate Actions. When Server A receives an Action from Server B, it stores it unconditionally—no permission checks, no schema validation. The accepting server (the first server to receive the Action from a client) is the validation gate. After that, the Action is canonical and flows through the system without further gatekeeping.

This is essential for the convergence guarantee. If servers could reject each other's accepted Actions, they would never converge to the same state. Peers are configured explicitly—you only peer with servers you control—so the trust boundary is the peer list itself.

This mirrors CouchDB's replication model, where replicated documents are accepted unconditionally by the receiving node.

**Storage failures during replication**

Even though servers don't logically reject peer Actions, a write can still fail at the storage layer—disk full, SQLite busy timeout, I/O error, etc. These are transient infrastructure failures, not validation rejections, and are handled differently:

- **During catch-up**: If a write fails, the receiving server does not advance its sync cursor. The next catch-up request re-sends the same Action. Retries use exponential backoff to avoid hammering a sick server.
- **During subscription**: If a write fails, the receiving server NACKs the Action. The sending server keeps it in the outbound buffer and retries with backoff.
- **Never skip**: Strict GSN ordering means a failed Action cannot be skipped. Subsequent Actions may depend on it (e.g., a PATCH targeting an Entity whose PUT was in the failed Action). The replication pipeline stalls until the failure is resolved. This is a correctness-over-availability trade-off.
- **Circuit breaker**: After repeated consecutive storage failures, the receiving server pauses replication from that peer and surfaces an error for operators. This prevents an infinite retry loop against a persistently broken disk or corrupted database.

Once the underlying storage issue is resolved, replication resumes from the stalled cursor and catches up normally.

#### Client-to-server writes

When a client writes data, the Action doesn't go directly to the server. Instead, it flows through the **Outbox** — a local store that buffers pending Actions and tracks their status through the sync lifecycle.

**The write flow:**

1. **Local validation** — The client checks permissions and schema locally before accepting the write. This fails fast for obvious violations (e.g., user doesn't have `post.create` permission).

2. **Optimistic apply** — The Action is written to the Outbox as **pending** and all of its Updates are immediately applied to the local materialized state. The user sees their changes right away.

3. **Flush** — Actions are pushed to the server immediately, with a short debounce to batch rapid Actions together.

4. **Server validation** — The server validates the Action (permissions, schema, etc.) with all-or-nothing semantics. If any Update in the Action fails, the entire Action is rejected.

5. **Acknowledgment** — On success, the client marks the Action as **acknowledged**. On failure, the Action is marked with an **error** and remains in the Outbox for the application to handle (retry, surface to user, discard, etc.).

6. **Confirmation via sync** — Acknowledged Actions stay in the Outbox until the client receives them back through the sync subscription with a server-assigned GSN. This proves the Action is in the canonical log and will propagate to other clients. Only then is the Action removed from the Outbox.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Client Write Flow (Outbox)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User Action          Client                           Server               │
│      │                   │                                │                 │
│      │  write(entities)  │                                │                 │
│      │──────────────────►│                                │                 │
│      │                   │                                │                 │
│      │             ┌─────▼─────┐                          │                 │
│      │             │ 1. Local  │ ──► fail fast            │                 │
│      │             │ Validate  │     if no permission     │                 │
│      │             └─────┬─────┘                          │                 │
│      │                   │                                │                 │
│      │             ┌─────▼─────┐    ┌──────────────┐      │                 │
│      │             │2. Outbox  │───►│ Materialized │      │                 │
│      │             │ (pending) │    │    Cache     │ ◄─── user sees change │
│      │             └─────┬─────┘    └──────────────┘      │                 │
│      │                   │                                │                 │
│      │             ┌─────▼─────┐  3. flush (whole Action) │                 │
│      │             │   Send    │─────────────────────────►│                 │
│      │             └─────┬─────┘                          │                 │
│      │                   │                          ┌─────▼─────┐           │
│      │                   │                          │4. Server  │           │
│      │                   │                          │ Validate  │           │
│      │                   │                          └─────┬─────┘           │
│      │                   │                                │                 │
│      │                   │◄───────────────────────────────┤                 │
│      │                   │         5. ack / error         │                 │
│      │             ┌─────▼─────┐                          │                 │
│      │             │  Outbox   │                          │                 │
│      │             │(ack/error)│                          │                 │
│      │             └─────┬─────┘                          │                 │
│      │                   │                                │                 │
│      │                   │◄═══════════════════════════════│                 │
│      │                   │    6. sync stream (with GSN)   │                 │
│      │             ┌─────▼─────┐                          │                 │
│      │             │  Remove   │                          │                 │
│      │             │from Outbox│                          │                 │
│      │             └───────────┘                          │                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Atomic delivery**

Because Actions are the sync primitive, atomicity is structural—not a protocol feature layered on top. The server accepts or rejects an entire Action. Once accepted, the Action (with all its Updates) is assigned a single GSN and flows through the sync stream as a single unit. Every client that receives the Action applies all of its Updates together. There is no window where a client sees partial state from an Action.

This matters because tuple creates are the norm in Ebb, not the exception. Creating an Entity always involves at least two Updates—the Entity itself and its Group membership Relationship. Without atomic delivery, a client could temporarily see an Entity that doesn't belong to any Group, violating a core invariant.

**Permission coherence:** All entities created or modified within an Action should share the same permission scope (target the same Groups). This ensures an Action is either fully visible or fully invisible to any given client, preserving atomicity. If you need to create entities across different permission boundaries, use separate Actions.

**Outbox states**

Each Action in the Outbox has a status:

- **pending** — Written locally, not yet sent to server
- **acknowledged** — Server accepted, waiting for sync round-trip
- **error** — Server rejected, awaiting application handling

If the client goes offline mid-flush (or before), pending Actions simply wait and retry when connectivity returns. The Outbox is durable — Actions survive app restarts.

The Outbox is observable, so applications can react to these states — showing sync indicators, surfacing errors, or implementing custom retry logic.

### Permission enforcement

Permissions are checked in two places: on the client (before writing to the Outbox) and on the server (before accepting Actions). Both run the same logic against the same data model, so they should agree — unless the client's view is stale.

#### How permission checks work

When an Actor submits an Action, Ebb checks each Update within it: "Does this Actor have permission to perform this operation on this Entity?"

The check follows this logic:

1. **Find the Entity's Groups** — Look up all Relationships where the Entity is the source and the target is a Group.

2. **Find the Actor's memberships** — Look up all GroupMember Entities for this Actor that reference any of those Groups.

3. **Check permissions** — For each GroupMember, check if its `permissions` array includes the required permission (`<type>.<action>`) or `*`.

4. **Any match wins** — If _any_ GroupMember grants the permission, the operation is allowed. This is a permissive model.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Permission Check Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Actor wants to: update Post(id=p-123)                                     │
│                                                                             │
│   Step 1: Find Entity's Groups                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  Relationships where source=p-123 AND target.type=Group              │  │
│   │                                                                      │  │
│   │  Post(p-123) ──belongs_to──► Group(g-work)                           │  │
│   │              ──belongs_to──► Group(g-shared)                         │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 2: Find Actor's memberships in those Groups                          │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  GroupMember records for Actor in [g-work, g-shared]                 │  │
│   │                                                                      │  │
│   │  Actor ──member──► g-work   { permissions: ["post.update", "..."] }  │  │
│   │        ──member──► g-shared { permissions: ["post.read"] }           │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 3: Check for required permission (post.update)                       │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  g-work membership:   ["post.update", ...] ── contains "post.update" │  │
│   │  g-shared membership: ["post.read"]        ── does NOT contain       │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 4: Any match wins ──► ALLOWED (via g-work membership)                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Permission types by action

| Action                   | Required permission                        | Notes                                                                    |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| Read an Entity           | (implicit)                                 | GroupMembers can read all Entities in their Groups                       |
| Create an Entity         | `<type>.create` in target Group(s)         | Checked against the Group(s) the Entity will belong to                   |
| Update an Entity         | `<type>.update` in any Group               | Entity must belong to at least one Group where Actor has this permission |
| Delete an Entity         | `<type>.delete` in any Group               | Same as update                                                           |
| Add Entity to Group      | `<type>.create` in target Group            | You're effectively "creating" the Entity's presence in that Group        |
| Remove Entity from Group | `<type>.update` in source Entity's Groups  | Treated as modifying the Entity's membership                             |
| Create Relationship      | `<type>.update` on source Entity           | Default; can be overridden per relationship type                         |
| Modify GroupMember       | `groupMember.update` (or `*`) in the Group | Changing someone's permissions requires permission in that Group         |
| Remove GroupMember       | `groupMember.delete` (or `*`) in the Group | Removing someone from a Group requires permission in that Group          |

#### Client-side validation

The client checks permissions before writing to the Outbox. Since the client has synced GroupMember records for its Actor, it can run the same permission logic locally.

This provides immediate feedback — the user knows right away if an Action isn't allowed, without a round-trip to the server.

If the client's permission data is stale (e.g., permissions were revoked while offline), the client may optimistically allow an Action that the server will reject. This is handled through the normal Outbox error flow — the Action is marked with an error, and the application decides how to surface it.

#### Server-side validation

The server is the authority. It validates every incoming Action against the current permission state before accepting it. Each Update within the Action is checked individually, but the Action succeeds or fails as a whole.

If validation fails, the entire Action is rejected. The server returns enough information for the client to understand _which_ Update failed and _why_, so the application can handle it appropriately.

### Materialization

Entity data is modeled as a field-level last-write-wins (LWW) register. `PUT` updates are full state writes. `PATCH` updates are JSON patches that modify individual fields.

This means concurrent `PATCH`es to _different_ fields both apply—they don't conflict. Concurrent `PATCH`es to the _same_ field use HLC to pick a winner (higher timestamp wins).

To materialize an `Entity`, we start at the last `PUT` update for that entity and play forward all subsequent `PATCH` (or `DELETE`) updates in HLC order until we arrive at the current state. Materialization operates at the Update level—Action boundaries don't matter here. Updates from different Actions are interleaved by HLC order during replay.

`Snapshots` are a convenience pointer to the last `PUT` update for a given `Entity`—simply an `(entity_id, update_id)` pair. They serve two purposes:

1. **Compaction**: We don't need to replay the entire update history, just everything after the snapshot.
2. **Visibility**: Entities that do not have a snapshot do not appear on the client, even if there are updates for them in the update log. This means an `Entity` only becomes "real" once it receives its first `PUT` update.

### The client

`@ebbjs/client` is the primary interface for building Ebb applications. It manages the local materialized cache, provides an ORM for querying data, and exposes convenience methods for writing and updating Entities.

#### Materialized cache

The client maintains a materialized view of all Entities the user has access to. This cache is kept up to date automatically—when Actions arrive via sync or are written locally (optimistically), their Updates are applied to the cache immediately. Queries always run against this cache, so reads are fast and fully offline-capable.

#### Querying

The ORM provides a query API for fetching Entities by type, filtering by field values, traversing Relationships, and more. Queries return materialized Entity data from the local cache. Details on the query API are covered in the `@ebbjs/client` documentation.

#### Writing data

The client provides convenience methods for creating, updating, and deleting Entities. These methods handle the details of constructing Actions (with their Updates), writing to the Outbox, and optimistically applying changes to the local cache. Multi-entity operations are naturally supported since Actions can contain any number of Updates.

#### Reactivity

The client exposes primitives for observing changes to the materialized cache. When an Entity changes—whether from a local write or an incoming synced Action—observers are notified.

These primitives are low-level by design. Framework-specific packages like `@ebbjs/react` build on top of them to provide idiomatic bindings—hooks that automatically re-render components when the data they depend on changes.

#### Server package

`@ebbjs/server` provides the server-side runtime—handling sync connections, permission enforcement, Action validation, and server-to-server replication. It builds on `@ebbjs/db` for storage and materialization.

### Conflict resolution

Inevitably when discussing offline-first architectures, CRDTs come up.

CRDT stands for Conflict-Free-Replicated-Datatypes. They are a way of using mathematics to embed the history of a data structure in the data structure itself and use that history to automatically merge and converge branching edits of that data structure.

They are quite rad and great for enabling real-time collaboration on a shared document, whiteboard, canvas, etc. with a large volume of concurrent editors.

So, you might think that (as many do) that they are a silver bullet for enabling collaborative, offline-capable applications. What could be better than a data structure that literally can always converge it's state - even from long ago offline edits?

Unfortunately, in practice CRDTs are quite horrible for building offline-first applications. Mainly because a CRDT is not actually conflict free. A better name for them would be Conflict-Avoidant-Replicated-Datatypes.

This is because conflicts are not actually simply a theoretical, mathematical problem. They are, in practice, a social problem.

When a CRDT like Yjs merges these two edits, what do you think should happen:
User A changes the title of a document from "The Color of Magic" to "The Colour of Magic".
User B deletes the heading.

If you answer the letter u stays in the document, you're right. This is the mathematically correct way to handle this conflicting concurrent edit to the same part of the document, but it is in no way the socially correct way to handle it.

CRDTs _avoid_ conflicts, they don't make them magically dissapear.

This is why surfacing and resolving conflicts are a feature every offline and collaborative application needs to be able to deal with in the way that's best for their users.

Ebb provides conflict management primitives similar to CouchDB's approach, using deterministic resolution to ensure all servers converge to the same state.

#### Server-side: automatic convergence via LWW

The server doesn't track conflicts—it simply applies all updates using field-level LWW. Every server applies the same deterministic algorithm:

1. **Higher HLC wins** - Updates with more recent causal timestamps take precedence
2. **Tiebreaker** - If HLC timestamps are equal, lexicographic comparison of update IDs determines the winner

This ensures all servers converge to identical state without coordination. From the server's perspective, there are no "conflicts"—just updates that get merged.

#### Client-side: preserving user intent

The interesting conflict handling happens on the client during the "rebase" phase of sync (i.e., pulling changes after being offline).

When a client comes back online and syncs, it may discover that Actions still in its Outbox (not yet sent to the server) contain Updates that would "lose" to Updates that have already been persisted. Specifically, the client detects a conflict when:

1. An incoming Action contains an Update that touches the same field(s) as a pending Outbox Update for the same entity
2. The incoming Update has a higher HLC than the Outbox Update

In this case, the server's state has moved on, and the client's pending edit would be silently overwritten by LWW if sent.

Rather than discard this user intent, Ebb moves these "losing" Actions from the Outbox to the client's `Conflicts` table. If only some Updates within an Action conflict, the entire Action is moved to Conflicts—maintaining atomicity even for conflict handling. Developers can then watch this table and choose—based on entity type, fields changed, user role, time elapsed, etc.—whether to surface the conflict to the user, automatically retry the edit, or discard it.

This approach provides automatic convergence at the server level while preserving user intent at the client level. Ebb doesn't "solve" conflicts—it gives you the primitives to handle them as the human problems they are.

### Garbage collection

The Action log grows indefinitely without intervention. Ebb provides garbage collection (GC) to reclaim storage.

#### Tombstones

When an Entity is deleted via a `DELETE` Update, Ebb doesn't remove it from storage. Instead, the Entity becomes a **tombstone**—a marker that the Entity was deleted. The tombstone retains the Entity's `id`, `type`, deletion timestamp (HLC), and the `actor_id` who deleted it. The `data` blob is cleared.

Tombstones exist for three reasons:

1. **Sync consistency** — Other nodes need to learn about the deletion. Without a tombstone, nodes that haven't synced would keep their local copy forever.
2. **Conflict detection** — If a client edits an Entity offline while another client deletes it, the tombstone allows the first client to detect this conflict when they sync.
3. **Relationship cleanup** — Application logic may need to find and handle dangling references. Tombstones make deleted Entities discoverable for cleanup.

Tombstoned Entities are not returned by queries and their Snapshot pointer is cleared.

#### What gets collected

GC runs in two phases:

**Phase 1: Action compaction.** Removes Actions whose Updates all precede their respective Entity's current Snapshot (the last `PUT`). These are no longer needed for materialization. This is safe to run at any time and does not affect tombstones or sync correctness.

**Phase 2: Tombstone purge.** Removes tombstoned Entities older than the configured retention period, along with all their associated Actions and Updates. This advances the low-water mark (minimum GSN still available in the Action log).

When a tombstone is purged, any Relationships still pointing to the deleted Entity become orphaned—they reference an Entity ID that no longer exists in any form. Ebb does not automatically clean these up. Applications should either clean up Relationships at deletion time, periodically scan for orphaned references, or handle them gracefully in the UI.

#### Retention

GC policy is configurable separately for clients and servers:

- **Servers** retain tombstones for a configurable period (default 30 days). Longer retention supports clients that sync infrequently. Shorter retention saves storage.
- **Clients** run aggressive GC by default. Tombstones can be removed immediately after confirming the server has them—the server is the source of truth for retention.

#### Stale cursor handling

When GC advances the low-water mark past a client's cursor, the server responds with a "full resync required" message. The client then performs the same full resync described in the client failover section—upsert all incoming data, push any local-only data back to the server, and run conflict detection on the Outbox.

### Schema evolution

In a distributed system with offline clients, schema changes are tricky. A client might be offline when you deploy a new schema, then come back online with pending Actions written against the old structure.

Ebb takes a primitives-based approach: it provides the tools to handle schema evolution, but doesn't enforce a rigid migration system.

**Schema versions**

Each entity type in the ORM declares a version number. When the ORM materializes an entity, it checks the version and runs migration functions to transform old data into the current shape.

These are "up" migrations only—transforming old data to new. There are no "down" migrations.

**Reading old data**

When you change your schema (e.g., rename `name` to `firstName` + `lastName`), old entities still have the old fields. The ORM's migration function handles this on read—for example, splitting `name` into `firstName` and `lastName` if the new fields don't exist.

The update log stays untouched—migrations only affect the materialized view.

**Writing backward-compatible updates**

If you need old clients (on v1) to see data written by new clients (on v2), write updates that populate both old and new fields. For example, a v2 client writing `firstName`, `lastName`, _and_ `name` so v1 clients can still read the combined name.

This is a discipline choice, not something Ebb enforces. If you don't need backward compatibility, just write the new fields.

**Breaking changes**

Sometimes backward compatibility isn't worth the effort. For breaking changes, you can configure a minimum supported schema version. Clients below this version receive an "update required" message during sync and cannot proceed until they upgrade.

**What Ebb provides:**

- Schema version on entity types in the ORM
- Migration functions (up only) to transform old data on read
- Optional minimum supported version for breaking changes

**What Ebb doesn't do:**

- Down migrations
- Automatic field aliasing or coercion
- Version-aware storage (the update log is schema-agnostic)

This keeps the storage and sync layer simple while giving developers the tools to handle schema evolution in whatever way fits their application.

### Observability & analytics

Ebb's Action-based architecture means every write is already a structured event. Every Action carries who (`actor_id`), what (`subject_type`, method, `data`), when (HLC, GSN), and where (Group context, derivable from the Entity's Relationships). This gives you operational observability and application analytics essentially for free—no separate event tracking layer required.

#### The `onAction` handler

The server exposes an `onAction` hook that fires after an Action is accepted and stored. The handler receives the full Action—its Updates, actor, HLC, GSN, and the Groups the affected Entities belong to.

Common use cases:

- Pipe Actions to a data warehouse (BigQuery, Snowflake, etc.) for analytical queries
- Feed a real-time dashboard or activity stream
- Trigger webhooks or downstream integrations
- Build a complete audit log—every mutation, by whom, when, and to what

The handler is async and non-blocking. It does not affect Action acceptance or sync. If the handler throws or fails, the Action is still persisted and replicated normally—analytics should never block writes.

For Actions received via server-to-server replication, the handler fires on the receiving server too. This means each server can independently feed its own analytics pipeline. Developers should design their downstream systems to handle deduplication—Action IDs are globally unique, making this straightforward.

#### Server-side operational metrics

Ebb exposes built-in metrics for monitoring the health of the system:

- **Replication lag** — Per-peer cursor delta. How far behind is this server relative to each of its sync peers? Sustained lag indicates network issues or a slow peer.
- **Action throughput** — Actions accepted per second, broken down by source (client vs. peer). Useful for capacity planning and detecting traffic spikes.
- **Sync connection count** — Active client and peer connections. Helps with load balancing and detecting connection leaks.
- **Catch-up / resync frequency** — How often clients are performing full resyncs vs. incremental catch-up. A spike in full resyncs may indicate aggressive GC settings or frequent client failovers.
- **Storage health** — Circuit breaker state per peer, GC progress (last compaction, tombstone count, low-water mark), and database size.

These metrics are designed to be compatible with standard observability tooling. The long-term goal is OpenTelemetry-compatible export, but for now Ebb exposes them as an observable API that operators can plug into whatever monitoring stack they use.

#### Client-side operational metrics

The client exposes first-class observable values that framework bindings (like `@ebbjs/react`) can use to build sync indicators, error surfaces, and debugging tools:

- **Outbox depth** — Count of pending, acknowledged, and errored Actions. A growing pending count means the client can't reach the server; errored Actions need application attention.
- **Flush latency** — Time between writing to the Outbox and receiving acknowledgment from the server. A useful signal for perceived responsiveness.
- **Conflict count** — Number of Actions in the Conflicts table awaiting resolution. Lets apps prompt users to review conflicts.
- **Sync state** — Current phase: handshake, catch-up, subscribed, or disconnected. The building block for "syncing..." and "offline" UI states.
- **Last synced timestamp** — When the client last received an Action from the server. Useful for "last updated X seconds ago" displays.

These are read-only observables, not internal implementation details. Applications are encouraged to use them for UX—they exist specifically so you don't have to reach into Ebb internals.

#### Application analytics

Because every Action is a structured event, developers can derive product analytics directly from the Action stream without instrumenting their application code:

- Entity creation and deletion rates by type
- Active actors per Group over time
- Field-level change frequency (which fields get edited most?)
- Action size distribution (how many Updates per Action?)
- Time-to-first-action for new Actors (onboarding funnel)

The `onAction` handler is the recommended integration point for this. Pipe Actions to your analytics stack and query there, rather than querying the Action log directly—it's optimized for sync and materialization, not analytical workloads.
