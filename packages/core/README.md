# @ebbjs/core

TypeScript foundation for the ebbjs domain model: shared types, HLC
implementation, MessagePack wire codec, action creation helper, and ID
generation.

## Module map

| Module            | What it ships                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/types/`      | Shared TS types: `Action`, `Update`, `Entity`, `FieldValue`, `HLC` (the string form), `GroupId`, etc. |
| `src/hlc/`        | `createClock()`, `localEvent/1`, `receiveClock/2`, comparison, packing/parsing (string ↔ 64-bit int). |
| `src/msgpack/`    | `encodeSync/1`, `decodeSync/1` (MessagePack wire format).                                             |
| `src/id/`         | `nanoid(prefix)` and friends — generates `act_…`, `upd_…`, etc.                                       |
| `src/action/`     | `createAction/1` — composes Update list into an `Action` with the right HLC + ID bookkeeping.         |
| `src/validate.ts` | Runtime shape checks for inbound action/update payloads.                                              |

105 tests across the package (`pnpm --filter @ebbjs/core test`).

## Usage

```typescript
import { createAction, createClock, localEvent, encodeSync } from "@ebbjs/core";

const clock = createClock();

const { action, hlc } = createAction({
  actorId: "user_123",
  clock,
  updates: [
    {
      subject_id: "todo_abc",
      subject_type: "todo",
      method: "put",
      data: { fields: { title: { value: "Buy milk", hlc: localEvent(clock) } } },
    },
  ],
});

const bytes = encodeSync({ actions: [action] });
// POST bytes to /sync/actions as application/msgpack
// server will assign the GSN and return it
```

## HLC

HLCs are 64-bit integers packed with `(logical_time_ms << 16) | counter`.
Internally core works with the integer form; on the wire (and in
`Action.hlc`) the form is a decimal string. `packHlc/1` /
`unpackHlc/1` convert; `compareHLC/2` does the correct lex ordering
inside an HLC. The server's validation rule (reject if `logical_time`
is more than 120s in the future or 24h in the past) is documented in
[#120](https://github.com/ebbjs/ebbjs/issues/120).

## Dependencies

TypeBox (schemas — only used inside validation paths) and `msgpackr`
(wire codec). No other runtime deps.
