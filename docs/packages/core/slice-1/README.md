# Slice 1: @ebbjs/core Implementation

This directory contains the implementation plan for `@ebbjs/core`, split into groups of tasks.

## Files

| File | Tasks | Description |
|------|-------|-------------|
| [01-02-package-setup.md](01-02-package-setup.md) | 1–2 | Package dependencies, tsconfig, directory structure |
| [03-05-schemas.md](03-05-schemas.md) | 3–5 | Typebox schemas for NanoId, Action, Update, Entity, System entities |
| [06-10-hlc.md](06-10-hlc.md) | 6–10 | HLC types, constants, pack/unpack, clock operations, comparison, validation |
| [11-14-encoding-helpers.md](11-14-encoding-helpers.md) | 11–14 | MessagePack encoding, ID generation, Action helper, validation |
| [15-18-integration.md](15-18-integration.md) | 15–18 | Main exports, type declarations, unit tests, package config |

## Build Order

1. Tasks 1–2: Package setup, directory structure
2. Tasks 3–5: Typebox schemas (NanoId, Action, Entity)
3. Tasks 6–10: HLC implementation
4. Tasks 11–14: MessagePack encoding, ID generation, Action helper, validation
5. Tasks 15–18: Main exports, type declarations, tests, package config

## Verification

```bash
cd packages/core
pnpm build       # Build dist/
pnpm typecheck   # TypeScript validation
pnpm test        # Run unit tests
```

## Cross-cutting Concerns

- **HLC conversion** happens at the MessagePack boundary (Task 11), not within HLC itself (Tasks 6–10)
- **Typebox schemas** are the foundation (Tasks 3–5) and are used by validation functions (Task 14)
- **nanoid** dependency is introduced in Task 1, used for ID generation (Task 12)