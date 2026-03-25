---
title: "Sync Protocol"
description: "Replication, catch-up, subscription, and the Outbox."
---

In Ebb, [Groups](/docs/groups) are our sync boundary. Each node can be seen as containing a partial replica of all the data in the our application based on a set of `Groups` that node is subscribed to.

We can think of our goal of our sync engine in Ebb as: "How do I ensure two nodes have the same [Actions](/docs/data-model) for a given `Group`".

This leaves us with a well-defined, but not trivial problem to solve. To solve it, we'll need three main pieces that any replication system needs to have:

1. The replication log.
2. The pub/sub system.
3. The consensus protocol.

The replication log is the ordered list of `Actions`. However, partitioning Actions efficiently by `Group` requires looking up which Entities belong to a Group and then finding Actions that contain Updates targeting those Entities.

This can get quite expensive to do for N `Groups` for M nodes. Especially since often times M nodes will be subscribed to an overlapping set of `Groups`.

So, our pub/sub service actually creates subscriptions on demand to individual `Groups` in the system as a kind of "topic". Then, when a node wants to start subscribe to that topic, they are just added to that topics subscription list.

This allows us to "fan-in" the N `Group` feeds to M nodes. This can mean that, if two `Groups` have a high amount of overlapping `Entities`, the node will receive duplicate Actions. However, in practice since applying an Action is idempotent, the tradeoff is simply bandwidth.

This can be mitigated by periodically auditing your system for `Entity` overlap across `Groups` if it becomes a significant cost.

## Sync phases

You can think about replication/sync happening in three phases:

1. **Handshake** — The client authenticates and receives metadata about the sync session. This includes which Groups the client can subscribe to (based on its Actor's GroupMember records), whether the client's cursor is stale and requires a full resync, and whether the client's version is too old to proceed (triggering an "update required" message).

2. **Catch-up** — The client requests all Actions it missed since its last sync, paginated by [GSN](/docs/clock#dual-timestamp-system).

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

## Server-client

After coming online, the client requests the server for all of the `Groups` it is allowed to subscribe to based on its `actor_id`.

For each `Group`, the client requests a paginated list of `Actions` starting from a `cursor` that equals the last GSN it saw from that server.

`GET /sync?groupId=<group_id>&cursor=<gsn>`

This endpoint returns Actions ordered by GSN (ensuring no gaps in the client's view), where each Action contains its full set of Updates and its original [HLC](/docs/clock) timestamp for proper state materialization. The response includes a `control` message at the end telling the client to request again or that they are up to date. Pagination always splits between Actions, never within—an Action is never split across pages.

The client continues to request and digest these messages, increasing the `cursor` based on the last GSN received until they get a `control` message notifying them they are up to date.

**GSN-based catch-up**: When a server receives an Action (either from a client or another server), it assigns the next available GSN to that Action before storing it. This means:

1. Actions are stored with both their original HLC (for causal ordering) and a server-assigned GSN (for reliable sync)
2. Clients can safely request "all Actions with GSN > X" knowing they won't miss any due to network timing
3. The server streams Actions in GSN order for client sync, but applies their Updates in HLC order for state materialization (using each field's [type](/docs/data-model#typed-fields) to dispatch the appropriate merge function)
4. Client failover requires connecting to a new server and performing a full resync, since GSNs are server-specific (see below)

## Client failover

When a client loses its server and connects to a different one, its GSN cursors are meaningless—GSNs are local to the server that assigned them. The client must perform a full resync.

The resync is straightforward because all local writes are idempotent upserts. The client requests complete current state for each subscribed Group. As Actions, Updates, and Snapshots arrive, the client upserts them into its local store. Existing data is overwritten with the server's version; new data is inserted. The local materialized cache is rebuilt from the result.

After the full resync completes, the client inspects its local data for anything the new server didn't send back. This is data that the old server had accepted and synced to the client, but that hadn't propagated to the new server before failover. The client pushes this data to the new server through the normal Outbox flow—the new server validates and either accepts or rejects it like any other incoming Action.

The Outbox is handled the same way: pending Actions are flushed to the new server after catch-up, and conflict detection runs against the new server's state. Actions that "lose" are moved to the Conflicts table as usual.

This approach is simple and correct at the cost of bandwidth. Optimizations like HLC-based catch-up or snapshot diffing can be added later without changing the protocol semantics.

## Server-server

Server-to-server sync follows the same fundamental model as client-server: catch-up followed by continuous subscription, with Actions as the sync unit. The difference is that it's bidirectional—both servers act as both publisher and subscriber to each other.

### Peer configuration

Servers are configured with explicit sync peers, similar to CouchDB's replication model. Each server maintains a list of peers it should sync with, and Ebb handles the rest. This means topology is your choice:

- **Full mesh**: Every server connects to every other server. Simple, lowest latency, but connections scale as N². Works well for small clusters (3-5 servers).
- **Hub-and-spoke**: Regional servers connect to a central hub. Reduces connections, but the hub becomes a bottleneck and single point of failure.
- **Regional clusters**: Servers within a region form a full mesh, with one or more servers bridging to other regions. Good balance for geographic distribution.
- **Chain/ring**: Each server connects to one or two neighbors. Minimal connections, but high propagation latency. Rarely the right choice.

There's no "correct" topology—it depends on your latency requirements, operational complexity tolerance, and failure modes you want to optimize for.

### Sync mechanism

Each server maintains a sync cursor per peer: `(peer_server_id, last_gsn_received)`. When Server A syncs with Server B:

1. **Catch-up**: Server A requests all Actions from Server B with GSN > cursor. Server B responds with Actions ordered by its GSN. Server A stores these Actions, assigning its own GSN to each.
2. **Subscription**: Once caught up, Server A subscribes to a continuous push of new Actions from Server B. Actions are pushed as they arrive, maintaining low latency.

This happens bidirectionally—while A catches up from B, B is also catching up from A.

### GSN handling

As an Action propagates between servers, each server assigns its own GSN when storing it. The original HLC is preserved (for ordering and materialization), but the GSN is overwritten. This means:

- An Action has exactly one HLC (assigned at creation, never changes)
- An Action has exactly one GSN at any given server (assigned by that server)
- Servers track sync progress with peers using the peer's GSN, not the HLC

### Consistency model

Because Actions propagate through the configured topology, an Action may take multiple hops to reach all servers. This means:

- Two servers may have temporarily divergent views of an entity
- All servers will _eventually_ converge to the same state (given connectivity)
- Convergence time depends on your topology—full mesh is fastest, sparse topologies add latency

For most applications, this eventual consistency is measured in milliseconds to low seconds. If you need stronger consistency guarantees for specific operations, that's outside Ebb's model—you'd need to build coordination on top.

### Trust-and-apply

Server-to-server replication does not re-validate Actions. When Server A receives an Action from Server B, it stores it unconditionally—no permission checks, no schema validation. The accepting server (the first server to receive the Action from a client) is the validation gate. After that, the Action is canonical and flows through the system without further gatekeeping.

This is essential for the convergence guarantee. If servers could reject each other's accepted Actions, they would never converge to the same state. Peers are configured explicitly—you only peer with servers you control—so the trust boundary is the peer list itself.

This mirrors CouchDB's replication model, where replicated documents are accepted unconditionally by the receiving node.

### Storage failures during replication

Even though servers don't logically reject peer Actions, a write can still fail at the storage layer—disk full, SQLite busy timeout, I/O error, etc. These are transient infrastructure failures, not validation rejections, and are handled differently:

- **During catch-up**: If a write fails, the receiving server does not advance its sync cursor. The next catch-up request re-sends the same Action. Retries use exponential backoff to avoid hammering a sick server.
- **During subscription**: If a write fails, the receiving server NACKs the Action. The sending server keeps it in the outbound buffer and retries with backoff.
- **Never skip**: Strict GSN ordering means a failed Action cannot be skipped. Subsequent Actions may depend on it (e.g., a PATCH targeting an Entity whose PUT was in the failed Action). The replication pipeline stalls until the failure is resolved. This is a correctness-over-availability trade-off.
- **Circuit breaker**: After repeated consecutive storage failures, the receiving server pauses replication from that peer and surfaces an error for operators. This prevents an infinite retry loop against a persistently broken disk or corrupted database.

Once the underlying storage issue is resolved, replication resumes from the stalled cursor and catches up normally.

## Client-to-server writes

When a client writes data, the Action doesn't go directly to the server. Instead, it flows through the **Outbox** — a local store that buffers pending Actions and tracks their status through the sync lifecycle.

**The write flow:**

1. **Local validation** — The client checks [permissions](/docs/permissions) and schema locally before accepting the write. This fails fast for obvious violations (e.g., user doesn't have `post.create` permission).

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
