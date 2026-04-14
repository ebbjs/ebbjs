# Slice 1: Encoding & Helpers

## Tasks 11–14: MessagePack, ID Generation, Action Helper, Validation

### Task 11: Implement MessagePack encoding/decoding with HLC conversion

**Files:** `packages/core/src/msgpack/convert.ts` (create), `packages/core/src/msgpack/index.ts` (create)

**Depends on:** Task 7

**`src/msgpack/convert.ts`:**

```typescript
import { pack, unpack, parse, format } from "../hlc/pack.js";

// Convert HLCTimestamp (string) to integer for MessagePack encoding
export function hlcToInteger(hlc: string): number {
  return Number(parse(hlc));
}

// Convert integer (from MessagePack decoding) to HLCTimestamp (string)
export function integerToHLC(n: number): string {
  return format(BigInt(n));
}

// Recursively convert HLC strings to integers in an object
// Used before sending to server
export function convertHlcToInteger<T>(value: T): T {
  if (typeof value === "string") {
    // Check if this looks like an HLC timestamp
    if (/^\d+$/.test(value) && value.length > 10) {
      return hlcToInteger(value) as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => convertHlcToInteger(v)) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertHlcToInteger(v);
    }
    return result as T;
  }

  return value;
}

// Recursively convert integers to HLC strings in an object
// Used after receiving from server
export function convertIntegerToHlc<T>(value: T): T {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    // Check if this could be an HLC (large number with timestamp-like magnitude)
    // If it's a reasonable HLC value, convert it
    if (value > 1_000_000_000_000) {
      // ~2001 AD in ms
      return format(BigInt(value)) as T;
    }
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => convertIntegerToHlc(v)) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = convertIntegerToHlc(v);
    }
    return result as T;
  }

  return value;
}
```

**`src/msgpack/index.ts`:**

```typescript
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { convertHlcToInteger, convertIntegerToHlc } from "./convert.js";

// Encode a value to MessagePack binary (async, for large objects)
export async function encode<T>(value: T): Promise<Uint8Array> {
  // Convert HLC strings to integers before encoding
  const converted = convertHlcToInteger(value);
  return msgpackEncode(converted);
}

// Decode MessagePack binary to JavaScript object
export async function decode<T>(data: Uint8Array): Promise<T> {
  const decoded = (await msgpackDecode(data)) as T;
  // Convert integers back to HLC strings
  return convertIntegerToHlc(decoded);
}

// Synchronous variants
export function encodeSync<T>(value: T): Uint8Array {
  const converted = convertHlcToInteger(value);
  return msgpackEncode(converted);
}

export function decodeSync<T>(data: Uint8Array): T {
  const decoded = msgpackDecode(data) as T;
  return convertIntegerToHlc(decoded);
}

// Default export for convenience
export default { encode, decode, encodeSync, decodeSync };
```

---

### Task 12: Implement ID generation

**Files:** `packages/core/src/id/index.ts` (create)

**Depends on:** Task 1

```typescript
import { customAlphabet } from "nanoid";

// Default alphabet for nanoid (letters and numbers)
const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// Generate unique IDs with type prefix
export function generateId(prefix: string): string {
  const id = nanoid();
  return `${prefix}_${id}`;
}
```

---

### Task 13: Implement Action creation helper

**Files:** `packages/core/src/action/index.ts` (create)

**Depends on:** Tasks 4, 8, 12

```typescript
import { Action, Update, HLCTimestamp } from "../schemas/index.js";
import { HLCState } from "../hlc/index.js";
import { generateId } from "../id/index.js";

export interface UpdateData {
  id?: string; // Auto-generated if not provided
  subject_id: string;
  subject_type: string;
  method: "put" | "patch" | "delete";
  data: Record<string, unknown> | null;
}

export interface CreateActionOptions {
  actorId: string;
  updates: UpdateData[];
  clock: HLCState;
}

export function createAction(options: CreateActionOptions): {
  action: Action;
  hlc: HLCTimestamp;
} {
  const { actorId, updates, clock } = options;

  // Generate HLC for this action
  const hlc = localEvent(clock);

  // Build updates with generated IDs
  const builtUpdates: Update[] = updates.map((u) => ({
    id: u.id ?? generateId("upd"),
    subject_id: u.subject_id,
    subject_type: u.subject_type as any,
    method: u.method,
    data: u.data as any,
  }));

  const action: Action = {
    id: generateId("act"),
    actor_id: actorId,
    hlc,
    gsn: 0, // Server assigns on commit
    updates: builtUpdates,
  };

  return { action, hlc };
}
```

---

### Task 14: Implement validation functions

**Files:** `packages/core/src/validate.ts` (create)

**Depends on:** Tasks 4, 5

```typescript
import { ActionSchema, UpdateSchema, EntitySchema, HLCTimestampSchema } from "./schemas/index.js";
import { Action, Update, Entity } from "./schemas/index.js";

// Validate an Action against its schema
export function validateAction(action: unknown): action is Action {
  return ActionSchema.Check(action);
}

// Validate an Update against its schema
export function validateUpdate(update: unknown): update is Update {
  return UpdateSchema.Check(update);
}

// Validate an Entity against its schema
export function validateEntity(entity: unknown): entity is Entity {
  return EntitySchema.Check(entity);
}

// Validate a batch of Actions
export function validateActions(actions: unknown[]): actions is Action[] {
  return Array.isArray(actions) && actions.every((a) => validateAction(a));
}

// Validate cursor format (GSN is just a number)
export function validateCursor(cursor: unknown): cursor is number {
  return typeof cursor === "number" && cursor >= 0 && Number.isInteger(cursor);
}

// Validate HLCTimestamp format
export function validateHLCTimestamp(ts: unknown): ts is string {
  return HLCTimestampSchema.Check(ts);
}
```

---

## Acceptance Criteria

- [ ] `encode` converts HLC strings to integers before MessagePack encoding
- [ ] `decode` converts integers back to HLC strings after MessagePack decoding
- [ ] `encodeSync` and `decodeSync` synchronous variants work correctly
- [ ] MessagePack encode/decode roundtrip preserves data integrity
- [ ] HLC values are correctly converted (string ↔ integer) through the wire format
- [ ] `generateId` produces IDs with correct format `prefix_randomid`
- [ ] `generateId` generates unique IDs (collision-free in reasonable usage)
- [ ] `createAction` produces a valid Action object
- [ ] `createAction` auto-generates action ID and update IDs if not provided
- [ ] `createAction` generates HLC via `localEvent` on the provided clock
- [ ] `createAction` sets `gsn` to 0 (server assigns on commit)
- [ ] `validateAction` returns true for valid Action, false otherwise
- [ ] `validateUpdate` returns true for valid Update, false otherwise
- [ ] `validateEntity` returns true for valid Entity, false otherwise
- [ ] `validateActions` validates a batch of Actions
- [ ] `validateCursor` validates GSN format (non-negative integer)
- [ ] `validateHLCTimestamp` validates HLC string format
