# Slice 1: Integration

## Tasks 15–18: Exports, Types, Tests, Package Config

### Task 15: Create main index exports ✅

**File:** `packages/core/src/index.ts`

The actual `index.ts` is minimal — it re-exports from submodules rather than listing every export individually:

```typescript
export * from "./types";
export * from "./hlc";
export * from "./msgpack";
export * from "./id";
export * from "./action";
```

Each submodule handles its own exports:

| Module | What it exports |
|--------|----------------|
| `./types` | NanoIdSchema, ActionSchema, EntitySchema, GroupSchema, etc. + all types |
| `./hlc` | createClock, localEvent, receiveRemoteHLC, pack/unpack, compare, isValidHLC, constants |
| `./msgpack` | encode, decode, encodeSync, decodeSync + default export |
| `./id` | generateId |
| `./action` | createAction, CreateActionOptions |

**Note:** `validate.ts` at package root exports validation helpers (validateAction, validateUpdate, validateEntity, etc.) but is **not** auto-exported from index — must be imported directly.

---

### Task 16: Add type stub for nanoid import ✅

**Status:** Not needed

The `nanoid` package is used directly via `customAlphabet` from the installed package. No type stub required — `nanoid@5.x` includes its own TypeScript definitions.

---

### Task 17: Write unit tests ✅

**Files:** `packages/core/src/**/*.test.ts`

All 9 test files are written and passing (97 tests total):

| Test file | Coverage |
|-----------|----------|
| `src/hlc/clock.test.ts` | createClock, localEvent, receiveRemoteHLC |
| `src/hlc/compare.test.ts` | compare, isBefore, isAfter |
| `src/hlc/pack.test.ts` | pack, unpack, parse, format |
| `src/hlc/validate.test.ts` | isValidHLC |
| `src/types/action.test.ts` | NanoId, HLCTimestamp, Action/Update schema validation |
| `src/msgpack/convert.test.ts` | HLC↔integer conversion |
| `src/msgpack/index.test.ts` | encode/decode roundtrip (async + sync) |
| `src/id/index.test.ts` | generateId format/uniqueness |
| `src/action/index.test.ts` | createAction produces valid Action |

**Note on Typebox validation:** This codebase uses `Value.Check()` from `@sinclair/typebox/value` for runtime schema validation (not the non-existent `.Check()` instance method). `validate.ts` uses this approach and exports schemas for reuse.

---

### Task 18: Update package.json with correct exports ✅

**File:** `packages/core/package.json`

```json
{
  "name": "@ebbjs/core",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Scripts: `build`, `dev`, `test`, `test:watch`, `typecheck`, `lint`, `lint:fix`, `fmt`, `fmt:check`

---

## Actual API Surface

```typescript
// Types (from ./types)
import type { NanoId, HLCTimestamp, Action, Update, SubjectType, 
                UpdateMethod, FieldValue, Entity, EntityData,
                Group, GroupMember, Relationship, HLCState, HLCComponents } from "@ebbjs/core";

// Schemas (from ./types)
import { NanoIdSchema, ActionSchema, UpdateSchema, EntitySchema,
         SubjectTypeSchema, UpdateMethodSchema, FieldValueSchema,
         PutDataSchema, PatchDataSchema, GroupSchema, GroupMemberSchema,
         RelationshipSchema, HLCTimestampSchema } from "@ebbjs/core";

// HLC (from ./hlc)
import { createClock, localEvent, receiveRemoteHLC,
         pack, unpack, parse, format,
         compare, isBefore, isAfter,
         isValidHLC,
         COUNTER_BITS, COUNTER_MASK, MAX_FUTURE_DRIFT_MS, MAX_PAST_DRIFT_MS } from "@ebbjs/core";

// MessagePack (from ./msgpack)
import { encode, decode, encodeSync, decodeSync } from "@ebbjs/core";
import ebb from "@ebbjs/core";
ebb.msgpack.encode(...); // default export

// ID generation (from ./id)
import { generateId } from "@ebbjs/core";

// Action creation (from ./action)
import { createAction, type CreateActionOptions } from "@ebbjs/core";

// Validation (from ./validate - must import directly)
import { validateAction, validateUpdate, validateEntity,
         validateActions, validateCursor, validateHLCTimestamp,
         ActionSchema, UpdateSchema } from "@ebbjs/core/src/validate";

// Using Value.Check for inline validation
import { Value } from "@sinclair/typebox/value";
Value.Check(ActionSchema, someAction); // → boolean
```

---

## Acceptance Criteria

- [x] Main `index.ts` re-exports from all submodules
- [x] Named imports work: `import { Action } from "@ebbjs/core"`
- [x] Namespace import works: `import * as ebb from "@ebbjs/core"`
- [x] Default import works: `import ebb from "@ebbjs/core"`
- [x] `msgpack` default export works: `ebb.msgpack.encode(...)`
- [x] All 97 tests pass
- [x] `pnpm build` produces `dist/index.js` and `dist/index.d.ts`
- [x] `pnpm typecheck` passes without errors

## Verification Commands

```bash
cd packages/core
pnpm build       # Build dist/
pnpm typecheck   # TypeScript validation
pnpm test        # Run unit tests
```
