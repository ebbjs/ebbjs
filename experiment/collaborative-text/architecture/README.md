# Collaborative Text Editor Experiment

## Summary

This is a standalone experiment (outside the main ebbjs monorepo workspace) that builds a collaborative text editor prototype using CodeMirror 6 and React. The goal is to prove that a custom CRDT-like data structure — a **Causal Tree** ordered by **Hybrid Logical Clocks (HLC)** — can power real-time collaborative editing without relying on Yjs or any CRDT library.

The system renders two side-by-side editor instances in a single browser tab. Each instance has its own peer identity and HLC. A `BroadcastChannel` simulates a network relay between them. When a user types in one editor, the operation is broadcast to the other, which applies it deterministically. The HLC tie-break rule ensures that two users typing at the exact same position simultaneously converge to the same result — no server required.

This experiment is intentionally self-contained: its own `package.json`, its own Vite dev server config, its own dependencies. It does not import from any `@ebbjs/*` package. It uses a strict functional programming style — no classes, pure functions, `useReducer` for state.

## Project structure

```
experiment/collaborative-text/
  src/
    hlc.ts              # Pure HLC functions
    causal-tree.ts      # CharNode type, reducer, reconstruct, findInsertIndex
    cm-bridge.ts        # StateField, updateListener, position↔id mapping
    presence.ts         # Presence state + CM decorations
    relay.ts            # BroadcastChannel hook
    App.tsx             # Editor shell — two side-by-side instances
    main.tsx            # Vite entry point
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

| Component | Purpose |
|-----------|---------|
| [HLC](components/hlc.md) | Pure functions for creating, incrementing, receiving, comparing, and serializing Hybrid Logical Clocks |
| [Causal Tree](components/causal-tree.md) | Reducer-based document state: a `Map<string, CharNode>` with pure insert, delete, and reconstruct operations |
| [CodeMirror Bridge](components/cm-bridge.md) | Bidirectional sync between CodeMirror 6's document model and the Causal Tree via a `StateField` that maps positions to node IDs |
| [Presence](components/presence.md) | Tracks remote peer cursors/selections and renders them as CodeMirror decorations |
| [Relay](components/relay.md) | `BroadcastChannel`-based hook that broadcasts local operations and applies remote ones |
| [Editor App](components/editor-app.md) | React shell that renders two side-by-side editor instances and wires all components together |

## Dependencies

```
Editor App
  ├──→ CodeMirror Bridge ──→ Causal Tree ──→ HLC
  ├──→ Presence ──→ CodeMirror Bridge (reads StateField for position resolution)
  └──→ Relay ──→ HLC (merge remote clocks)
              ──→ Causal Tree (dispatch remote ops to reducer)
              ──→ CodeMirror Bridge (dispatch remote text changes to CM view)
```

**Key dependency rule:** HLC and Causal Tree are pure logic with zero UI or editor dependencies. CodeMirror Bridge depends on Causal Tree but not the other way around. Relay is the integration point that touches everything.

## Vertical slices

| # | Slice | Components involved | Purpose |
|---|-------|---------------------|---------|
| 1 | [Single-user local editing](slices/01-single-user-editing.md) | HLC, Causal Tree, CM Bridge, Editor App | Thinnest path: type in one editor, see text. Proves CM ↔ Causal Tree bidirectional sync. |
| 2 | [Two-peer sync](slices/02-two-peer-sync.md) | + Relay | Type in one editor, see it in the other. Proves BroadcastChannel relay and remote op application. |
| 3 | [Concurrent conflict (tie-break)](slices/03-concurrent-conflict.md) | All above (stress test) | Two users type at the same position simultaneously. Proves HLC tie-break produces deterministic convergence. |
| 4 | [Presence cursors](slices/04-presence-cursors.md) | + Presence | Remote cursors render in each editor and track correctly through edits. |

Slices are ordered from simplest to most complex. Build and validate them in order.

## Cross-cutting concerns

### Functional programming style
All state logic uses pure functions. No classes. Document state lives in a `useReducer`. HLC is a plain object manipulated by pure functions. This applies to every component except the React shell and CodeMirror plugin registration (which are inherently effectful).

### Peer identity
Each editor instance needs a unique peer ID (e.g., `"peer-A"`, `"peer-B"`). This ID is embedded in every HLC and used as a key in the presence map. The Editor App assigns peer IDs; all other components receive them as arguments.

### Error handling
This is a prototype — fail loud. Console errors for invariant violations (e.g., inserting a node whose parent doesn't exist). No retry logic, no graceful degradation.

### Testing strategy
Test behavior, not implementation. HLC and Causal Tree are pure functions — test them with vitest by asserting on outputs given inputs. The CM Bridge is harder to unit test (depends on CM state); test it through integration in the slice acceptance criteria. Use `vitest` with `happy-dom` or `jsdom` for any tests that need a DOM.

### Styling
Tailwind CSS for layout (two side-by-side editors, presence cursor colors). Minimal — this is a prototype, not a product.

## Constraints and assumptions

- **No server.** All communication is via `BroadcastChannel` within a single browser tab. This means no persistence, no multi-tab, no multi-device.
- **No Yjs, no CRDT library.** The whole point is to build the CRDT-like structure from scratch.
- **No classes.** Strict FP constraint from the spec.
- **Single browser tab.** Two editor instances rendered side-by-side in one React app. `BroadcastChannel` works within a single origin (same tab or cross-tab), so this works.
- **Character-level granularity.** Each `CharNode` represents one character. No block-level or rich-text support.
- **Standalone from monorepo.** This experiment has its own `package.json` and is NOT listed in `pnpm-workspace.yaml`. It manages its own dependencies. It should use the same general tooling conventions as the monorepo (Vite, vitest, TypeScript strict mode, ESM) but does not import from `@ebbjs/*`.
- **Vite in dev-server mode.** Unlike the main monorepo packages (which use Vite in library mode), this experiment uses Vite as a dev server with `@vitejs/plugin-react` for JSX/TSX support.
- **Assumption: CodeMirror 6 `StateField` + `RangeSet` can track per-character metadata.** The PLAN.md proposes using `RangeSet<string>` to store node IDs per character position. This needs validation in Slice 1 — if `RangeSet` proves awkward for this use case, a simpler parallel array or `Map<number, string>` rebuilt on each transaction may work better. Flagged as an open question in the CM Bridge component doc.
