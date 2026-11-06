---
title: "Absence, defaults, and null filters"
description: "How a field with no value reads, how a declared default fills it, and how a query asks for absence — without turning absence into a stored null."
---

Absence is the normal state of a field in Ebb. A row written before a field was
declared has no value for it, and that is correct: no assertion was made. This
page covers the two things you can declare about absence — a read-time default
and a query predicate — and the one spelling for asserting it yourself.

## A field's value

Projection returns `stored ?? default`.

| declaration                    | `create()` may omit | read type             |
| ------------------------------ | ------------------- | --------------------- |
| `e.string().default("normal")` | yes                 | `string`              |
| `e.string()`                   | no                  | `string \| undefined` |

`T | undefined` is the truth for a field without a default: any row can predate
the declaration. Declaring a default is the statement that absence has a value,
and that value is resolved when a row is read.

```ts
const task = defineEntity("task", {
  title: e.string(),
  priority: e.string().default("normal"),
});

const row = await client.task.query().first();
row?.title; // string | undefined — the row may predate the field
row?.priority; // string — always reads, because absence has a default
```

`create()` may omit exactly the fields that have a default. A field without one
must be provided.

### Defaults are read-time only

No write is submitted to fill a default, and the log keeps the difference
between _defaulted_ and _deliberately chosen_. A default change is a schema
change (it is part of `schema_hash`), but it never rewrites a row.

A cleared field is absent, not `null`. A tombstoned leaf projects to the field's
default when it has one, and to `undefined` when it does not. Ordering compares
a field as it reads, so a list sorted by `priority` never scatters rows whose
cell says "normal".

## Clearing a field

A field can be asserted absent. `unset` is the one spelling:

```ts
import { unset } from "@ebbjs/client";

update(todo, { dueDate: unset });
update(todo, { tags: { a: unset } }); // one map key
```

`unset` compiles to the wire's tombstone leaf (`{ value: null, update_id, hlc }`)
on the server. `null` in a payload is rejected with a message naming `unset`: a
payload asserts, and assertions about absence get a verb.

## Absence in a query

A filter is a **disjunction of groups**: keys within a group are ANDed, groups
are ORed. `where` adds to the current group; `or` starts a new one.

`null` is a predicate literal meaning **no live value**: the leaf is absent or
tombstoned. It is not a default, not a wildcard, and not an implicit widening.

```ts
client.task.query().where("priority", "normal"); // stored "normal" only
client.task.query().where("priority", null); // nobody set it
client.task.query().where("priority", "normal").or("priority", null); // reads as normal
```

`[]`, an omitted filter, or `null` for the whole filter is unfiltered. `[{}]` is
unfiltered too — an empty conjunction is true. A `null` _entry_ (`[null]`) is
malformed and rejected; `{ priority: null }` is a valid predicate.

The same shape travels to `POST /entities/query`. The builder's groups and the
wire filter are one predicate language.

### A default is not matched for you

Defaults never participate in filtering, so this mistake is easy to make:

```ts
client.task.query().where("priority", "normal");
```

Rows nobody set do **not** match, even though they render as "normal". Widening
the filter would make the same text mean different things under different
schemas and would put default knowledge in the query path. Instead,
`client.queryEntities` emits a non-fatal warning on the
`onRegistryViolation` channel when a filter compares a defaulted field but has
no `{ field: null }` term for it in any group. The query still runs.

To include unset rows, say so:

```ts
client.task.query().where("priority", "normal").or("priority", null);
```

A useful consequence: editing a default never changes a query's result set, only
what rows render as.
