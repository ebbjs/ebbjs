# @ebbjs/schema

Model, component, relationship, and schema definitions for ebbjs: the registry,
validation, system models, reserved names, and the collaborative-text cell
schemas a document entity declares. Pure values only — no storage, no network,
no client.

`@ebbjs/client` re-exports this package, so the client API is unchanged.

## Install

```bash
npm install @ebbjs/schema
```

Node `>=22.8.0`.

## Usage

```ts
import { defineComponent, defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";

const body = defineComponent(
  "issue/body",
  { text: e.string() },
  { optional: true, loading: "lazy" },
);

const issue = defineModel("issue", {
  title: e.string(),
  body,
});

const project = defineModel("project", { name: e.string() });

const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });

const schema = defineSchema({
  models: { issue, project },
  relationships: { belongsTo },
  version: 1,
});

schema._registry.get("issue");
```

A bare field builder is an **anonymous component** named `<model>/<field>`.
`defineComponent` declares a named one when it needs its own policy. The
registry answers the component questions later layers ask:

```ts
const registry = schema._registry;
registry.componentsOf("issue"); // every component the model declares
registry.componentOf("issue", "issue/body"); // by full name, or by field key
registry.isOptional("issue", "body");
registry.loadingOf("issue", "body"); // "lazy"
registry.conflictScopeOf("issue", "body");
registry.permissionOf("issue", "body"); // "issue" unless the component opts in
```

A field declares a read-time default with `.default(v)`; `create()` may then
omit it, and it reads as `T`. A field without one reads as `T | undefined`,
because any row can predate the declaration. A `null` filter value means "no
live value" (absent or cleared) — see the
[absence and defaults](https://ebbjs.com/docs/absence-and-defaults) page.

## Fields

`e` ships the builders below. A field's type flows to `EntityValues`, local
write validation, and `where` / `orderBy`. A builder used directly in a model
is an anonymous component; a component declared with `defineComponent` wraps
one value schema or a field map.

| Builder            | Reads as                      | Notes                                           |
| ------------------ | ----------------------------- | ----------------------------------------------- |
| `e.string()`       | `string`                      |                                                 |
| `e.number()`       | `number`                      |                                                 |
| `e.integer()`      | `number`                      |                                                 |
| `e.boolean()`      | `boolean`                     |                                                 |
| `e.enum(values)`   | the members' literal union    | closed set; a write outside it fails validation |
| `e.array(value)`   | `Static<typeof value>[]`      |                                                 |
| `e.map(value)`     | `Record<string, Static<...>>` | entries merge key by key, not the whole field   |
| `e.object(fields)` | the nested shape              | closed properties; one atomic value             |

### Enums

`e.enum([...])` declares a closed set of values:

```ts
const wall = defineModel("wall", {
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

### Nested objects

`e.object({...})` declares a nested object as one atomic value. It is not a
key space: a write replaces the whole object, so the properties travel together
and cannot tear.

```ts
import { Type } from "@sinclair/typebox";

const wall = defineModel("wall", {
  anchor: e.object({ x: e.number(), y: e.number() }),
  opening: e.object({
    kind: e.enum(["door", "window"]),
    width: e.number(),
    height: Type.Optional(Type.Number()),
  }),
  frame: e.object({ from: e.integer(), to: e.integer() }).default({ from: 0, to: 0 }),
});
```

Properties are **closed**: an undeclared nested property fails local validation
with its path, rather than persisting. The nested shape flows through `Static`
unchanged, so a nested `e.enum` narrows to its literal union and a `switch`
over `opening.kind` stays exhaustive.

`e.object` declares its properties exactly as authored. The top-level field
still reads as `T | undefined` when it has no default — any row can predate the
declaration — but a **nested** property is required unless it is written as
`Type.Optional(...)`. A nested `.default()` is a JSON Schema annotation, part of
the schema hash and useful to tooling; it is not filled in at read time. Put the
default on the object field itself when absence has a value.

A map does not belong inside an object. `e.map` merges entries key by key, while
an object property is part of one value, so nesting a map would silently lose
its per-key merge; `e.object` refuses one at declaration time. Choose the
granularity instead: declare the map at the top level when keys are positions to
create and clear independently, or use `e.object` for a value that travels
together.

Queries compare an object field as a whole. `where("anchor", { x: 1, y: 2 })` is
a structural equality against the stored value, and `orderBy` refuses an object
field rather than sorting every row as the same string. Nested-path filters
(`where("anchor.x", 1)`) are not part of this builder.

## Anything else is TypeBox

`defineModel` accepts any TypeBox schema as a field, so a shape `e` does not
cover is the schema itself:

```ts
import { Type } from "@sinclair/typebox";

const wall = defineModel("wall", {
  kind: Type.Union([Type.Literal("exterior"), Type.Literal("interior"), Type.Literal("railing")]),
});
```

This is the escape hatch, not the recommendation for a nested value. A shape `e`
covers — a nested object of declared properties — is a builder (`e.object`),
which brings the closed-property rule, the null check, and the `.default()`
chain with it. Keep raw TypeBox for what no builder covers: an open object, a
tuple, a union of objects, or a property whose schema is only expressible
directly.

Raw TypeBox is also how a map gets a nested-object value, which `e.map` takes
as its value schema:

```ts
const plan = defineModel("plan", {
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

| Module                    | What it ships                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| `src/model.ts`            | `defineComponent`, `defineModel`, `e`, field markers, model types.   |
| `src/model-registry.ts`   | `ModelRegistry`, `validatePayload`, `EntityValidationError`.         |
| `src/relationship.ts`     | `defineRelationship` and relationship types.                         |
| `src/schema.ts`           | `defineSchema`, schema errors.                                       |
| `src/system-entities.ts`  | `group`, `groupMember`, `entityGroup`, `relationship` system models. |
| `src/reserved.ts`         | Reserved entity and membership names.                                |
| `src/collaborative-text/` | Cell schemas, wire adapters, tree, and `TextDocument`.               |
