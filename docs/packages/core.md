# @ebbjs/core

## Purpose

Provides TypeScript types, runtime validation, HLC implementation, and MessagePack encoding for the ebb domain model. Single source of truth for client-side domain logic, aligned with ebb_server expectations.

## Responsibilities

- Define domain types matching server's data model
- Provide Typebox schemas for runtime validation
- Implement Hybrid Logical Clock (generation, comparison, parsing)
- Wrap MessagePack encoding/decoding for wire format
- Zero runtime dependencies beyond Typebox and msgpack

## Public interface

### Types

#### NanoId

```typescript
// String identifier with type prefix and unique suffix
// Examples: "act_abc123", "todo_xyz", "upd_001"
type NanoId = string;
```

#### HLC (Hybrid Logical Clock)

```typescript
// Server expects 64-bit integer, client uses string representation
// String format: decimal encoding of packed bigint (e.g., "1711036800001")
type HLCTimestamp = string;

// Server returns HLC as integer in responses
// Client converts to/from string for internal use
```

#### Action

The primary write unit. Sent to `/sync/actions` as MessagePack.

```typescript
interface Action {
  id: NanoId;           // Unique action ID (nanoid)
  actor_id: ActorId;    // Actor who created the action
  hlc: HLCTimestamp;    // HLC timestamp (client generates)
  gsn: number;         // Assigned by server on commit (0 until acknowledged)
  updates: Update[];   // Non-empty array of updates
}
```

#### Update

A single modification within an Action.

```typescript
interface Update {
  id: NanoId;                    // Unique update ID within action
  subject_id: NanoId;            // ID of entity being updated
  subject_type: SubjectType;    // Entity type (e.g., "todo", "doc", "group")
  method: UpdateMethod;          // "put" | "patch" | "delete"
  data: UpdateData | null;      // Payload (null for delete)
}

type SubjectType = string;  // "todo" | "doc" | "group" | "groupMember" | "relationship"

type UpdateMethod = "put" | "patch" | "delete";
```

#### UpdateData Format

**For `put`** (create or replace):
```typescript
interface PutData {
  fields: {
    [fieldName: string]: FieldValue;
  };
}

interface FieldValue {
  value: unknown;      // The field's value
  update_id: NanoId;   // ID of the update that set this value
}
```

**For `patch`** (merge with existing):
```typescript
interface PatchData {
  fields: {
    [fieldName: string]: Partial<FieldValue>;  // Only include changed fields
  };
}
```

**For `delete`**: `data` is ignored (server performs soft delete)

#### Entity

Materialized view of a subject. Built client-side by replaying Updates from storage. The server never returns Entity objects during sync — clients receive Actions/Updates and materialize locally.

```typescript
interface Entity {
  id: NanoId;
  type: string;
  data: EntityData;
  created_hlc: HLCTimestamp;
  updated_hlc: HLCTimestamp;
  deleted_hlc: HLCTimestamp | null;
  last_gsn: number;
}

interface EntityData {
  fields: {
    [fieldName: string]: FieldValue;
  };
}
```

#### System Entities

System entities (`group`, `groupMember`, `relationship`) use flat data format without `fields` wrapper.

```typescript
// Group
interface Group {
  id: GroupId;
  type: "group";
  data: {
    name: string;
  };
}

// GroupMember
interface GroupMember {
  id: NanoId;
  type: "groupMember";
  data: {
    group_id: GroupId;
    actor_id: ActorId;
    permissions: string[];
  };
}

// Relationship
interface Relationship {
  id: NanoId;
  type: "relationship";
  data: {
    source_id: NanoId;
    target_id: NanoId;
    relationship_type: string;
  };
}
```

---

### Typebox Schemas

Each type has a corresponding Typebox schema for runtime validation.

```typescript
import { Type, Static } from "@sinclair/typebox";

// Core schemas
const NanoIdSchema = Type.String({ pattern: "^[a-z]+_[a-zA-Z0-9]+$" });
const HLCSchema = Type.String();  // Decimal string of packed bigint
const ActionSchema = Type.Object({ ... });
const UpdateSchema = Type.Object({ ... });
const EntitySchema = Type.Object({ ... });

// FieldValue for entity data
const FieldValueSchema = Type.Object({
  value: Type.Unknown(),
  update_id: NanoIdSchema,
  hlc: HLCSchema  // Optional, for tiebreaking
});

// Derived TypeScript types
type NanoId = Static<typeof NanoIdSchema>;
type Action = Static<typeof ActionSchema>;
type Update = Static<typeof UpdateSchema>;
type Entity = Static<typeof EntitySchema>;
```

### Validation Functions

```typescript
// Validate an Action against its schema
function validateAction(action: unknown): action is Action;

// Validate an Update against its schema  
function validateUpdate(update: unknown): update is Update;

// Validate an Entity against its schema
function validateEntity(entity: unknown): entity is Entity;

// Validate a batch of Actions
function validateActions(actions: unknown[]): actions is Action[];

// Validate cursor format (GSN is just a number)
function validateCursor(cursor: unknown): cursor is number;
```

---

### HLC (Hybrid Logical Clock)

#### Constants

```typescript
const COUNTER_BITS = 16n;           // Bits for counter component
const COUNTER_MASK = 0xFFFFn;       // Mask for counter extraction
const MAX_FUTURE_DRIFT_MS = 120_000n;  // Max 120 seconds ahead (server validation)
const MAX_PAST_DRIFT_MS = 86_400_000n; // Max 24 hours behind (server validation)
// Note: Server uses different bounds than client default (60s)
// Client default: 60_000n for local generation safety
// Server accepts: 120_000n future, 24h past
```

#### Types

```typescript
// Internal clock state
interface HLCState {
  l: bigint;       // Logical time (milliseconds since Unix epoch)
  c: bigint;       // Counter component (0-65535)
  maxDrift: bigint;
}

// Parsed HLC components
interface HLCComponents {
  logicalTime: bigint;  // Upper 48 bits (physical time in ms)
  counter: bigint;     // Lower 16 bits
}
```

#### Functions

```typescript
// Create a new clock instance
function createClock(maxDrift?: bigint): HLCState;

// Generate HLC for a local event
// Returns HLCTimestamp (decimal string of packed bigint)
function localEvent(state: HLCState): HLCTimestamp;

// Receive a remote HLC, validate drift, advance local clock
// Throws if drift exceeds server bounds
function receiveRemoteHLC(state: HLCState, remoteHlc: HLCTimestamp): HLCTimestamp;

// Pack components to bigint
function pack(logicalTime: bigint, counter: bigint): bigint;

// Unpack bigint to components
function unpack(hlc: bigint): HLCComponents;

// Parse HLCTimestamp string to bigint
function parse(hlc: HLCTimestamp): bigint;

// Format bigint to HLCTimestamp string
function format(hlc: bigint): HLCTimestamp;

// Compare two HLCs
function compare(a: HLCTimestamp, b: HLCTimestamp): -1 | 0 | 1;
function isBefore(a: HLCTimestamp, b: HLCTimestamp): boolean;
function isAfter(a: HLCTimestamp, b: HLCTimestamp): boolean;

// Validate HLC format
function isValidHLC(hlc: string): boolean;
```

#### HLC Format (aligned with server)

Server uses 64-bit integer: `(logical_time << 16) | counter`

- **Upper 48 bits**: Physical time in milliseconds since Unix epoch
- **Lower 16 bits**: Counter for same-ms events (max 65535 per ms)

**Important**: Server returns HLC as integer in responses (e.g., `1711036800001`). Client converts to/from decimal string for internal use.

#### Algorithm

```typescript
// localEvent:
const now = Date.now();  // Unix ms
if (now > state.l) {
  state.l = now;
  state.c = 0n;
} else {
  state.c = (state.c + 1n) & COUNTER_MASK;  // Wrap at 65535
}
return format(pack(state.l, state.c));

// receiveRemoteHLC:
const remote = unpack(parse(remoteHlc));
if (remote.logicalTime > state.l) {
  state.l = remote.logicalTime;
  state.c = 0n;
} else if (remote.logicalTime === state.l && remote.counter > state.c) {
  state.c = remote.counter;
} else {
  state.c = (state.c + 1n) & COUNTER_MASK;
}
// Validate: now - state.l <= maxFutureDrift AND state.l - now <= maxPastDrift
return format(pack(state.l, state.c));
```

#### Server-Side Validation

Server validates incoming HLCs:

| Check | Bound | Server Rejection |
|-------|-------|------------------|
| Future drift | > 120 seconds ahead | `hlc_future_drift` |
| Past drift | > 24 hours behind | `hlc_stale` |
| Invalid format | Not a positive integer | `invalid_hlc` |

---

### MessagePack

Wire format for `/sync/actions` endpoint.

#### Functions

```typescript
// Encode a value to MessagePack binary (async, for large objects)
function encode<T>(value: T): Uint8Array;

// Decode MessagePack binary to JavaScript object
function decode<T>(data: Uint8Array): T;

// Synchronous variants
function encodeSync<T>(value: T): Uint8Array;
function decodeSync<T>(data: Uint8Array): T;
```

#### Request Format (POST /sync/actions)

```typescript
// Body: MessagePack map with binary keys
{
  "actions": [
    {
      "id": "act_abc123",
      "actor_id": "user_xyz",
      "hlc": 1711036800000,   // Note: server expects integer, not string
      "updates": [
        {
          "id": "upd_001",
          "subject_id": "entity_123",
          "subject_type": "todo",
          "method": "put",
          "data": {
            "fields": {
              "title": {"value": "Hello", "update_id": "upd_001"}
            }
          }
        }
      ]
    }
  ]
}
```

**Key detail**: Server expects HLC as integer in MessagePack payload, not string. The `encode` function handles this conversion automatically.

#### Default Export

```typescript
import msgpack from "@ebbjs/core";

const binary = msgpack.encode({ hello: "world" });
const obj = msgpack.decode(binary);
```

---

### Action Creation Helper

```typescript
interface CreateActionOptions {
  actorId: ActorId;
  updates: UpdateData[];
  clock: HLCState;
}

interface UpdateData {
  id: NanoId;
  subject_id: NanoId;
  subject_type: SubjectType;
  method: UpdateMethod;
  data: UpdateDataContent;
}

function createAction(options: CreateActionOptions): {
  action: Action;
  hlc: HLCTimestamp;
};
```

### ID Generation

```typescript
// Generate unique IDs with type prefix
function generateId(prefix: string): NanoId;

// Examples:
const actionId = generateId("act");  // "act_abc123"
const updateId = generateId("upd");  // "upd_xyz789"
```

Uses `nanoid` library with custom prefix for domain-specific IDs.

---

## Dependencies

- `@sinclair/typebox` — schema-first type definitions
- `@msgpack/msgpack` — underlying MessagePack implementation
- `nanoid` — ID generation

## Internal design notes

- Typebox schemas live in `src/schemas/` and are exported from `src/index.ts`
- TypeScript types derived via `Type.Strict()` pattern
- HLC conversion (string ↔ integer) happens at the msgpack boundary
- System entity schemas have flat `data` objects (no `fields` wrapper)
- Validation errors return structured error objects with field paths

## Open questions

- Should we provide JSON Schema export for tooling integration?
- Include `Format` type for entity data (plain-json only in v1, or expand later)?
- **Schema builder** (v2): We will eventually need `defineSchema`, `defineModel` helpers using a subset of Typebox schema definition functionality. Not in v1.
- HLC future drift bounds — server uses 120s, client uses 60s (see [issue #27](https://github.com/ebbjs/ebbjs/issues/27))

## References

- Server: `lib/ebb_server/sync/router.ex` — HTTP endpoints
- Server: `lib/ebb_server/storage/action_validator.ex` — HLC validation
- Server: `lib/ebb_server/storage/permission_helper.ex` — System entity types
- zuko HLC: [zuko HLC implementation](https://github.com/drewlyton/zuko/tree/main/packages/core/src/hlc)