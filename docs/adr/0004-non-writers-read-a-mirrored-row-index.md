# 0004 — A non-writer reads through a mirrored row index

**Status:** accepted

ADR 0003 gave each local store one writer and left open how every other instance
reads. This decision answers it: a reader keeps its own row index, fed by the
writer's change batches, and reads the values that index does not hold from the
shared durable store. Reads stay synchronous and never wait on another tab.

## Context

A reader needs the row index, the values, and the change journal. Two shapes
were on the table (#970):

1. **Call the writer for reads.** The reader keeps projected results and asks
   the writer to run each query. One index per origin, and the smallest per-tab
   memory: a released 10,000-row result is 0.7 MB of JSON (#966).
2. **Mirror the index and follow the change journal.** The reader keeps its own
   row index and applies the writer's batches to it. Reads and filters run
   locally and synchronously, as ADR 0002 requires.

Option 1 was rejected because it makes _reads_ depend on another tab being
scheduled. Browsers throttle and can freeze hidden tabs, and the writer is the
tab the browser is most entitled to freeze; a foreground tab would then be
unable to answer a filter it could have answered itself. It also concentrates
every tab's query execution on one thread that is already applying the stream.
The memory option 1 saves is one row index per tab — 3.8 MB of JSON, 13.6 MB of
V8 heap at 20,001 rows (#966) — and that index is what a synchronous filter
costs (ADR 0002). Paying it per tab is the price of independence.

## Decision

1. The writer owns the stream, the fold, the row index, the change journal, the
   outbox flush, and the durable writes. Nothing else writes the store.
2. Every other instance reads through **replica access**: a mirrored row index
   and the writer's change batches. It runs no stream and applies no Actions.
3. One unit crosses the boundary: the **index entry**, which is the element of
   #977's row-list snapshot. A batch carries the writer's own row changes plus
   the entries of the rows whose index moved, so a reader never classifies a
   change and never derives an index. The writer's revision numbers are kept, so
   a subscription revision means the same thing on both sides.
4. A reader's index is the writer's index: same entry shape, same derived
   indices, one derivation function. Residency is per instance — each keeps its
   own copies of the values its own readers claim — and no claim crosses the
   boundary.
5. Values the index does not hold — map-shaped components, and large single
   values a schema has declared removable (#975) — are read from the durable
   store by whichever instance needs them (#980). The writer publishes a
   revision only after the values it names are durable, so a reader at that
   revision can serve them, and a writer can die at any point.
6. A reader that falls behind the writer's retained journal takes a fresh
   **baseline** instead of a diff. That is the existing `load` gap: the index is
   replaced and every subscription re-runs.
7. Unconfirmed writes are instance-local. Each instance accepts its own writes
   into its own outbox partition durably, applies its own optimistic view, and
   drops it when the writer reports the Action committed or rejected. A reader
   sees a peer's pending write only once it is confirmed.
8. Writer handover promotes a reader in place: it adopts its own mirror as its
   base and resumes the stream from the last published log position, so
   promotion replays nothing.
9. A host with one instance is always the writer, and its replica access is the
   writer itself: no copy, no messages. Mobile and one-tab web pay nothing for
   this interface.

## Consequences

- Reads keep working while the writer is throttled, frozen, or gone. Only writes
  and values outside the index wait for it.
- Every instance runs the query engine, so no single tab carries the others'
  re-runs, and a stale result is stale at one instance's cursor rather than at
  a remote one's.
- A reader's `revision` is only as current as its last batch, so client status
  must report feed health, not just socket health.
- The `Replica` interface splits into the read half the engine, registry, and
  result cache already use, and the owner half only a writer calls. A mirror
  replica implements the read half plus one `mirror` step.
- `ReplicaAccess` already names the namespace binding in `packages/client/src/sync/namespace.ts`;
  that name moves to this interface and the binding is renamed (#990).
- The row-index cost moves from the writer to every tab, so #989 (intern ids and
  component names) and #975 (which components may leave) now buy per-tab memory,
  not just the writer's.

## Alternatives

- **Call the writer for reads.** Rejected: reads on another tab's scheduler, one
  thread for every tab's queries, and a round trip per re-run.
- **Every instance folds the shared log.** Rejected in ADR 0003: it multiplies
  the work and the stream.
- **Share only the durable store.** Rejected in ADR 0003, and ADR 0002 rejected
  a storage-backed query path on cost.
- **Put the replica in a service worker.** Rejected in ADR 0003: unavailable on
  React Native, and it brings its own lifecycle.
- **Scope the mirror per model from the start.** Deferred, not rejected: it is
  the natural next step if a tab's index is measured to be the cost, and it
  needs only a model filter on the feed.

References: #965, #970. Numbering continues after ADR 0001, the component model,
which was retired into CONTEXT.md (#778).
