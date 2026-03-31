# Slice 3: Concurrent Conflict (Tie-Break)

## Goal

Two users type at the exact same position simultaneously, and both editors converge to the same final document — proving the HLC tie-break rule produces deterministic results without a server.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [HLC](../components/hlc.md) | `compare` (the tie-break comparison), `receive` (clock merge) |
| [Causal Tree](../components/causal-tree.md) | `docReducer` (INSERT with sibling ordering), `findInsertPosition`, `reconstruct` |
| [CM Bridge](../components/cm-bridge.md) | `applyRemoteInsert` (inserting at the tie-break-determined position) |
| [Relay](../components/relay.md) | Full message handling (same as Slice 2) |
| [Editor App](../components/editor-app.md) | Full two-peer setup |

## Flow

### The conflict scenario

1. Both editors start with the same document: `"ab"` (two characters: node `a` parented to ROOT, node `b` parented to `a`)
2. Peer A types `"X"` between `a` and `b` (position 1, parent = node `a`)
3. Peer B types `"Y"` between `a` and `b` (position 1, parent = node `a`) — **at the same time**, before receiving Peer A's message
4. Now both `X` and `Y` have the same parent (`a`). They are siblings.

### Resolution via HLC tie-break

5. The Causal Tree's `findInsertPosition` determines sibling order by comparing HLCs: **higher HLC comes first** (leftmost among siblings)
6. Suppose Peer A's HLC for `X` is `1000:0:peer-A` and Peer B's HLC for `Y` is `1000:0:peer-B`
7. `compare("1000:0:peer-B", "1000:0:peer-A")` → `"peer-B" > "peer-A"` lexicographically → `Y` has the higher HLC → `Y` comes first
8. Both peers must arrive at the order: `a Y X b`

### How each peer converges

**Peer A's perspective:**
- Peer A already inserted `X` after `a`, so their document is `"aXb"`
- Peer A receives Peer B's INSERT for `Y` (parent = `a`)
- `findInsertPosition` sees that `a` now has two children: `X` and `Y`. It compares their HLCs. `Y` has the higher HLC → `Y` goes first.
- The position for `Y` is 1 (after `a`, before `X`)
- `applyRemoteInsert(view, 1, "Y", yNodeId)` → document becomes `"aYXb"`

**Peer B's perspective:**
- Peer B already inserted `Y` after `a`, so their document is `"aYb"`
- Peer B receives Peer A's INSERT for `X` (parent = `a`)
- `findInsertPosition` sees that `a` now has two children: `Y` and `X`. `Y` has the higher HLC → `Y` goes first, `X` goes second.
- The position for `X` is 2 (after `Y`, before `b`)
- `applyRemoteInsert(view, 2, "X", xNodeId)` → document becomes `"aYXb"`

**Both editors now show `"aYXb"`.** Convergence achieved.

### The key invariant

For any set of sibling nodes (nodes sharing the same parent), the Causal Tree always orders them by **descending HLC** (higher HLC first). Since HLC comparison is a total order (ts → count → peerId), and every node has a globally unique HLC, the ordering is deterministic regardless of the order operations arrive.

## Acceptance criteria

- [ ] **Convergence test (unit):** Create two independent `DocState` instances. Apply the same set of INSERT operations in different orders. Call `reconstruct` on both. The results are identical.
- [ ] **Sibling ordering test (unit):** Insert three nodes with the same parent but different HLCs. Verify `reconstruct` produces them in descending HLC order.
- [ ] **Tie-break on peerId (unit):** Insert two nodes with the same parent, same `ts`, same `count`, but different `peerId`s. Verify the one with the lexicographically higher peerId comes first.
- [ ] **Visual convergence (manual):** Type simultaneously in both editors at the same position. After both operations have synced, both editors show identical text.
- [ ] **Idempotency:** Receiving the same INSERT message twice does not duplicate the character (the node ID already exists in the map, so the second insert is a no-op).
- [ ] **Commutativity:** The final document state is the same regardless of the order operations are applied. Test by applying ops in forward order and reverse order.

## Build order

1. **Write convergence unit tests in `src/__tests__/causal-tree.test.ts`** — this is the most important validation for this slice. Create scenarios where:
   - Two inserts share the same parent, applied in both orders → same `reconstruct` output
   - Three+ inserts share the same parent → correct descending HLC order
   - Tie-break falls to peerId → deterministic result

2. **Write HLC comparison edge case tests in `src/__tests__/hlc.test.ts`** — same ts different count, same ts+count different peerId, etc.

3. **Add idempotency guard to `docReducer`** — if an INSERT arrives for a node ID that already exists, ignore it. This prevents duplicates from message replay.

4. **Manual testing** — open the app, type in both editors at the same position as fast as possible. Verify convergence visually. Add a debug panel that shows `reconstruct(docState)` for each peer to make comparison easy.

5. **Optional: automated integration test** — programmatically dispatch concurrent inserts to both peers' reducers and verify convergence. This can be a vitest test that doesn't need a DOM — just two `DocState` instances and a simulated relay.
