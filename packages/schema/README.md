# @ebbjs/schema

Entity, relationship, and schema definitions for ebbjs: the registry,
validation, system entities, reserved names, and the collaborative-text field
type. Pure values only — no storage, no network, no client.

`@ebbjs/client` re-exports this package, so the client API is unchanged.

## Install

```bash
npm install @ebbjs/schema
```

Node `>=22.8.0`.

## Usage

```ts
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";

const issue = defineEntity("issue", {
  title: e.string(),
  body: e.collaborativeText(),
});

const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });

const schema = defineSchema([issue, belongsTo]);
schema.registry.get("issue");
```

## Module map

| Module                    | What it ships                                                          |
| ------------------------- | ---------------------------------------------------------------------- |
| `src/entity.ts`           | `defineEntity`, `e`, field markers, entity types.                      |
| `src/entity-registry.ts`  | `EntityRegistry`, `validatePayload`, `EntityValidationError`.          |
| `src/relationship.ts`     | `defineRelationship` and relationship types.                           |
| `src/schema.ts`           | `defineSchema`, derived-field expansion, schema errors.                |
| `src/system-entities.ts`  | `group`, `groupMember`, `entityGroup`, `relationship` system entities. |
| `src/reserved.ts`         | Reserved entity, membership, and generated-document names.             |
| `src/collaborative-text/` | Document schema, wire adapters, derived ids, tree, and `TextDocument`. |
