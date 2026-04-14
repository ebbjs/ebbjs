# Typebox Types

Define TypeScript types with Typebox schemas for runtime validation. Types map to Elixir structs in `ebb_server`.

## Tasks 3–5

### Task 3: NanoId and HLCTimestamp types

**Files:** `packages/core/src/types/nanoid.ts`, `packages/core/src/types/hlc.ts`

**Depends on:** Tasks 1, 2

**NanoId** — string identifier with type prefix and unique suffix. Pattern: `^[a-z]+_[a-zA-Z0-9]+$`. Examples: `"act_abc123"`, `"todo_xyz"`, `"upd_001"`.

**HLCTimestamp** — decimal string representation of a packed 64-bit HLC bigint. Server sends/receives as integer; client uses string internally.

---

### Task 4: Action and Update types

**Files:** `packages/core/src/types/action.ts`

**Depends on:** Task 3

**SubjectType** — union of entity types that can be updated: `"todo" | "doc" | "group" | "groupMember" | "relationship"`.

**UpdateMethod** — operations supported on entities: `"put" | "patch" | "delete"`.

**FieldValue** — a single field's value with its source update ID and optional HLC for tiebreaking.
```
{ value: unknown, update_id: NanoId, hlc?: HLCTimestamp }
```

**PutData** — payload for create/replace operations. Fields map field names to FieldValue.

**PatchData** — payload for merge operations. Only changed fields are included.

**Update** — a single modification within an Action.
```
{ id: NanoId, subject_id: NanoId, subject_type: SubjectType, method: UpdateMethod, data: PutData | PatchData | null }
```

**Action** — primary write unit sent to `/sync/actions`. Contains an HLC timestamp and a non-empty array of Updates.
```
{ id: NanoId, actor_id: NanoId, hlc: HLCTimestamp, gsn: number, updates: Update[] }
```

Maps to Elixir `EbbServerWeb.Action` struct.

---

### Task 5: Entity and System Entity types

**Files:** `packages/core/src/types/entity.ts`, `packages/core/src/types/group.ts`, `packages/core/src/types/group-member.ts`, `packages/core/src/types/relationship.ts`, `packages/core/src/types/index.ts`

**Depends on:** Task 4

**EntityData** — container for regular entity fields: `{ fields: Record<string, FieldValue> }`.

**Entity** — materialized view of a subject, built client-side by replaying Updates from storage.
```
{ id: NanoId, type: string, data: EntityData, created_hlc: HLCTimestamp, updated_hlc: HLCTimestamp, deleted_hlc: HLCTimestamp | null, last_gsn: number }
```

Maps to Elixir `EbbServer.Storage.Entity` struct.

**Group** — system entity with flat data (no fields wrapper).
```
{ id: NanoId, type: "group", data: { name: string } }
```

Maps to Elixir `EbbServer.Group` struct.

**GroupMember** — system entity linking a group to an actor with permissions.
```
{ id: NanoId, type: "groupMember", data: { group_id: NanoId, actor_id: NanoId, permissions: string[] } }
```

Maps to Elixir `EbbServer.GroupMember` struct.

**Relationship** — system entity linking two subjects.
```
{ id: NanoId, type: "relationship", data: { source_id: NanoId, target_id: NanoId, relationship_type: string } }
```

Maps to Elixir `EbbServer.Relationship` struct.

**Re-exports** — `types/index.ts` re-exports all types for single-entry access.

---

## Acceptance Criteria

- [ ] NanoId validates pattern `^[a-z]+_[a-zA-Z0-9]+$`
- [ ] HLCTimestamp is a string type for HLC values
- [ ] Action type has id, actor_id, hlc, gsn, updates fields
- [ ] Update type supports put/patch/delete methods with appropriate data shapes
- [ ] Entity type has fields wrapper for regular entities
- [ ] Group, GroupMember, Relationship use flat data (no fields wrapper)
- [ ] All types re-exported from `types/index.ts`
- [ ] TypeScript types derived via `Static<>` from Typebox schemas
- [ ] Each type maps to corresponding Elixir struct in ebb_server:
  - Action → `ebb_server/lib/ebb_server/storage/action_validator.ex` (`validated_action` type)
  - Update → `ebb_server/lib/ebb_server/storage/action_validator.ex` (`validated_update` type)
  - Entity → `ebb_server/lib/ebb_server/storage/sqlite.ex` (entity schema)
  - Group → `ebb_server/lib/ebb_server/storage/permission_helper.ex` (system entity types)
  - GroupMember → `ebb_server/lib/ebb_server/storage/group_cache.ex`
  - Relationship → `ebb_server/lib/ebb_server/storage/relationship_cache.ex`
  - HLC → `ebb_server/lib/ebb_server/storage/action_validator.ex` (`validate_hlc/2`)