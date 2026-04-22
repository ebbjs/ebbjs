# Seed Client

## Purpose

Provides a programmatic way to seed the server with initial data via HTTP, using the same action-write code path that clients use. This ensures seeded data goes through the same validation, authorization, and persistence logic as real client actions.

## Why seed via HTTP?

Seeding via HTTP means:

- The seed data goes through `PermissionChecker.validate_and_authorize`
- The seed data goes through `Writer.write_actions`
- Any bugs in the write path are caught during seeding, not just during tests
- No need to write raw RocksDB data directly — the server's own API is the interface

## Public Interface

```typescript
interface GroupSeed {
  id: string;
  name: string;
}

interface GroupMemberSeed {
  id: string;
  actorId: string;
  groupId: string;
  permissions: string[];
}

interface EntitySeed {
  id: string;
  type: string;
  /** Array of patch field updates applied in order */
  patches: Array<{
    fields: Record<string, { value: unknown; hlc: string; updateId: string }>;
  }>;
}

interface SeedData {
  groups: GroupSeed[];
  groupMembers: GroupMemberSeed[];
  entities: EntitySeed[];
  /** Base HLC timestamp for all seed actions (default: 1_700_000_000_000_000) */
  baseHlc?: number;
}

/** Seed the server at baseUrl with the given data */
const seed = async (baseUrl: string, actorId: string, data: SeedData): Promise<void>;
```

## Factory Signature

```typescript
const createSeedClient = (httpFetch: typeof fetch): SeedClient => ({
  seed,
});
```

The interface accepts `typeof fetch` so it can be tested with mock fetch, and used with any fetch-compatible client (including `node-fetch` if needed).

## How seeding works

### Single action with multiple updates

The seed client builds **one action per entity** (or one action for all data), containing all updates needed:

```typescript
// One action for all seed data
const action = {
  id: "seed_action_001",
  actor_id: actorId,
  hlc: baseHlc,
  gsn: 1,
  updates: [
    // Group puts (one per group)
    ...groups.map((g) => ({
      id: `upd_grp_${g.id}`,
      subject_id: g.id,
      subject_type: "group",
      method: "put",
      data: { fields: { name: { value: g.name, update_id: `upd_grp_${g.id}`, hlc: baseHlc } } },
    })),
    // Group member puts
    ...groupMembers.map((gm) => ({
      id: `upd_gm_${gm.id}`,
      subject_id: gm.id,
      subject_type: "groupMember",
      method: "put",
      data: {
        fields: {
          actor_id: { value: gm.actorId, update_id: `upd_gm_${gm.id}`, hlc: baseHlc },
          group_id: { value: gm.groupId, update_id: `upd_gm_${gm.id}`, hlc: baseHlc },
          permissions: { value: gm.permissions, update_id: `upd_gm_${gm.id}`, hlc: baseHlc },
        },
      },
    })),
    // Entity puts (first patch establishing entity) + subsequent patches
    ...entities.flatMap((e) => buildEntityUpdates(e, baseHlc)),
  ],
};
```

### HTTP request

```typescript
const response = await fetch(`${baseUrl}/sync/actions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/msgpack",
    "x-ebb-actor-id": actorId,
  },
  body: Msgpax.pack({ actions: [action] }),
});
```

### Response handling

If the server returns `{ rejected: [...] }`, the seed client throws an error with the rejection details. Seed data should never be rejected (assuming correct format), but the check ensures seed failures are explicit.

## Seed data construction

### Entity patches

The `EntitySeed.patches` array defines field updates that are applied in order, simulating what a real application would do:

```typescript
const entitySeed: EntitySeed = {
  id: "ent_001",
  type: "todo",
  patches: [
    {
      // First patch: establishes entity with initial fields
      fields: {
        title: { value: "Test Todo", updateId: "upd_ent_001_1", hlc: "1700000000000001" },
      },
    },
    {
      // Second patch: updates/Adds more fields
      fields: {
        description: { value: "Description", updateId: "upd_ent_001_2", hlc: "1700000000000002" },
      },
    },
    {
      // Third patch: another field
      fields: {
        status: { value: "open", updateId: "upd_ent_001_3", hlc: "1700000000000003" },
      },
    },
  ],
};
```

The seed client generates `put` for the first patch (establishing the entity with `subject_type` from the entity type), then `patch` for subsequent patches.

## Dependencies

| Dependency    | What it needs                               | Reference         |
| ------------- | ------------------------------------------- | ----------------- |
| `@ebbjs/core` | `Action` type, `Msgpax` for msgpack packing | workspace package |
| `fetch`       | HTTP POST to server's `/sync/actions`       | built-in          |

## Open Questions

- Should `gsn` be auto-assigned by the server (omitted in the action), or explicitly set in seed?
- Should there be a `seedAndWaitForMaterialization()` helper that seeds then polls entity until it's readable?
- Should the seed client support a `clean()` method to wipe the data dir before re-seeding?
