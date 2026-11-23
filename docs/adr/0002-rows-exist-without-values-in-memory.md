# 0002 — A row can exist without its values in memory

**Status:** accepted

The client kept a full copy of every synced row in memory, and the query engine read that same copy to decide which rows exist, which rows match a filter, and how they sort. Freeing a value and removing a row were therefore the same operation. This decision separates the two: the row index owns existence and query keys, and values that no reader holds live in durable storage and are loaded when a page needs them.

## Context

Measured on the old code: 500 rows of 64 KiB stayed in memory after every claim was released and five grace periods passed (42.4 MiB of heap). At 2,000 rows the figure was 168.9 MiB. The same rows loaded by a read went back to zero.

The old model had no state for "the row exists, but its values are not in memory". That is why reclaiming a large value looked like deleting a row, and why a query could lose rows with no error.

## Decision

1. The in-memory row index owns existence. It holds each row's id, model, existence, component names, versions, edges, and the values filters and sorts use.
2. The values of other components live in durable storage when no reader holds them. A read loads the values for the page it projects.
3. Query planning and narrowing stay synchronous and read the row index. A query re-run does not wait for storage.
4. A read that selects N components returns all N or fails loudly.
5. Map-shaped components may leave memory when nothing holds them. Large single values may leave only when declared. The system components that feed edges never leave.

## Consequences

- "Which rows exist" and "which values are in memory" become separate questions. A change to one does not change the other.
- The query engine never needs a complete row to decide whether a row matches or where it sorts. It needs the row's keys, which stay in memory.
- A cold projection reads from storage for the page only. A filter or sort over a large model must not fall back to a storage scan.
- The saved snapshot carries row index entries, versions and the log position, not values.
- The storage layer must read and write one component at a time.

## Alternatives

- Delete rows whole when nothing holds them. Rejected: a query can no longer see the row, and a filter silently returns fewer rows.
- Cap memory by size and remove the least recently used row. Rejected: it makes query cost depend on memory pressure and brings back a tuning knob.
- Make storage the query source and run every query asynchronously. Rejected for now: it changes the read contract and makes every change wait for a storage read. Revisit only if a real app cannot keep its filter and sort keys in memory, or a page load is visibly slow on a target device.

References: #965, #968. Numbering continues after ADR 0001, the component model, which was retired into CONTEXT.md (#778).
