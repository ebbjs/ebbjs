# Package Setup

### Task 1: Set up package dependencies and tsconfig

**Files:** `packages/core/package.json` (modify), `packages/core/tsconfig.json` (modify)

**Depends on:** None

Install the required runtime dependencies with pnpm at latest versions:

```bash
cd packages/core
pnpm add @sinclair/typebox @msgpack/msgpack nanoid
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