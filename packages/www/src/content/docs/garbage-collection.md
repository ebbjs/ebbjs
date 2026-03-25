---
title: "Garbage Collection"
description: "Tombstones, compaction, and retention."
---

The [Action](/docs/data-model) log grows indefinitely without intervention. Ebb provides garbage collection (GC) to reclaim storage.

## Tombstones

When an Entity is deleted via a `DELETE` Update, Ebb doesn't remove it from storage. Instead, the Entity becomes a **tombstone**—a marker that the Entity was deleted. The tombstone retains the Entity's `id`, `type`, deletion timestamp ([HLC](/docs/clock)), and the `actor_id` who deleted it. The `data` field (containing all [typed field](/docs/data-model#typed-fields) values) is cleared.

Tombstones exist for three reasons:

1. **Sync consistency** — Other nodes need to learn about the deletion. Without a tombstone, nodes that haven't synced would keep their local copy forever.
2. **Conflict detection** — If a client edits an Entity offline while another client deletes it, the tombstone allows the first client to detect this [conflict](/docs/conflicts) when they sync.
3. **Relationship cleanup** — Application logic may need to find and handle dangling references. Tombstones make deleted Entities discoverable for cleanup.

Tombstoned Entities are not returned by queries and their Snapshot pointer is cleared.

## What gets collected

GC runs in two phases:

**Phase 1: Action compaction.** Removes Actions whose Updates all precede their respective Entity's current Snapshot (the last `PUT`). These are no longer needed for materialization. This is safe to run at any time and does not affect tombstones or sync correctness.

**Phase 2: Tombstone purge.** Removes tombstoned Entities older than the configured retention period, along with all their associated Actions and Updates. This advances the low-water mark (minimum GSN still available in the Action log).

When a tombstone is purged, any [Relationships](/docs/relationships) still pointing to the deleted Entity become orphaned—they reference an Entity ID that no longer exists in any form. Ebb does not automatically clean these up. Applications should either clean up Relationships at deletion time, periodically scan for orphaned references, or handle them gracefully in the UI.

## Retention

GC policy is configurable separately for clients and servers:

- **Servers** retain tombstones for a configurable period (default 30 days). Longer retention supports clients that sync infrequently. Shorter retention saves storage.
- **Clients** run aggressive GC by default. Tombstones can be removed immediately after confirming the server has them—the server is the source of truth for retention.

## Stale cursor handling

When GC advances the low-water mark past a client's cursor, the server responds with a "full resync required" message. The client then performs the same full resync described in the [client failover](/docs/sync#client-failover) section—upsert all incoming data, push any local-only data back to the server, and run conflict detection on the Outbox.
