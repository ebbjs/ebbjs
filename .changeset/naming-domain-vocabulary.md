---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
"@ebbjs/write": minor
---

One name per concept across the server and the client.

A row's committed model is `model`, not `type`, on the wire, in SQLite, in IndexedDB, in
the persisted replica record, and in `Entity`. `query(type)` is `query(model)`, `byType`
is `byModel`, `getDirtyForType` is `getDirtyForModel`, and the replica's `typeIndex` is
`modelIndex`. `type` now means one thing: a relationship's name.

The id → committed-model map is the model cache, not an index: `EntityTypeCache` is
`EntityModelCache`, `entity_types` is `entity_models`, `put_type`/`get_type` are
`put_model`/`get_model`. It is not the component existence index, which is unchanged.

The server's caches are named after the components they project: `EntityGroupCache` →
`MembershipCache`, `GroupCache` → `GrantCache`. The old model vocabulary is gone with
them — `entityGroupId` is `membershipRowId`, `LiveGroupMember` is `LiveGrant`,
`groupMembersOf` is `grantsOf`, the `last_group_member` refusal is `last_grant`, and the
seed types are `MembershipSeed` and `GrantSeed`. `ebbSystemEntity` is `ebbModel`;
`EntityIndex`, which resolves scope rather than indexing, is `EntityScope`; component
existence reads `carries?` rather than `present?`.

```diff
-const entity = await replica.get(id); entity.type;
+const entity = await replica.get(id); entity.model;
-EntityTypeCache.put_type(id, "todo");
+EntityModelCache.put_model(id, "todo");
-entityGroupId(id, groupId);
+membershipRowId(id, groupId);
```

Persisted shapes moved incompatibly, so each is discarded rather than migrated:
IndexedDB schema v15 renames the `entities` and `dirty` index and the `replica` key; the
SQLite read model moves to v3 (`entities.model`, `idx_entities_model`) and rebuilds from
the Action log; the replica record is format 5, now exported as
`REPLICA_RECORD_FORMAT`.
