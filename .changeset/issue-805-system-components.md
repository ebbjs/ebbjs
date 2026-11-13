---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
"@ebbjs/write": minor
---

The four system types become platform components on one `ebb` model.

`group`, `groupMember`, `entityGroup` and `relationship` are now `ebb/group`,
`ebb/grant`, `ebb/membership` and `ebb/link`: four **atomic** components of a single model
`ebb`, each carrying one object value (`{source_id, target_id, type, field}` for a link) in one
Update. A torn edge, membership or grant is unrepresentable, and `ebb/membership`'s pair,
`ebb/link`'s source and `ebb/grant`'s group are immutable after create — moving one is a delete
plus a create.

```diff
-Update { component: "relationship/source_id", method: "patch", data: { value: "todo_1" } }
-Update { component: "relationship/target_id", method: "patch", data: { value: "todo_2" } }
-Update { component: "relationship/type",      method: "patch", data: { value: "todo" } }
-Update { component: "relationship/field",     method: "patch", data: { value: "dependsOn" } }
+Update { component: "ebb/link", method: "replace",
+         data: { value: { source_id: "todo_1", target_id: "todo_2", type: "todo", field: "dependsOn" } } }
```

Permission subjects follow the component: a group write is `ebb/group.create`, a grant
`ebb/grant.*`, a membership `ebb/membership.*`, a link `ebb/link.*` — the four distinct grants
are preserved, and a grant list written for the old model names must be rewritten.

A group's `apps` is a list of app ids (`["notes"]`) rather than a map (`{notes: true}`): an
atomic value may not contain a map, because a nested map loses its per-key merge. Absent is still
unscoped (every app) and an empty list is still no app. A scope edit writes the whole `ebb/group`
value, so concurrent edits converge on one value rather than merging per app id.

`@ebbjs/core` drops the unused `GroupSchema`, `GroupMemberSchema` and `RelationshipSchema` row
types — the component values are the shapes now — and `GroupSeed.apps` is a `string[]`.

The client's replica record and its adjacency index keys move with the component names, so local
records and indexes are discarded at the new store version, not migrated.
