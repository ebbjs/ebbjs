---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
"@ebbjs/write": minor
---

The four system types are now `ebb/*` components of one `ebb` model.

`group`, `groupMember`, `entityGroup` and `relationship` are `ebb/group`, `ebb/grant`,
`ebb/membership` and `ebb/link`: four **atomic** components, each carrying one object value in one
Update. A torn edge, membership or grant is unrepresentable.

```diff
-Update { component: "relationship/source_id", method: "patch", data: { value: "todo_1" } }
-Update { component: "relationship/target_id", method: "patch", data: { value: "todo_2" } }
-Update { component: "relationship/type",      method: "patch", data: { value: "todo" } }
-Update { component: "relationship/field",     method: "patch", data: { value: "dependsOn" } }
+Update { component: "ebb/link", method: "replace",
+         data: { value: { source_id: "todo_1", target_id: "todo_2",
+                          type: "todo", field: "dependsOn" } } }
```

`ebb/membership`'s pair, `ebb/link`'s source and `ebb/grant`'s group are fixed at create; moving one
is a delete plus a create.

Permission subjects are the component: `group.*` → `ebb/group.*`, `groupMember.*` → `ebb/grant.*`,
`relationship.update|delete` → `ebb/link.update|delete`. A membership write authorizes as the
entity's `<model>.create` / `.update`, unchanged.

A group's `apps` is the list of app ids it is in scope for (`["notes"]`) rather than a map, because
an atomic value cannot contain a map. Absent is unscoped, `[]` is no app, and a scope edit writes
the whole `ebb/group` value.

`@ebbjs/core` exports the component vocabulary — `EBB_COMPONENTS`, `systemValue` — and no longer
declares the `Group`, `GroupMember` and `Relationship` row schemas; the component values are the
shapes. `GroupSeed.apps` is a `string[]`.

The client's replica store moves to v13 and starts empty: its adjacency index keys name components,
and a stored row is one atomic value.
