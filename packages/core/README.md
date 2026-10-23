# @ebbjs/core

TypeScript foundation for the ebbjs domain model: shared types, HLC
implementation, MessagePack wire codec, action creation helper, and ID
generation.

## Install

```bash
npm install @ebbjs/core
```

Node `>=22.8.0`. The package has two entry points:

```typescript
import { createAction, createClock } from "@ebbjs/core";
import { buildSeedAction, type SeedData } from "@ebbjs/core/seed";
```

## Module map

| Module            | What it ships                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/types/`      | Shared TS types: `Action`, `Update`, `Entity`, `FieldValue`, `HLC` (the string form), `GroupId`, etc. |
| `src/hlc/`        | `createClock()`, `localEvent/1`, `receiveClock/2`, comparison, packing/parsing (string ↔ 64-bit int). |
| `src/msgpack/`    | `encodeSync/1`, `decodeSync/1` (MessagePack wire format).                                             |
| `src/id/`         | `nanoid(prefix)` and friends — generates `act_…`, `upd_…`, etc.                                       |
| `src/action/`     | `createAction/1` — composes Update list into an `Action` with the right HLC + ID bookkeeping.         |
| `src/seed/`       | `@ebbjs/core/seed`: `buildSeedAction` — turns plain `SeedData` into one wire `Action` (browser-safe). |
| `src/validate.ts` | Runtime shape checks for inbound action/update payloads.                                              |

135 tests across the package (see [Development](#development)).

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

## Seeding

`@ebbjs/core/seed` is a browser-safe subpath exporting `SeedData` (and its
row types) and `buildSeedAction`, which stamps a fixture's plain field values
into one wire `Action`, plus the shared seed rejection-tolerance policy
(`assertSeedAccepted` / `SeedRejectedError`). `@ebbjs/client`'s
`client.seed()` and `@ebbjs/server`'s raw-POST `seed()` both build through it,
so browser demos and the server test harness share one builder and one policy.

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

## Development

```bash
pnpm --filter @ebbjs/core test
```
