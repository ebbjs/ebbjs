# Slice 1: Integration

## Tasks 15–18: Exports, Types, Tests, Package Config

### Task 15: Create main index exports

**Files:** `packages/core/src/index.ts` (create)

**Depends on:** Tasks 3, 4, 5, 8, 9, 10, 11, 12, 13, 14

```typescript
// Types and schemas
export type { NanoId, HLCTimestamp } from "./schemas/index.js";
export type { Action, Update, SubjectType, UpdateMethod, FieldValue } from "./schemas/action.js";
export type { Entity, EntityData } from "./schemas/entity.js";
export type { Group, GroupMember, Relationship } from "./schemas/system.js";
export type { HLCState, HLCComponents } from "./hlc/types.js";

// Schemas
export { 
  NanoIdSchema, 
  HLCTimestampSchema, 
  ActionSchema, 
  UpdateSchema, 
  EntitySchema,
  FieldValueSchema,
  PutDataSchema,
  PatchDataSchema,
  GroupSchema,
  GroupMemberSchema,
  RelationshipSchema
} from "./schemas/index.js";

// HLC functions
export { 
  createClock, 
  localEvent, 
  receiveRemoteHLC,
  pack, 
  unpack, 
  parse, 
  format, 
  compare, 
  isBefore, 
  isAfter,
  isValidHLC,
  COUNTER_BITS,
  COUNTER_MASK,
  MAX_FUTURE_DRIFT_MS,
  MAX_PAST_DRIFT_MS
} from "./hlc/index.js";

// MessagePack
export { encode, decode, encodeSync, decodeSync } from "./msgpack/index.js";
export { default as msgpack } from "./msgpack/index.js";

// ID generation
export { generateId } from "./id/index.js";

// Action creation
export { createAction, type CreateActionOptions, type UpdateData } from "./action/index.js";

// Validation
export { validateAction, validateUpdate, validateEntity, validateActions, validateCursor, validateHLCTimestamp } from "./validate.js";
```

---

### Task 16: Add type stub for nanoid import

**Files:** `packages/core/src/nanoid.d.ts` (create)

**Depends on:** Task 1

Create a type declaration for the nanoid import since we're using `customAlphabet`:

```typescript
declare module "nanoid" {
  export function customAlphabet(alphabet: string, size?: number): () => string;
}
```

---

### Task 17: Write unit tests

**Files:** `packages/core/src/**/*.test.ts` (create)

**Depends on:** All preceding tasks

Create tests for each major module:

**`src/schemas/action.test.ts`:**
- Test NanoId validation (valid patterns, invalid patterns)
- Test HLCTimestamp schema validation
- Test Action schema validation with valid/invalid data
- Test Update schema with put/patch/delete variants

**`src/hlc/clock.test.ts`:**
- Test `createClock` returns correct initial state
- Test `localEvent` advances logical time
- Test `localEvent` increments counter when same ms
- Test `localEvent` wraps counter at 65535
- Test `receiveRemoteHLC` advances when remote is ahead
- Test `receiveRemoteHLC` takes max counter when same time
- Test `receiveRemoteHLC` increments counter when behind
- Test drift validation throws on excessive drift

**`src/hlc/compare.test.ts`:**
- Test `compare` returns correct ordering
- Test `isBefore` / `isAfter` predicates
- Test equal HLCs

**`src/hlc/pack.test.ts`:**
- Test `pack` / `unpack` roundtrip
- Test `parse` / `format` roundtrip
- Test bit manipulation correctness

**`src/msgpack/convert.test.ts`:**
- Test HLC string to integer conversion
- Test integer to HLC string conversion
- Test nested object conversion
- Test array conversion

**`src/msgpack/index.test.ts`:**
- Test encode/decode roundtrip
- Test HLC conversion in encode/decode cycle
- Test sync variants

**`src/id/index.test.ts`:**
- Test `generateId` produces correct format
- Test uniqueness of generated IDs

**`src/action/index.test.ts`:**
- Test `createAction` produces valid Action
- Test HLC is generated and assigned
- Test updates have generated IDs
- Test gsn defaults to 0

---

### Task 18: Update package.json with correct exports

**Files:** `packages/core/package.json` (modify)

**Depends on:** Tasks 1, 15

Ensure the exports field properly exposes all entry points and scripts are correct. The current configuration looks adequate but verify after all files are created.

---

## Acceptance Criteria

- [ ] Main `index.ts` exports all types, schemas, and functions
- [ ] Named imports work correctly: `import { Action } from "@ebbjs/core"`
- [ ] Namespace import works: `import * as ebb from "@ebbjs/core"`
- [ ] Default import works: `import ebb from "@ebbjs/core"`
- [ ] `msgpack` default export works: `ebb.msgpack.encode(...)`
- [ ] `nanoid.d.ts` type declaration resolves `customAlphabet` type
- [ ] All unit tests pass
- [ ] `pnpm build` produces `dist/index.js` and `dist/index.d.ts`
- [ ] `pnpm typecheck` passes without errors
- [ ] `pnpm test` runs all tests successfully
- [ ] Package exports field correctly points to main entry

## Verification Commands

```bash
cd packages/core
pnpm build       # Build dist/
pnpm typecheck   # TypeScript validation
pnpm test        # Run unit tests
```