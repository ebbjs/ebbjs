# Slice 5: Concurrent Conflict with Runs

## Goal

Two users type at the exact same position simultaneously, causing run splits and HLC tie-breaks, and both editors converge to the same final document — proving that run-level operations preserve the causal tree's deterministic convergence properties.

## Components involved

| Component                                   | Interface subset used                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [HLC](../components/hlc.md)                 | `compare` (tie-break), `receive` (clock merge)                                                             |
| [Causal Tree](../components/causal-tree.md) | `docReducer` (INSERT_RUN with sibling ordering, SPLIT), `findInsertPosition`, `reconstruct`, `makeSplitId` |
| [CM Bridge](../components/cm-bridge.md)     | `applyRemoteInsert` (inserting at tie-break-determined position)                                           |
| [Relay](../components/relay.md)             | Full message handling with split detection                                                                 |
| [Editor App](../components/editor-app.md)   | Full two-peer setup                                                                                        |

## Flow

### Scenario 1: Concurrent inserts at the same parent (no split needed)

1. Both editors start with empty document
2. Peer A types "hello" → creates run `{ id: "1000:...:peer-A", text: "hello", parentId: ROOT }`
3. Peer B types "world" → creates run `{ id: "1000:...:peer-B", text: "world", parentId: ROOT }`
4. Both runs are children of ROOT — they are siblings
5. Tie-break: `"peer-B" > "peer-A"` lexicographically → "world" has higher HLC → "world" comes first
6. Both peers converge to `"worldhello"`

**Peer A's perspective:**

- Has "hello" locally
- Receives INSERT_RUN for "world" (parent = ROOT)
- `findInsertPosition` sees ROOT has two children: "world" (higher HLC) and "hello" (lower). "world" goes first → position 0
- `applyRemoteInsert(view, 0, "world")` → "worldhello" ✓

**Peer B's perspective:**

- Has "world" locally
- Receives INSERT_RUN for "hello" (parent = ROOT)
- `findInsertPosition` sees ROOT has two children: "world" (higher) and "hello" (lower). "hello" goes second → position 5
- `applyRemoteInsert(view, 5, "hello")` → "worldhello" ✓

### Scenario 2: Concurrent inserts that require splitting

1. Both editors have "hello" (one run, ID = helloId, by Peer A)
2. Peer A inserts "X" after "hel" (position 3) → Peer A splits locally: "hel" + "lo", inserts "X" between them
3. Peer B inserts "Y" after "hel" (position 3) → Peer B splits locally: "hel" + "lo", inserts "Y" between them
4. Now both peers need to apply the other's insert

**Peer A receives Peer B's INSERT_RUN for "Y":**

- Peer A's tree already has: "hel" (helloId) → "X" (xId) + "lo" (helloId:s:3)
- "Y" has parent = helloId (which is "hel" after Peer A's split)
- "Y" is a new sibling of "X" and "lo" under parent "hel"
- Sibling ordering by HLC: if Y > X, order is "hel" → Y, X, "lo". If X > Y, order is "hel" → X, Y, "lo"
- No additional split needed — "hel" is already split, and "Y" is inserted as a sibling

**Peer B receives Peer A's INSERT_RUN for "X":**

- Peer B's tree already has: "hel" (helloId) → "Y" (yId) + "lo" (helloId:s:3)
- Same logic — "X" is a sibling of "Y" and "lo"
- Same ordering by HLC → same result

**Both converge** to the same document (e.g., "helYXlo" or "helXYlo" depending on HLC comparison).

### Scenario 3: Split-ID determinism across peers

1. Both peers have run "hello" (helloId)
2. Peer A receives a remote insert that requires splitting "hello" at offset 3
3. Peer B receives the same remote insert (or a different one at the same offset)
4. Both peers compute `makeSplitId(helloId, 3)` → same split ID
5. The right half "lo" has the same ID on both peers → the trees are structurally identical

### The key invariants (same as per-character, now proven for runs)

1. **Commutativity**: Applying the same set of INSERT_RUN operations in any order produces the same `reconstruct` output
2. **Idempotency**: Applying the same INSERT_RUN twice is a no-op
3. **Deterministic splits**: `makeSplitId` produces the same ID regardless of which peer performs the split
4. **Convergence**: After all messages are delivered, both peers have identical document state

## Acceptance criteria

- [ ] **Convergence (unit test)**: Create two `DocState` instances. Apply the same set of INSERT_RUN + SPLIT operations in different orders. `reconstruct` produces identical results.
- [ ] **Sibling ordering (unit test)**: Insert three runs with the same parent but different HLCs. `reconstruct` produces them in descending HLC order.
- [ ] **Tie-break on peerId (unit test)**: Insert two runs with same parent, same `ts`, same `count`, different `peerId`. Higher peerId's run comes first.
- [ ] **Split determinism (unit test)**: Two independent states, both split the same run at the same offset. The split IDs are identical. Subsequent inserts produce the same tree structure.
- [ ] **Concurrent split + insert (unit test)**: Both peers split the same run and insert at the split point. Apply ops in both orders. Both converge.
- [ ] **Visual convergence (manual)**: Type simultaneously in both editors at the same position. After sync, both show identical text.
- [ ] **Idempotency**: Receiving the same INSERT_RUN twice does not duplicate the run.
- [ ] **Commutativity**: Full sequence of run inserts applied in forward and reverse order produce the same result.

## Build order

1. **Write convergence unit tests in `src/__tests__/causal-tree.test.ts`** — this is the most critical validation. Port the existing per-character convergence tests to use `RunNode`:
   - Two concurrent INSERT_RUNs with same parent, applied in both orders → same result
   - Three concurrent INSERT_RUNs → correct descending HLC order in all 6 permutations
   - Concurrent inserts that both require splitting the same run → convergence
   - Full sequence of inserts in forward and reverse order → same result

2. **Write split determinism tests** — verify `makeSplitId` produces identical IDs on both peers. Verify that splitting a run and then inserting between the halves produces the same tree regardless of operation order.

3. **Test the relay's split detection** — in `src/__tests__/relay.test.ts`:
   - Remote INSERT_RUN whose parent is an existing run that needs splitting → SPLIT dispatched first
   - Remote INSERT_RUN whose parent was already split by a previous remote op → no redundant split
   - Two concurrent remote INSERT_RUNs that both target the same run → both splits applied correctly

4. **Manual testing** — open the app, type rapidly in both editors at the same position. Verify convergence visually. Use the inspector to verify message flow.

5. **Stress test** — programmatically generate many concurrent inserts at overlapping positions. Verify convergence across all orderings. This can be a vitest test with no DOM — just two `DocState` instances and simulated message passing.
