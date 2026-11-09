# @ebbjs/write

The shared ebbjs write planner. An `Operation` is a pure, synchronous
description of one mutation: it receives resolved input plus ids, the
registry, and the actor, and returns the wire Updates it would emit together
with the group set those Updates fan out to. The committer runs a batch under
one context and produces one Action.

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
entity's groups, a one-cardinality edge's row id, a many-cardinality FK set —
which is a materialized cache on the client and an invocation's write buffer
and overlay in the functions runtime.

Ids and clock stamps come from `OperationIds`: `updateId`, `hlc`, and
`newId(prefix)` for the non-Update rows a batch addresses (a Relationship row,
say). `CommitCapability` mirrors them (`generateUpdateId`, `freshHlc`, and an
optional `generateId`) so a caller that needs a deterministic batch can supply
its own sequence.

## Module map

| Module                    | What it ships                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/operations.ts`       | The operation vocabulary: `createEntity`, `patchEntity`, `changeGroups`, `writeRelationship`, and friends. |
| `src/committer.ts`        | `commit` — one shared `OpContext`, flattened Updates, one Action.                                          |
| `src/verbs.ts`            | `WriteVerb` / `operationCallFor` / `createEntityInput` — semantic verbs to planner calls.                  |
| `src/relationship.ts`     | Wire builders for relationship and `entityGroup` Updates.                                                  |
| `src/membership.ts`       | Group-scope resolution and the membership refusals.                                                        |
| `src/pointer.ts`          | `PointerValue` / `normalizePointer`.                                                                       |
| `src/field-projection.ts` | `projectFieldValue` — wire field to application value.                                                     |
| `src/rejection.ts`        | `Rejection` / `WriteResponse` wire shapes.                                                                 |
