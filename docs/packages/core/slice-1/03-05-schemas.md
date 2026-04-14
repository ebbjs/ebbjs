# Slice 1: Typebox Schemas

## Tasks 3–5: Domain Type Schemas

### Task 3: Implement NanoId and HLC Typebox schemas

**Files:** `packages/core/src/schemas/nanoid.ts` (create), `packages/core/src/schemas/hlc.ts` (create)

**Depends on:** Tasks 1, 2

**`src/schemas/nanoid.ts`:**

```typescript
import { Type } from "@sinclair/typebox";

// NanoId pattern: lowercase prefix + underscore + alphanumeric suffix
// Examples: "act_abc123", "todo_xyz", "upd_001"
export const NanoIdSchema = Type.String({
  pattern: "^[a-z]+_[a-zA-Z0-9]+$"
});

export type NanoId = string;
```

**`src/schemas/hlc.ts`:**

```typescript
import { Type } from "@sinclair/typebox";

// HLCTimestamp is a decimal string representation of a packed 64-bit bigint
// Server sends/receives as integer, client uses string internally
export const HLCTimestampSchema = Type.String();

export type HLCTimestamp = string;
```

---

### Task 4: Implement Action and Update Typebox schemas

**Files:** `packages/core/src/schemas/action.ts` (create)

**Depends on:** Task 3

Create schemas for all action-related types:

```typescript
import { Type, Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid.js";
import { HLCTimestampSchema } from "./hlc.js";

// SubjectType: entity types that can be updated
export type SubjectType = "todo" | "doc" | "group" | "groupMember" | "relationship";
export const SubjectTypeSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doc"),
  Type.Literal("group"),
  Type.Literal("groupMember"),
  Type.Literal("relationship")
]);

// UpdateMethod: operations supported on entities
export type UpdateMethod = "put" | "patch" | "delete";
export const UpdateMethodSchema = Type.Union([
  Type.Literal("put"),
  Type.Literal("patch"),
  Type.Literal("delete")
]);

// FieldValue: a single field's value with its source update ID
export const FieldValueSchema = Type.Object({
  value: Type.Unknown(),
  update_id: NanoIdSchema,
  hlc: Type.Optional(HLCTimestampSchema)  // Optional, for tiebreaking
});
export type FieldValue = Static<typeof FieldValueSchema>;

// UpdateData: payload for put/patch operations
export const PutDataSchema = Type.Object({
  fields: Type.Record(Type.String(), FieldValueSchema)
});

export const PatchDataSchema = Type.Object({
  fields: Type.Record(Type.String(), Type.Partial(FieldValueSchema))
});

// Update: a single modification within an Action
export const UpdateSchema = Type.Object({
  id: NanoIdSchema,
  subject_id: NanoIdSchema,
  subject_type: SubjectTypeSchema,
  method: UpdateMethodSchema,
  data: Type.Union([PutDataSchema, PatchDataSchema, Type.Null()])
});
export type Update = Static<typeof UpdateSchema>;

// Action: primary write unit sent to /sync/actions
export const ActionSchema = Type.Object({
  id: NanoIdSchema,
  actor_id: NanoIdSchema,
  hlc: HLCTimestampSchema,
  gsn: Type.Number(),
  updates: Type.Array(UpdateSchema)
});
export type Action = Static<typeof ActionSchema>;
```

---

### Task 5: Implement Entity and System Entity Typebox schemas

**Files:** `packages/core/src/schemas/entity.ts` (create), `packages/core/src/schemas/system.ts` (create), `packages/core/src/schemas/index.ts` (create)

**Depends on:** Task 4

**`src/schemas/entity.ts`:**

```typescript
import { Type, Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid.js";
import { HLCTimestampSchema } from "./hlc.js";
import { FieldValueSchema } from "./action.js";

// EntityData: container for regular entity fields
export const EntityDataSchema = Type.Object({
  fields: Type.Record(Type.String(), FieldValueSchema)
});

// Entity: materialized view of a subject
export const EntitySchema = Type.Object({
  id: NanoIdSchema,
  type: Type.String(),
  data: EntityDataSchema,
  created_hlc: HLCTimestampSchema,
  updated_hlc: HLCTimestampSchema,
  deleted_hlc: Type.Union([HLCTimestampSchema, Type.Null()]),
  last_gsn: Type.Number()
});
export type Entity = Static<typeof EntitySchema>;
```

**`src/schemas/system.ts`:**

```typescript
import { Type, Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid.js";
import { HLCTimestampSchema } from "./hlc.js";

// Group: system entity with flat data (no fields wrapper)
export const GroupSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("group"),
  data: Type.Object({
    name: Type.String()
  })
});
export type Group = Static<typeof GroupSchema>;

// GroupMember: flat data structure
export const GroupMemberSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("groupMember"),
  data: Type.Object({
    group_id: NanoIdSchema,
    actor_id: NanoIdSchema,
    permissions: Type.Array(Type.String())
  })
});
export type GroupMember = Static<typeof GroupMemberSchema>;

// Relationship: flat data structure
export const RelationshipSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("relationship"),
  data: Type.Object({
    source_id: NanoIdSchema,
    target_id: NanoIdSchema,
    relationship_type: Type.String()
  })
});
export type Relationship = Static<typeof RelationshipSchema>;
```

**`src/schemas/index.ts`:**

```typescript
// Re-export all schemas and derived types
export * from "./nanoid.js";
export * from "./hlc.js";
export * from "./action.js";
export * from "./entity.js";
export * from "./system.js";
```

---

## Acceptance Criteria

- [ ] `NanoIdSchema` validates pattern `^[a-z]+_[a-zA-Z0-9]+$`
- [ ] `HLCTimestampSchema` exists for string-based HLC values
- [ ] `ActionSchema` validates the full Action structure
- [ ] `UpdateSchema` validates Update with put/patch/delete methods
- [ ] `EntitySchema` validates Entity with fields wrapper
- [ ] `GroupSchema`, `GroupMemberSchema`, `RelationshipSchema` use flat data (no fields wrapper)
- [ ] All schemas are re-exported from `schemas/index.ts`
- [ ] TypeScript types are derived via `Static<>` from each schema