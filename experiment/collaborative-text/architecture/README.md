# Collaborative Text Editor — Optimization Pass

## Summary

This architecture extends the existing `@experiment/collaborative-text` prototype to address three performance bottlenecks that make the per-character causal tree impractical for documents beyond a few hundred characters:

1. **Storage bloat** — Every character is a separate `CharNode` with a ~40-char HLC string ID. A 10K-char document means 10K objects in a `Map`, each with string keys, parent pointers, and tombstone flags.
2. **O(n) per-keystroke cost** — `reconstruct()` and `buildPositionMap()` perform a full DFS traversal of the entire tree on every single keystroke. `findInsertPosition` does the same plus a `countVisibleInSubtree` walk.
3. **Network chattiness** — Pasting 1000 characters broadcasts 1000 individual INSERT messages over BroadcastChannel, each triggering a separate reducer dispatch and CM transaction on the remote side.

The optimization introduces three changes that address these problems while preserving the causal tree's core properties (commutativity, idempotency, deterministic convergence):

- **Run-length nodes** — Collapse consecutive same-peer sequential characters into a single `RunNode { id, text, parentId, ... }`. Typing "hello" = 1 node, not 5.
- **Incremental position index** — Maintain a flat position-to-run mapping that gets spliced on insert/delete instead of rebuilt via full DFS every keystroke.
- **Batched wire protocol** — Group sequential local inserts into a single `INSERT_RUN` message. Remote side applies the whole run in one reducer dispatch + one CM transaction.

This is an experimental throwaway POC. No backward compatibility with the current per-character protocol. No persistence (separate concern). Same functional programming style, same BroadcastChannel relay, same two-peer side-by-side demo.

## Project structure

```
experiment/collaborative-text/
  src/
    hlc.ts              # Pure HLC functions (unchanged)
    causal-tree.ts      # RunNode type, reducer, PositionIndex, split/merge
    cm-bridge.ts        # StateField, batch local edits, consume PositionIndex
    presence.ts         # Presence state + CM decorations (minor changes)
    relay.ts            # BroadcastChannel hook, INSERT_RUN/DELETE_RANGE messages
    App.tsx             # Editor shell (wiring changes)
    inspector-store.ts  # Inspector store (minor: display run-level info)
    InspectorPanel.tsx  # Inspector UI (minor: display run-level info)
    main.tsx            # Vite entry point (unchanged)
    __tests__/
      hlc.test.ts
      causal-tree.test.ts
      cm-bridge.test.ts
      relay.test.ts
  index.html
  package.json
  tsconfig.json
  vite.config.ts
```

## Components

| Component | Purpose | Change scope |
|-----------|---------|-------------|
| [HLC](components/hlc.md) | Pure HLC functions — create, increment, receive, compare, serialize | Unchanged |
| [Causal Tree](components/causal-tree.md) | Run-length document state: `RunNode` with split/merge, incremental `PositionIndex`, pure reducer | Major rework |
| [CodeMirror Bridge](components/cm-bridge.md) | Batches local edits into run-level actions, consumes incremental position index | Moderate changes |
| [Relay](components/relay.md) | `INSERT_RUN` / `DELETE_RANGE` message types, batch broadcast | Moderate changes |
| [Presence](components/presence.md) | Position resolution via new `PositionIndex` API | Minor changes |
| [Editor App](components/editor-app.md) | Wire new types through, same overall structure | Minor changes |

## Dependencies

```
Editor App
  ├──→ CM Bridge ──→ Causal Tree (RunNode, PositionIndex) ──→ HLC
  ├──→ Presence ──→ Causal Tree (PositionIndex for position resolution)
  │              ──→ CM Bridge (StateField for ID map, unchanged)
  └──→ Relay ──→ HLC (merge remote clocks)
              ──→ Causal Tree (dispatch remote run ops to reducer)
              ──→ CM Bridge (batch-apply remote text changes to CM view)
```

**Key dependency rule (unchanged):** HLC and Causal Tree are pure logic with zero UI or editor dependencies. CM Bridge depends on Causal Tree but not the other way around. Relay is the integration hub that touches everything.

**New interface boundary:** The `PositionIndex` is owned by Causal Tree and exposed as part of `DocState`. CM Bridge and Presence consume it read-only. Only the reducer mutates it.

## Vertical slices

| # | Slice | Components involved | Purpose |
|---|-------|---------------------|---------|
| 1 | [RunNode basics](slices/01-run-node-basics.md) | Causal Tree, HLC | Thinnest path: RunNode insert, split, delete, reconstruct. Pure unit tests. |
| 2 | [Incremental position index](slices/02-incremental-position-index.md) | Causal Tree | Position lookups correct after insert/split/delete without full DFS. |
| 3 | [Single-user editing with runs](slices/03-single-user-editing-runs.md) | CM Bridge, Causal Tree, HLC, Editor App | CM Bridge batches keystrokes into runs, dispatches to tree, ID map stays consistent. |
| 4 | [Two-peer sync with batched protocol](slices/04-two-peer-sync-batched.md) | + Relay | Relay sends/receives `INSERT_RUN` messages. Remote peer applies correctly. |
| 5 | [Concurrent conflict with runs](slices/05-concurrent-conflict-runs.md) | All | Two peers type at same position. Run splitting + HLC tie-break → deterministic convergence. |

Slices are ordered from simplest to most complex. Build and validate them in order. Each slice builds on the previous — don't skip ahead.

## Cross-cutting concerns

### Functional programming style
Unchanged. All state logic uses pure functions. No classes (except CM6's required `WidgetType` subclass for cursor rendering). Document state lives in a `useReducer`. HLC is a plain object manipulated by pure functions.

### Run identity and splitting
A `RunNode` gets a single HLC-derived ID (the HLC at the time the run started). When a run must be split (e.g., a remote insert lands in the middle), the left half keeps the original ID and the right half gets a new deterministic ID derived from the original (e.g., `originalId + ":split:" + offset`). This preserves the causal tree's commutativity — the same split applied in any order produces the same result. See the [Causal Tree component doc](components/causal-tree.md) for details.

### Position index consistency
The `PositionIndex` is always updated atomically with the tree mutation inside the reducer. There is no window where the tree and the index are out of sync. This replaces the current pattern of "mutate tree, then rebuild position map as a separate step."

### Peer identity
Unchanged. Each editor instance has a unique peer ID embedded in every HLC.

### Error handling
Unchanged. Fail loud. Console errors for invariant violations.

### Testing strategy
Same approach: test behavior, not implementation. The Causal Tree is pure functions — test with vitest. The new `PositionIndex` is also pure and testable in isolation. CM Bridge integration is tested through slice acceptance criteria.

### Persistence (future concern)
Run-length nodes are significantly more serialization-friendly than per-character nodes. A 10K-char document might have ~100-500 runs instead of 10K nodes. This makes JSON serialization, IndexedDB storage, or wire snapshots practical. Not in scope for this pass, but the architecture doesn't preclude it.

## Constraints and assumptions

- **No backward compatibility.** This is a clean break from the per-character protocol. Both peers must run the new code.
- **No server.** Same as before — BroadcastChannel within a single browser tab.
- **No CRDT library.** Still building from scratch.
- **No classes.** Strict FP constraint.
- **Run-level granularity.** The atomic unit is now a `RunNode` (1+ characters), not a single character. Rich text and block-level structure remain out of scope.
- **Assumption: runs are typically 5-50 characters.** Normal typing produces runs of word-length or line-length. Pathological cases (e.g., every character inserted at a random position) degrade to per-character behavior. The architecture handles this correctly but without the performance benefit.
- **Assumption: split IDs are deterministic.** The split-ID scheme (`originalId + ":split:" + offset`) must produce the same result regardless of which peer performs the split. This is validated in Slice 5.
