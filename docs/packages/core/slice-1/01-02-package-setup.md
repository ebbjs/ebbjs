# Slice 1: Package Setup

## Tasks 1–2: Foundation

### Task 1: Set up package dependencies and tsconfig

**Files:** `packages/core/package.json` (modify), `packages/core/tsconfig.json` (modify)

**Depends on:** None

Add the required runtime dependencies to `package.json`:

```json
{
  "dependencies": {
    "@sinclair/typebox": "^0.34.0",
    "@msgpack/msgpack": "^3.0.0",
    "nanoid": "^5.0.0"
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
├── schemas/
│   ├── index.ts         # Re-exports all schemas
│   ├── nanoid.ts        # NanoId schema
│   ├── hlc.ts           # HLCTimestamp schema
│   ├── action.ts        # Action and Update schemas
│   ├── entity.ts        # Entity schema
│   └── system.ts        # System entity schemas (Group, GroupMember, Relationship)
├── hlc/
│   ├── index.ts         # Re-exports HLC public API
│   ├── clock.ts         # HLCState, createClock, localEvent, receiveRemoteHLC
│   ├── pack.ts          # pack, unpack, parse, format functions
│   ├── compare.ts       # compare, isBefore, isAfter
│   ├── types.ts         # HLCState, HLCComponents
│   ├── constants.ts     # COUNTER_BITS, COUNTER_MASK, drift bounds
│   └── validate.ts      # isValidHLC
├── msgpack/
│   ├── index.ts         # encode, decode (async and sync variants)
│   └── convert.ts       # HLC string↔integer conversion at boundary
├── id/
│   └── index.ts         # generateId function
├── action/
│   └── index.ts         # createAction helper
└── validate.ts          # Validation functions
```

---

## Acceptance Criteria

- [ ] `package.json` has `@sinclair/typebox`, `@msgpack/msgpack`, and `nanoid` as dependencies
- [ ] `tsconfig.json` extends base config with correct outDir/rootDir
- [ ] Directory structure matches the specified layout