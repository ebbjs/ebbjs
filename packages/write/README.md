# @ebbjs/write

The shared ebbjs write planner. An `Operation` is a pure, synchronous
description of one mutation: it receives resolved input plus ids, the
registry, and the actor, and returns the wire Updates it would emit together
with the group set those Updates fan out to. The committer runs a batch under
one context and produces one Action.

A row exists because of a `create` Update, never because something was written
to it: every operation that brings a row into existence emits its create first,
then the component Updates that carry its fields.

No storage reads, no network, and no dependency on `@ebbjs/client`.
`@ebbjs/client` re-exports this package, so the client API is unchanged.

## Install

```bash
npm install @ebbjs/write
```

Node `>=22.8.0`.

## Usage

```ts
import { ModelRegistry } from "@ebbjs/schema";
import { call, commit, createEntity } from "@ebbjs/write";

const registry = new ModelRegistry();

await commit([call(createEntity, input)], {
  registry,
  actorId,
  freshHlc,
  generateUpdateId,
  submitRelationshipUpdates: submit,
});
```

## Verbs

A `WriteVerb` is the semantic layer above an operation: the plain-value
description of `create` / `update` / `delete` / `relate` / `unrelate` that both
the client's draft planner and the functions runtime resolve into operations.
`operationCallFor(registry, verb, resolution)` maps one verb to its
`OperationCall`, and `createEntityInput` interprets a create's field map
(pointers, collapsed handles). A caller supplies a
`VerbResolution` for the state the verb needs but the caller owns — the acting
entity's groups and the live targets of the edge set it writes — which is a
materialized cache on the client and an invocation's write buffer and overlay in
the functions runtime. The live targets are what turns a `replace`, a
one-cardinality `relate`, and an accessor clear into per-key presence leaves and
tombstones.

Ids and clock stamps come from `OperationIds`: `updateId`, `hlc`, and
`newId(prefix)` for the non-Update ids a batch mints (a row id, say).
`CommitCapability` mirrors them (`generateUpdateId`, `freshHlc`, and an optional
`generateId`) so a caller that needs a deterministic batch can supply its own
sequence.

## Module map

| Module                    | What it ships                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/operations.ts`       | The operation vocabulary: `createEntity`, `patchEntity`, `changeGroups`, `writeRelationship`, and friends. |
| `src/committer.ts`        | `commit` — one shared `OpContext`, flattened Updates, one Action.                                          |
| `src/verbs.ts`            | `WriteVerb` / `operationCallFor` / `createEntityInput` — semantic verbs to planner calls.                  |
| `src/relationship.ts`     | Wire builders for `ebb/link` edge Updates and membership rows.                                             |
| `src/membership.ts`       | Group-scope resolution and the membership refusals.                                                        |
| `src/row-create.ts`       | `rowCreate` — the one Update that brings a row into existence.                                             |
| `src/system-rows.ts`      | The platform row emitters: a group, grant, or membership row's create plus its one atomic `ebb/*` Update.  |
| `src/pointer.ts`          | `PointerValue` / `normalizePointer`.                                                                       |
| `src/field-projection.ts` | `projectFieldValue` — wire field to application value.                                                     |
| `src/rejection.ts`        | `Rejection` / `WriteResponse` wire shapes.                                                                 |
