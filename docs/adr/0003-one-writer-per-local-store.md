# 0003 — One writer per local store

**Status:** accepted

Every tab or app instance opened its own live stream, applied its own Actions and kept its own replica. Multiple tabs multiplied memory, network use and work, and a shared local store could be written by more than one instance at once. This decision gives each local store one writer: it owns the stream and applies Actions, and every other instance reads through it.

## Context

A browser with five tabs ran five streams, applied every Action five times and kept five copies of the row index and its values. The shared IndexedDB store could also be written by more than one tab. A mobile app usually has one instance, but can have more than one window; a test or Node process has one.

## Decision

1. One writer per local store. The writer owns the live stream, applies incoming Actions and publishes the change journal (the row changes since a revision).
2. Every other tab or app instance reads through the writer.
3. A host with one instance is always the writer. No election is needed.
4. Where a store is shared, the instances elect one writer. When the writer goes away, another instance takes over.
5. Only the writer writes the stored rows and indexes. The outbox remains the source of unconfirmed local writes.

## Consequences

- One live stream and one application of Actions per origin, not one per tab.
- A reader that is not the writer needs the row index, values and change journal through a small access interface. It does not run its own stream.
- Writer loss and handover need tests: a new writer, a restored page, and a reader whose change journal is behind.
- How a reader's unconfirmed writes reach the writer is part of the access design. It does not change the rule.
- Single-instance hosts implement the rule as a constant.

## Alternatives

- Every instance keeps its own replica. Rejected: it is the current cost.
- Share only the durable store and let every instance apply Actions. Rejected: it still multiplies the stream, the work and the in-memory index.
- Put the replica in a service worker. Rejected: it is not available on React Native and brings its own lifecycle.

References: #965, #969. Numbering continues after ADR 0001, the component model, which was retired into CONTEXT.md (#778).
