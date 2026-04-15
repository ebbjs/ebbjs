# Client-Side Relationship and Group Membership Queries

## Overview

On the server, relationships (`subject_type: "relationship"`) and group memberships (`subject_type: "groupMember"`) are first-class entities stored in RocksDB/SQLite. The server maintains separate caches (RelationshipCache, GroupCache) for efficient lookups.

On the client, we need similar query capabilities:
- "All todos in group X"
- "All entities related to entity Y"
- "All groups I'm a member of"
- "All members of group X"

## Data Model

### GroupMember Entity

When `subject_type` is `"groupMember"`, the entity represents actor-to-group membership:

```typescript
interface GroupMemberData {
  actor_id: string;       // The member (actor)
  group_id: string;       // The group
  permissions: string[];    // Permissions in this group
}
```

### Relationship Entity

When `subject_type` is `"relationship"`, the entity represents entity-to-entity (or entity-to-group) relationships:

```typescript
interface RelationshipData {
  source_id: string;   // The entity that "owns" the relationship
  target_id: string;   // The target (could be another entity or a group)
  type: string;        // Entity type of source (e.g., "todo", "document")
  field: string;       // Relationship field name (e.g., "group", "collaborators", "parent")
}
```

## Design Decisions

1. **Tracking**: Idempotent upsert - `upsert` always removes old first if exists, then adds new
2. **Patch handling**: Upsert handles this automatically - detects old and removes before adding new
3. **Delete handling**: Remove on `method === "delete"`, and on upsert if `deleted_hlc !== null`
4. **Permission filtering**: No - client only stores entities the server says it can read
5. **Type shape**: Simple extension with `type` discriminant

## Type Definitions

```typescript
// types/group-member.ts
import type { Entity } from "@ebbjs/core";

// GroupMember is an Entity with type: "groupMember"
export interface GroupMember extends Entity {
  type: "groupMember";
}

// types/relationship.ts
export interface Relationship extends Entity {
  type: "relationship";
}
```

## GroupStore Interface

```typescript
// types/group-store.ts
import type { GroupMember } from "./group-member";

export interface GroupStore {
  // Get all group IDs an actor is a member of
  getMyGroups(actorId: string): Promise<readonly string[]>;
  
  // Get all members of a group
  getGroupMembers(groupId: string): Promise<readonly GroupMember[]>;
  
  // Get my permissions in a group
  getMyPermissions(actorId: string, groupId: string): Promise<readonly string[]>;
  
  // Idempotent upsert - removes old first if exists
  upsert(member: GroupMember): Promise<void>;
  
  // Remove membership
  remove(memberId: string): Promise<void>;
  
  clear(): Promise<void>;
}
```

### GroupStore Memory Implementation

```typescript
// memory/group-store.memory.ts

interface GroupStoreState {
  // actorId -> Set<groupId>
  actorToGroups: Map<string, Set<string>>;
  
  // groupId -> Set<memberId>
  groupToMembers: Map<string, Set<string>>;
  
  // memberId -> GroupMember (full entity)
  members: Map<string, GroupMember>;
}

export const createMemoryGroupStore = (): GroupStore => {
  let state: GroupStoreState = {
    actorToGroups: new Map(),
    groupToMembers: new Map(),
    members: new Map(),  // memberId -> GroupMember (full entity)
  };

  return {
    async getMyGroups(actorId: string): Promise<readonly string[]> {
      return state.actorToGroups.get(actorId)?.size 
        ? Array.from(state.actorToGroups.get(actorId)!) 
        : [];
    },

    async getGroupMembers(groupId: string): Promise<readonly GroupMember[]> {
      const memberIds = state.groupToMembers.get(groupId);
      if (!memberIds) return [];
      
      return Array.from(memberIds)
        .map(id => state.members.get(id))
        .filter((m): m is GroupMember => m !== undefined);
    },

    async getMyPermissions(actorId: string, groupId: string): Promise<readonly string[]> {
      const memberIds = state.groupToMembers.get(groupId);
      if (!memberIds) return [];
      
      for (const memberId of memberIds) {
        const member = state.members.get(memberId);
        if (member?.data.fields.actor_id.value === actorId) {
          return member.data.fields.permissions.value;
        }
      }
      return [];
    },

    async upsert(member: GroupMember): Promise<void> {
      // If soft-deleted, remove from indexes
      if (member.deleted_hlc !== null) {
        await this.remove(member.id);
        return;
      }

      const actorId = member.data.fields.actor_id.value;
      const groupId = member.data.fields.group_id.value;
      const memberId = member.id;

      // Remove old if exists (idempotent)
      await this.remove(memberId);

      // Add new
      // actor -> group
      const actorGroups = state.actorToGroups.get(actorId) ?? new Set();
      actorGroups.add(groupId);
      state.actorToGroups.set(actorId, actorGroups);

      // group -> member
      const groupMembers = state.groupToMembers.get(groupId) ?? new Set();
      groupMembers.add(memberId);
      state.groupToMembers.set(groupId, groupMembers);

      // store full entity
      state.members.set(memberId, member);
    },

    async remove(memberId: string): Promise<void> {
      const member = state.members.get(memberId);
      if (!member) return;

      const actorId = member.data.fields.actor_id.value;
      const groupId = member.data.fields.group_id.value;

      state.actorToGroups.get(actorId)?.delete(groupId);
      state.groupToMembers.get(groupId)?.delete(memberId);
      state.members.delete(memberId);
    },

    async clear(): Promise<void> {
      state = {
        actorToGroups: new Map(),
        groupToMembers: new Map(),
        members: new Map(),
      };
    },
  };
};
```

## RelationshipStore Interface

```typescript
// types/relationship-store.ts
import type { Relationship } from "./relationship";

export interface RelationshipStore {
  // Get all relationships where entity is the source (what entity references)
  getReferences(sourceId: string): Promise<readonly Relationship[]>;
  
  // Get all relationships where entity is the target (what references entity)
  getReferencedBy(targetId: string): Promise<readonly Relationship[]>;
  
  // Get relationships from entity for a specific field
  getReferencesByField(sourceId: string, field: string): Promise<readonly Relationship[]>;
  
  // Get entity IDs of type that reference target (e.g., all todos in group X)
  getEntityIdsByTarget(targetId: string, type?: string): Promise<readonly string[]>;
  
  // Idempotent upsert - removes old first if exists
  upsert(relationship: Relationship): Promise<void>;
  
  // Remove relationship
  remove(relationshipId: string): Promise<void>;
  
  clear(): Promise<void>;
}
```

### RelationshipStore Memory Implementation

```typescript
// memory/relationship-store.memory.ts

interface RelationshipStoreState {
  // sourceId -> Relationship[]
  references: Map<string, Relationship[]>;
  
  // targetId -> Relationship[]
  referencedBy: Map<string, Relationship[]>;
  
  // relationshipId -> Relationship (for lookup on upsert)
  byId: Map<string, Relationship>;
}

export const createMemoryRelationshipStore = (): RelationshipStore => {
  let state: RelationshipStoreState = {
    references: new Map(),
    referencedBy: new Map(),
    byId: new Map(),
  };

  const removeFromIndexes = (rel: Relationship): void => {
    const sourceId = rel.data.fields.source_id.value;
    const targetId = rel.data.fields.target_id.value;

    // Remove from source refs
    const sourceRefs = state.references.get(sourceId) ?? [];
    state.references.set(sourceId, sourceRefs.filter(r => r.id !== rel.id));

    // Remove from target refs
    const targetRefs = state.referencedBy.get(targetId) ?? [];
    state.referencedBy.set(targetId, targetRefs.filter(r => r.id !== rel.id));
  };

  return {
    async getReferences(sourceId: string): Promise<readonly Relationship[]> {
      return state.references.get(sourceId) ?? [];
    },

    async getReferencedBy(targetId: string): Promise<readonly Relationship[]> {
      return state.referencedBy.get(targetId) ?? [];
    },

    async getReferencesByField(sourceId: string, field: string): Promise<readonly Relationship[]> {
      const refs = state.references.get(sourceId) ?? [];
      return refs.filter(r => r.data.fields.field.value === field);
    },

    async getEntityIdsByTarget(targetId: string, type?: string): Promise<readonly string[]> {
      const refs = state.referencedBy.get(targetId) ?? [];
      const filtered = type ? refs.filter(r => r.data.fields.type.value === type) : refs;
      return [...new Set(filtered.map(r => r.data.fields.source_id.value))];
    },

    async upsert(relationship: Relationship): Promise<void> {
      // If soft-deleted, remove from indexes
      if (relationship.deleted_hlc !== null) {
        await this.remove(relationship.id);
        return;
      }

      const old = state.byId.get(relationship.id);
      
      // If updating existing, remove old indexes first
      if (old) {
        removeFromIndexes(old);
      }

      // Add new to indexes
      const sourceId = relationship.data.fields.source_id.value;
      const targetId = relationship.data.fields.target_id.value;

      // source -> relationship
      const sourceRefs = state.references.get(sourceId) ?? [];
      sourceRefs.push(relationship);
      state.references.set(sourceId, sourceRefs);

      // target -> relationship
      const targetRefs = state.referencedBy.get(targetId) ?? [];
      targetRefs.push(relationship);
      state.referencedBy.set(targetId, targetRefs);

      // byId lookup
      state.byId.set(relationship.id, relationship);
    },

    async remove(relationshipId: string): Promise<void> {
      const relationship = state.byId.get(relationshipId);
      if (!relationship) return;

      removeFromIndexes(relationship);
      state.byId.delete(relationshipId);
    },

    async clear(): Promise<void> {
      state = {
        references: new Map(),
        referencedBy: new Map(),
        byId: new Map(),
      };
    },
  };
};
```

## StorageAdapter Integration

```typescript
// types/storage-adapter.ts (updated)

import type { ActionLog } from "./action-log";
import type { DirtyTracker } from "./dirty-tracker";
import type { EntityStore } from "./entity-store";
import type { CursorStore } from "./cursor-store";
import type { GroupStore } from "./group-store";
import type { RelationshipStore } from "./relationship-store";
import type { GroupMember } from "./group-member";
import type { Relationship } from "./relationship";

export interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;
  readonly groupStore: GroupStore;
  readonly relationshipStore: RelationshipStore;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;

  // Convenience queries
  getEntityIdsByGroup(groupId: string, type?: string): Promise<readonly string[]>;
  getGroupMembers(groupId: string): Promise<readonly GroupMember[]>;
  getMyGroups(actorId: string): Promise<readonly string[]>;
}
```

## Materialization Integration

When actions are received and processed, relationship and membership tracking is updated. This happens in the sync handler that processes incoming actions:

```typescript
// In sync handler that processes incoming actions:
async function processAction(action: Action): Promise<void> {
  // Store action
  await storage.actions.append(action);
  
  // Update relationship/membership indexes based on this action
  for (const update of action.updates) {
    if (update.subject_type === "relationship") {
      if (update.method === "delete") {
        storage.relationshipStore.remove(update.subject_id);
      } else {
        // put or patch - upsert
        const rel = await storage.entities.get(update.subject_id);
        if (rel) storage.relationshipStore.upsert(rel);
      }
    }
    
    if (update.subject_type === "groupMember") {
      if (update.method === "delete") {
        storage.groupStore.remove(update.subject_id);
      } else {
        // put or patch - upsert
        const member = await storage.entities.get(update.subject_id);
        if (member) storage.groupStore.upsert(member);
      }
    }
  }
}
```

**Note**: The client receives actions already filtered by the server - it only stores entities it has access to.

## File Structure (Updated)

```
packages/storage/src/
├── types/
│   ├── action-log.ts
│   ├── dirty-tracker.ts
│   ├── entity-store.ts
│   ├── cursor-store.ts
│   ├── storage-adapter.ts
│   ├── group-store.ts
│   ├── relationship-store.ts
│   ├── group-member.ts        # Type definition
│   └── relationship.ts        # Type definition
├── memory/
│   ├── action-log.memory.ts
│   ├── dirty-tracker.memory.ts
│   ├── entity-store.memory.ts
│   ├── cursor-store.memory.ts
│   ├── group-store.memory.ts
│   ├── relationship-store.memory.ts
│   ├── memory-adapter.ts
│   └── *.test.ts
├── sqlite/                    # Future
├── indexeddb/                 # Future
└── index.ts
```

## Usage Examples

```typescript
// Get all todos in group "group_1"
const todoIds = await storage.getEntityIdsByGroup("group_1", "todo");

// Get all groups actor "user_1" is a member of
const groups = await storage.getMyGroups("user_1");

// Get all members of group "group_1"
const members = await storage.getGroupMembers("group_1");

// Get all entities that reference entity "doc_1"
const relationships = await storage.relationshipStore.getReferencedBy("doc_1");

// Get all collaborators on a document
const collabIds = await storage.relationshipStore.getEntityIdsByTarget("doc_1", "actor");
```

## Test Cases

```typescript
// memory/group-store.memory.test.ts

import { describe, it, expect } from "vitest";
import { createMemoryGroupStore } from "./group-store.memory";

describe("MemoryGroupStore", () => {
  const makeMember = (id: string, actorId: string, groupId: string, permissions: string[] = []): GroupMember => ({
    id,
    type: "groupMember",
    data: {
      fields: {
        actor_id: { value: actorId, update_id: "" },
        group_id: { value: groupId, update_id: "" },
        permissions: { value: permissions, update_id: "" },
      },
    },
    created_hlc: "",
    updated_hlc: "",
    deleted_hlc: null,
    last_gsn: 0,
  });

  describe("upsert", () => {
    it("tracks membership", async () => {
      const store = createMemoryGroupStore();
      await store.upsert(makeMember("gm_1", "actor_1", "group_1", ["read"]));
      
      expect(await store.getMyGroups("actor_1")).toEqual(["group_1"]);
      expect(await store.getGroupMembers("group_1")).toHaveLength(1);
    });

    it("is idempotent - updating replaces old", async () => {
      const store = createMemoryGroupStore();
      
      await store.upsert(makeMember("gm_1", "actor_1", "group_1", ["read"]));
      await store.upsert(makeMember("gm_1", "actor_1", "group_2", ["write"]));
      
      expect(await store.getMyGroups("actor_1")).toEqual(["group_2"]);
      expect(await store.getGroupMembers("group_1")).toHaveLength(0);
      expect(await store.getGroupMembers("group_2")).toHaveLength(1);
    });

    it("removes on soft-delete", async () => {
      const store = createMemoryGroupStore();
      await store.upsert(makeMember("gm_1", "actor_1", "group_1", ["read"]));
      
      const deleted: GroupMember = { ...makeMember("gm_1", "actor_1", "group_1"), deleted_hlc: "123" };
      await store.upsert(deleted);
      
      expect(await store.getMyGroups("actor_1")).toEqual([]);
      expect(await store.getGroupMembers("group_1")).toHaveLength(0);
    });
  });

  describe("remove", () => {
    it("removes membership", async () => {
      const store = createMemoryGroupStore();
      await store.upsert(makeMember("gm_1", "actor_1", "group_1"));
      await store.remove("gm_1");
      
      expect(await store.getMyGroups("actor_1")).toEqual([]);
    });
  });

  describe("getMyPermissions", () => {
    it("returns permissions for actor in group", async () => {
      const store = createMemoryGroupStore();
      await store.upsert(makeMember("gm_1", "actor_1", "group_1", ["read", "write"]));
      
      expect(await store.getMyPermissions("actor_1", "group_1")).toEqual(["read", "write"]);
    });

    it("returns empty for unknown group", async () => {
      const store = createMemoryGroupStore();
      expect(await store.getMyPermissions("actor_1", "unknown")).toEqual([]);
    });
  });
});
```

```typescript
// memory/relationship-store.memory.test.ts

import { describe, it, expect } from "vitest";
import { createMemoryRelationshipStore } from "./relationship-store.memory";

describe("MemoryRelationshipStore", () => {
  const makeRel = (id: string, sourceId: string, targetId: string, type: string, field: string): Relationship => ({
    id,
    type: "relationship",
    data: {
      fields: {
        source_id: { value: sourceId, update_id: "" },
        target_id: { value: targetId, update_id: "" },
        type: { value: type, update_id: "" },
        field: { value: field, update_id: "" },
      },
    },
    created_hlc: "",
    updated_hlc: "",
    deleted_hlc: null,
    last_gsn: 0,
  });

  describe("upsert", () => {
    it("tracks relationship", async () => {
      const store = createMemoryRelationshipStore();
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      
      expect(await store.getReferences("todo_1")).toHaveLength(1);
      expect(await store.getReferencedBy("group_1")).toHaveLength(1);
    });

    it("is idempotent - updating changes target", async () => {
      const store = createMemoryRelationshipStore();
      
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      await store.upsert(makeRel("rel_1", "todo_1", "group_2", "todo", "group"));
      
      expect(await store.getReferencedBy("group_1")).toHaveLength(0);
      expect(await store.getReferencedBy("group_2")).toHaveLength(1);
    });

    it("removes on soft-delete", async () => {
      const store = createMemoryRelationshipStore();
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      
      const deleted: Relationship = { ...makeRel("rel_1", "todo_1", "group_1", "todo", "group"), deleted_hlc: "123" };
      await store.upsert(deleted);
      
      expect(await store.getReferences("todo_1")).toHaveLength(0);
    });
  });

  describe("getEntityIdsByTarget", () => {
    it("returns entity IDs by target", async () => {
      const store = createMemoryRelationshipStore();
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      await store.upsert(makeRel("rel_2", "todo_2", "group_1", "todo", "group"));
      
      const ids = await store.getEntityIdsByTarget("group_1");
      expect(ids).toContain("todo_1");
      expect(ids).toContain("todo_2");
    });

    it("filters by type", async () => {
      const store = createMemoryRelationshipStore();
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      await store.upsert(makeRel("rel_2", "doc_1", "group_1", "document", "group"));
      
      const ids = await store.getEntityIdsByTarget("group_1", "todo");
      expect(ids).toEqual(["todo_1"]);
    });
  });

  describe("remove", () => {
    it("removes relationship", async () => {
      const store = createMemoryRelationshipStore();
      await store.upsert(makeRel("rel_1", "todo_1", "group_1", "todo", "group"));
      await store.remove("rel_1");
      
      expect(await store.getReferences("todo_1")).toHaveLength(0);
    });
  });
});
```