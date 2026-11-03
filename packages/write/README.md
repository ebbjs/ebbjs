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
import { EntityRegistry } from "@ebbjs/schema";
import { call, commit, createEntity } from "@ebbjs/write";

const registry = new EntityRegistry();

await commit([call(createEntity, input)], {
  registry,
  actorId,
  freshHlc,
  generateUpdateId,
  submitRelationshipUpdates: submit,
});
```

## Module map

| Module                    | What it ships                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/operations.ts`       | The operation vocabulary: `createEntity`, `patchEntity`, `changeGroups`, `writeRelationship`, and friends. |
| `src/committer.ts`        | `commit` — one shared `OpContext`, flattened Updates, one Action.                                          |
| `src/relationship.ts`     | Wire builders for relationship and `entityGroup` Updates.                                                  |
| `src/membership.ts`       | Group-scope resolution and the membership refusals.                                                        |
| `src/generated-parts.ts`  | Types for the document entities and edges a membership change carries.                                     |
| `src/pointer.ts`          | `PointerValue` / `normalizePointer`.                                                                       |
| `src/field-projection.ts` | `projectFieldValue` — wire field to application value.                                                     |
| `src/rejection.ts`        | `Rejection` / `WriteResponse` wire shapes.                                                                 |
