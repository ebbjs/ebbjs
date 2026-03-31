# HLC (Hybrid Logical Clock)

## Purpose

Provides the identity and ordering primitive for the entire collaborative editor. Every run inserted into the document gets a unique ID derived from an HLC timestamp. When two peers insert at the same position, the HLC comparison determines deterministic ordering — this is the tie-break mechanism that makes the system converge without a server.

This component is **unchanged** in the optimization pass. Runs use HLC IDs the same way characters did — the only difference is that one `increment()` call now covers an entire run instead of a single character.

## Responsibilities

- Create new HLC values with a given peer ID
- Increment a local HLC (on local events)
- Merge a local HLC with a received remote HLC (on receiving remote operations)
- Compare two HLCs for total ordering
- Serialize an HLC to a unique, sortable string suitable for use as a `RunNode.id`

## Public interface

### Types

```ts
type Hlc = {
  readonly ts: number       // Wall-clock timestamp (ms since epoch)
  readonly count: number    // Logical counter for same-ts disambiguation
  readonly peerId: string   // Unique identifier for the peer that created this HLC
}
```

### Exported functions

| Name | Signature | Description |
|------|-----------|-------------|
| `createHlc` | `(peerId: string) => Hlc` | Create a fresh HLC initialized to the current wall-clock time with count 0 |
| `increment` | `(local: Hlc) => Hlc` | Advance the local HLC: take `max(Date.now(), local.ts)`, bump count if ts unchanged, return new HLC |
| `receive` | `(local: Hlc, remote: Hlc) => Hlc` | Merge local and remote: `ts = max(now, local.ts, remote.ts)`, count follows HLC merge rules, keep local peer ID |
| `compare` | `(a: Hlc, b: Hlc) => number` | Total order comparison: first by `ts`, then by `count`, then by `peerId` lexicographically. Returns negative if a < b, positive if a > b, 0 if equal. |
| `toString` | `(hlc: Hlc) => string` | Serialize to `{ts padded to 15}:{count padded to 5}:{peerId}`. Lexicographic order matches `compare()`. |

## Dependencies

None. This is a leaf module with zero imports from other project modules.

## Internal design notes

No changes from the current implementation in `src/hlc.ts`. The optimization pass changes the *granularity* of what gets an HLC ID (runs instead of characters) but not the HLC logic itself.

One run = one `increment()` call = one HLC ID. Previously, typing "hello" required 5 `increment()` calls; now it requires 1. This means the HLC counter advances more slowly, which is fine — the counter exists for disambiguation, not for counting characters.

The `toString` format must remain **lexicographically sortable** so that string comparison of IDs gives the same result as `compare()`. Zero-padding: 15 digits for `ts` (covers through year 2286), 5 digits for `count` (allows 99,999 events per millisecond).

**Tie-break rule (unchanged):** When two peers insert a run with the same parent, the run with the **higher** HLC (per `compare`) is placed **first** (leftmost) among siblings. This is deterministic across all peers.

## Open questions

None. This component is stable and unchanged.

## File

`src/hlc.ts` — pure functions, no imports from other project files.
Test file: `src/__tests__/hlc.test.ts` (existing tests remain valid)
