---
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
---

Clear a field with `unset`, not `null`.

```ts
update(todo, { dueDate: unset });
update(todo, { tags: { a: unset } }); // one map key
```

`unset` is a frozen singleton recognised by `isUnset`, exported from
`@ebbjs/core` and re-exported from `@ebbjs/write` and `@ebbjs/client`. The
draft and committed update payload types accept it per field (and per map key);
`wrapFields` compiles it to the existing tombstone envelope
(`{ value: null, update_id, hlc }`), so the merge rule, the merge vectors, and
the Elixir side are unchanged. `validatePayload` skips the marker — it is not a
value — and rejects a literal `null` in a payload with a message naming
`unset`. A literal `null` still passes through `wrapFields`, because tombstones
arrive from other producers; rejecting it belongs at validation, where the
intent is knowable. A `null` filter value keeps meaning "no live value".
