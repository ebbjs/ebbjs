# @ebbjs/schema

Entity, relationship, and schema definitions for ebbjs: the registry,
validation, system entities, reserved names, and the collaborative-text cell
schemas a document entity declares. Pure values only — no storage, no
network, no client.

`@ebbjs/client` re-exports this package, so the client API is unchanged.

## Install

```bash
npm install @ebbjs/schema
```

Node `>=22.8.0`.

## Usage

```ts
import { defineEntity, defineRelationship, defineSchema, e, TextCellSchema } from "@ebbjs/schema";

const issue = defineEntity("issue", { title: e.string() });

const project = defineEntity("project", { name: e.string() });

const body = defineEntity(
  "text_document",
  { content: e.map(TextCellSchema), version: e.number() },
  { materialization: "on-demand" },
);

const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
const hasBody = defineRelationship({
  source: issue,
  target: body,
  as: "body",
  sourceCardinality: "one",
});

const schema = defineSchema({
  entities: { issue, project, text_document: body },
  relationships: { belongsTo, hasBody },
  version: 1,
});

schema._registry.get("issue");
```

An entity map key must equal the definition's own `name`; `defineSchema` throws
`EntityKeyMismatchError` otherwise, since the key is the name the app's
namespaces and permission strings are addressed by.

A field declares a read-time default with `.default(v)`; `create()` may then
omit it, and it reads as `T`. A field without one reads as `T | undefined`,
because any row can predate the declaration. A `null` filter value means "no
live value" (absent or cleared) — see the
[absence and defaults](https://ebbjs.com/docs/absence-and-defaults) page.

## Fields

`e` ships the builders below. A field's type flows to `EntityValues`, local
write validation, and `where` / `orderBy`.

| Builder          | Reads as                      | Notes                                           |
| ---------------- | ----------------------------- | ----------------------------------------------- |
| `e.string()`     | `string`                      |                                                 |
| `e.number()`     | `number`                      |                                                 |
| `e.integer()`    | `number`                      |                                                 |
| `e.boolean()`    | `boolean`                     |                                                 |
| `e.enum(values)` | the members' literal union    | closed set; a write outside it fails validation |
| `e.array(value)` | `Static<typeof value>[]`      |                                                 |
| `e.map(value)`   | `Record<string, Static<...>>` | entries merge key by key, not the whole field   |

### Enums

`e.enum([...])` declares a closed set of values:

```ts
const wall = defineEntity("wall", {
  kind: e.enum(["exterior", "interior", "railing"]).default("interior"),
});
```

`EntityValues<typeof wall>["kind"]` is `"exterior" | "interior" | "railing"`,
so a `switch` over it can be exhaustive. A write carrying a value outside the
set fails local validation the same way a wrong type does, and `.default()`
takes a member.

Strings are the app case. Numbers and booleans are accepted and validated as
literals; `orderBy` compares numbers numerically, everything else by locale,
and sorts an absent value last. Ordering follows the stored value, not the
order the members were declared in.

`where("kind", "interior")` narrows to the members on the field overload. The
open relationship-target overload means a non-member string still compiles —
the registry may be about to read it as a pointer — so the set is enforced on
write, not on filter: a filter only compares against stored values, and cannot
prove none outside the set was ever written.

## Anything else is TypeBox

`defineEntity` accepts any TypeBox schema as a field, so a shape `e` does not
cover is the schema itself:

```ts
import { Type } from "@sinclair/typebox";

const wall = defineEntity("wall", {
  kind: Type.Union([Type.Literal("exterior"), Type.Literal("interior"), Type.Literal("railing")]),
});
```

That is also the way to give a map a nested-object value, which `e.map` takes
as its value schema:

```ts
const plan = defineEntity("plan", {
  openings: e.map(
    Type.Object({
      kind: Type.Union([Type.Literal("door"), Type.Literal("window")]),
      width: Type.Number(),
    }),
  ),
});
```

The field rules still apply: a schema may not admit `null` (absence is the
only spelling), and a map field's entries merge key by key. A raw schema can
carry its own JSON Schema annotations, including `default`, the same way the
builders do.

## Module map

| Module                    | What it ships                                                          |
| ------------------------- | ---------------------------------------------------------------------- |
| `src/entity.ts`           | `defineEntity`, `e`, field markers, entity types.                      |
| `src/entity-registry.ts`  | `EntityRegistry`, `validatePayload`, `EntityValidationError`.          |
| `src/relationship.ts`     | `defineRelationship` and relationship types.                           |
| `src/schema.ts`           | `defineSchema`, schema errors.                                         |
| `src/system-entities.ts`  | `group`, `groupMember`, `entityGroup`, `relationship` system entities. |
| `src/reserved.ts`         | Reserved entity and membership names.                                  |
| `src/collaborative-text/` | Cell schemas, wire adapters, tree, and `TextDocument`.                 |
