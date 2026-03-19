---
title: "Observability & Analytics"
description: "Metrics, the onAction handler, and application analytics."
---

Ebb's [Action](/docs/data-model)-based architecture means every write is already a structured event. Every Action carries who (`actor_id`), what (`subject_type`, method, `data`), when ([HLC](/docs/clock), GSN), and where ([Group](/docs/groups) context, derivable from the Entity's Relationships). This gives you operational observability and application analytics essentially for free—no separate event tracking layer required.

## The `onAction` handler

The server exposes an `onAction` hook that fires after an Action is accepted and stored. The handler receives the full Action—its Updates, actor, HLC, GSN, and the Groups the affected Entities belong to.

Common use cases:

- Pipe Actions to a data warehouse (BigQuery, Snowflake, etc.) for analytical queries
- Feed a real-time dashboard or activity stream
- Trigger webhooks or downstream integrations
- Build a complete audit log—every mutation, by whom, when, and to what

The handler is async and non-blocking. It does not affect Action acceptance or sync. If the handler throws or fails, the Action is still persisted and replicated normally—analytics should never block writes.

For Actions received via [server-to-server replication](/docs/sync#server-server), the handler fires on the receiving server too. This means each server can independently feed its own analytics pipeline. Developers should design their downstream systems to handle deduplication—Action IDs are globally unique, making this straightforward.

## Server-side operational metrics

Ebb exposes built-in metrics for monitoring the health of the system:

- **Replication lag** — Per-peer cursor delta. How far behind is this server relative to each of its sync peers? Sustained lag indicates network issues or a slow peer.
- **Action throughput** — Actions accepted per second, broken down by source (client vs. peer). Useful for capacity planning and detecting traffic spikes.
- **Sync connection count** — Active client and peer connections. Helps with load balancing and detecting connection leaks.
- **Catch-up / resync frequency** — How often clients are performing full resyncs vs. incremental catch-up. A spike in full resyncs may indicate aggressive [GC](/docs/garbage-collection) settings or frequent client failovers.
- **Storage health** — Circuit breaker state per peer, GC progress (last compaction, tombstone count, low-water mark), and database size.

These metrics are designed to be compatible with standard observability tooling. The long-term goal is OpenTelemetry-compatible export, but for now Ebb exposes them as an observable API that operators can plug into whatever monitoring stack they use.

## Client-side operational metrics

The [client](/docs/client) exposes first-class observable values that framework bindings (like `@ebbjs/react`) can use to build sync indicators, error surfaces, and debugging tools:

- **Outbox depth** — Count of pending, acknowledged, and errored Actions. A growing pending count means the client can't reach the server; errored Actions need application attention.
- **Flush latency** — Time between writing to the Outbox and receiving acknowledgment from the server. A useful signal for perceived responsiveness.
- **Conflict count** — Number of Actions in the [Conflicts](/docs/conflicts) table awaiting resolution. Lets apps prompt users to review conflicts.
- **Sync state** — Current phase: handshake, catch-up, subscribed, or disconnected. The building block for "syncing..." and "offline" UI states.
- **Last synced timestamp** — When the client last received an Action from the server. Useful for "last updated X seconds ago" displays.

These are read-only observables, not internal implementation details. Applications are encouraged to use them for UX—they exist specifically so you don't have to reach into Ebb internals.

## Application analytics

Because every Action is a structured event, developers can derive product analytics directly from the Action stream without instrumenting their application code:

- Entity creation and deletion rates by type
- Active actors per Group over time
- Field-level change frequency (which fields get edited most?)
- Action size distribution (how many Updates per Action?)
- Time-to-first-action for new Actors (onboarding funnel)

The `onAction` handler is the recommended integration point for this. Pipe Actions to your analytics stack and query there, rather than querying the Action log directly—it's optimized for sync and materialization, not analytical workloads.
