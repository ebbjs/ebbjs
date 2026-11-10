---
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
---

Add `e.object(fields)` — a nested object as one atomic component value.

`e.object` is a closed object (`additionalProperties: false`) behind the same
`.default()` chain as every other builder, and a write carries it as one LWW
leaf (`{ value: {...} }`), so two concurrent whole-object writes converge on
one authored value rather than a synthesized one. Nested properties are
declared exactly as authored (`Type.Optional(...)` is how one is optional), and
a map nested inside an object is refused at declaration because it would lose
its per-key merge.

Definition and validation now agree on nested shapes: `admitsNull` recurses
into object properties and array items, and a nested `unset` (inside an object
or an array item) is refused once, with its path and a pointer at `e.map`,
instead of being stripped into a shape error. `wrapFields` throws rather than
sending the sentinel or an empty object.

A query compares an object or array field value structurally, so
`where("anchor", { x: 1, y: 2 })` matches the stored value regardless of key
order. Ordering is scalar-only: `orderBy` refuses an object or array field at
the type level and at runtime instead of tying every row on `[object Object]`.
