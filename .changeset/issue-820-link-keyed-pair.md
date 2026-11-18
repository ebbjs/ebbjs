---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
"@ebbjs/write": minor
---

An edge is a keyed component of its **source** row: `ebb/link` carries
`{ <field>: { <type>: { <targetId>: true } } }` instead of being a row of its own.

```diff
-Update { subject_id: "rel_9f3", component: "ebb/link", method: "replace",
-         data: { value: { source_id: "todo_1", target_id: "todo_2",
-                          type: "todo", field: "dependsOn" } } }
+Update { subject_id: "todo_1", component: "ebb/link", method: "merge",
+         data: { map: { dependsOn: { map: { todo: { map: { todo_2: { value: true } } } } } } } }
```

The edge's key is its whole identity — accessor, `type`, target — so two edges cannot share one, and
removing one edge is a `merge` whose value tombstones that key (`value: null`) rather than a row
delete. `drop` stays component-granular.

A link's group scope is its source row's membership by construction, so a source that moves takes its
edges with it and a peer that missed one obtains it by backfilling the source. There is no `rel_*`
id, and no mirrored `<source>/<as>` field.

`@ebbjs/client`: `setLinks({ replace })` refuses when the source row is not locally readable
rather than writing a partial set; `link` / `unlink` still write the key they name.

`@ebbjs/core` adds the value readers — `linkEdges`, `linkTargets`, `carriesLink`, `fieldComponent` —
and `RelationshipSeed` loses its `id`: an edge seeds as one merge on its source.
`systemValue`/`systemValueString` still answer for the three atomic platform components and answer
`null`/`false` for the keyed one.

`@ebbjs/write`: `buildRelationshipWrite` takes `sourceId` and an optional `currentTargets` (the live
set a `{ replace }` or a one-cardinality move diffs against) and returns the `ebb/link` Updates;
`buildRelationshipUpdate`, `buildManyEntityUpdate`, `collectManyTargetIds` and `relationshipSubjectId`
are deleted. `VerbResolution` is `{ groupsOf, targetsOf }` — `relationshipIdFor` and `fkTargetsOf`
are gone, because a target names the key an unlink removes. A many-cardinality `relate` is an add
unless `replace` is set; `replace` refuses when the live targets are unknown rather than writing a
partial set. `LinkWriteIds` is folded into `SystemRowIds`, and `linkEdgeUpdate` is no longer exported.

`@ebbjs/storage`: forward traversal is a component read, so `RelationshipLink` and
`queryByRelationshipSource` are deleted and the client's forward adjacency index with them;
`queryByRelationship` still answers the reverse direction. `DirtyTracker` gains `getDirty()` for the
reads that must materialize every dirty row. The IndexedDB read model moves to v17 and starts empty.

Only `link` is reserved on a user model, because `ebb/link` is the one platform overlay that shares
a row's field name; `group`, `grant` and `membership` are rows of their own under `ebb`, so
`defineModel` still accepts fields by those names. A link write authorizes as `ebb/link.<verb>` in
the source's group set, so `ebb.*` covers it and a model grant does not.

Server data is discarded: there is no migration and no dual shape.
