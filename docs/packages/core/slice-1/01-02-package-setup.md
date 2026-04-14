# Slice 1: Package Setup

## Tasks 1–2: Foundation

### Task 1: Set up package dependencies and tsconfig

**Files:** `packages/core/package.json` (modify), `packages/core/tsconfig.json` (modify)

**Depends on:** None

Install the required runtime dependencies with pnpm at latest versions:

```bash
cd packages/core
pnpm add @sinclair/typebox @msgpack/msgpack nanoid
```

Update `package.json` to ensure dependencies are present:

```json
{
  "dependencies": {
    "@sinclair/typebox": "latest",
    "@msgpack/msgpack": "latest",
    "nanoid": "latest"
  }
}
```

Update `tsconfig.json` to extend the base config:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

---

### Task 2: Create directory structure

**Files:** Create directories (no file modifications)

**Depends on:** None

Create the following directory structure under `packages/core/src/`:

```
src/
├── types/
│   ├── index.ts         # Re-exports all types
│   ├── nanoid.ts        # NanoId type
│   ├── hlc.ts           # HLCTimestamp type
│   ├── action.ts        # Action and Update types
│   ├── entity.ts        # Entity type
│   ├── group.ts         # Group type
│   ├── group-member.ts  # GroupMember type
│   └── relationship.ts  # Relationship type
├── hlc/
│   ├── index.ts         # Re-exports HLC public API
│   ├── clock.ts         # createClock, localEvent, receiveRemoteHLC
│   ├── pack.ts          # pack, unpack, parse, format functions
│   ├── compare.ts       # compare, isBefore, isAfter
│   └── validate.ts      # isValidHLC
├── msgpack/
│   └── index.ts         # encode, decode (async and sync), HLC conversion
├── id/
│   └── index.ts         # generateId function
└── action/
    └── index.ts         # createAction helper
```

**Notes:**
- `types/` directory (not `schemas/`) to avoid confusion with future schema definition code
- System entity types are single files: `group.ts`, `group-member.ts`, `relationship.ts`
- Validation functions live alongside their Typebox schemas in `types/`
- HLC string↔integer conversion is part of `msgpack/index.ts` (not a separate file)

---

## Acceptance Criteria

- [ ] `pnpm add` installs latest versions of typebox, msgpack, nanoid
- [ ] `package.json` has the three dependencies
- [ ] `tsconfig.json` extends base config with correct outDir/rootDir
- [ ] Directory structure matches the specified layout