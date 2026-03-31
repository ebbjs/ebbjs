# HLC (Hybrid Logical Clock)

## Purpose

Provides the identity and ordering primitive for the entire collaborative editor. Every character inserted into the document gets a unique ID derived from an HLC timestamp. When two peers insert at the same position, the HLC comparison determines deterministic ordering — this is the tie-break mechanism that makes the system converge without a server.

## Responsibilities

- Create new HLC values with a given peer ID
- Increment a local HLC (on local events)
- Merge a local HLC with a received remote HLC (on receiving remote operations)
- Compare two HLCs for total ordering
- Serialize an HLC to a unique, sortable string suitable for use as a `CharNode.id`

## Public interface

### Exported functions

| Name | Signature | Description |
|------|-----------|-------------|
| `createHlc` | `(peerId: string) => Hlc` | Create a fresh HLC initialized to the current wall-clock time with count 0 |
| `increment` | `(local: Hlc) => Hlc` | Advance the local HLC: take `max(Date.now(), local.ts)`, bump count if ts unchanged, return new HLC |
| `receive` | `(local: Hlc, remote: Hlc) => Hlc` | Merge local and remote: `ts = max(now, local.ts, remote.ts)`, count follows HLC merge rules, keep local peer ID |
| `compare` | `(a: Hlc, b: Hlc) => number` | Total order comparison: first by `ts`, then by `count`, then by `peerId` lexicographically. Returns negative if a < b, positive if a > b, 0 if equal. |
| `toString` | `(hlc: Hlc) => string` | Serialize to a deterministic, lexicographically-sortable string. Format: `{ts}:{count}:{peerId}` with zero-padded numeric fields. |

### Types

```ts
type Hlc = {
  readonly ts: number       // Wall-clock timestamp (ms since epoch)
  readonly count: number    // Logical counter for same-ts disambiguation
  readonly peerId: string   // Unique identifier for the peer that created this HLC
}
```

## Dependencies

None. This is a leaf module with zero imports from other project modules.

## Internal design notes

The HLC algorithm follows Kulkarni et al.'s hybrid logical clock paper. The key invariant: `hlc.ts >= Date.now()` at the time of creation, and the count disambiguates events that share the same wall-clock millisecond.

The `toString` format must be **lexicographically sortable** so that string comparison of IDs gives the same result as `compare()`. This means zero-padding the numeric fields to a fixed width. Suggested format: `{ts padded to 15 digits}:{count padded to 5 digits}:{peerId}`.

All functions are pure — they take an HLC and return a new one. No mutation.

**Tie-break rule (critical for convergence):** When two peers insert a character with the same parent, the character with the **higher** HLC (per `compare`) is placed **first** (leftmost) among siblings. This is an arbitrary but deterministic choice — it just needs to be consistent across all peers. The PLAN.md says "higher HLC wins," meaning higher-HLC characters appear first in sibling order.

## Open questions

- **Zero-padding width:** 15 digits for `ts` covers timestamps through the year 2286. 5 digits for `count` allows 99,999 events per millisecond. These seem safe for a prototype but should be documented as limits.
- **`peerId` format:** The PLAN.md uses simple strings like `"peer-A"`. For the prototype this is fine. If peer IDs could contain `:` characters, the `toString` format would need escaping. For now, assume peer IDs are alphanumeric + hyphens.

## File

`src/hlc.ts` — pure functions, no imports from other project files.
Test file: `src/__tests__/hlc.test.ts`
