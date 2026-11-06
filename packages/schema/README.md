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

const project = defineEntity("project", { name: e.string() });

const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });

const schema = defineSchema({
  entities: { issue, project },
  relationships: { belongsTo },
  version: 1,
});

schema._registry.get("issue");
```

A field declares a read-time default with `.default(v)`; `create()` may then
omit it, and it reads as `T`. A field without one reads as `T | undefined`,
because any row can predate the declaration. A `null` filter value means "no
live value" (absent or cleared) — see the
[absence and defaults](https://ebbjs.com/docs/absence-and-defaults) page.

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
