# Seed Client

> **Location:** the seed builder and rejection policy live in the
> browser-safe [`@ebbjs/core/seed`](../../../core/src/seed/index.ts) module, so
> browser demos (`client.seed()`) and this harness share one builder and one
> rejection-tolerance policy. [`src/seed-client.ts`](../../src/seed-client.ts) adds
> the raw-POST `seed()` and re-exports the core names (`buildSeedAction`, the
> `SeedData` types) with unchanged signatures.

## Purpose

Provides a programmatic way to seed the server with initial data over HTTP,
through the same action-write path real clients use. Seed data therefore goes
through the same validation, authorization, and persistence as a live write.

## Why seed via HTTP?

- The seed data goes through the server's permission check and writer.
- Any bug in the write path surfaces during seeding, not only in tests.
- No raw RocksDB writes — the server's own API is the interface.

## Public interface

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
  /** Ordered field patches; each field carries a plain value. */
  patches: Array<{
    fields: Record<string, unknown>;
  }>;
}

interface RelationshipSeed {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  field: string;
}

interface EntityGroupSeed {
  id: string;
  entityId: string;
  groupId: string;
}

interface SeedData {
  groups: GroupSeed[];
  groupMembers: GroupMemberSeed[];
  entities: EntitySeed[];
  relationships?: RelationshipSeed[];
  entityGroups?: EntityGroupSeed[];
  /** Reserved; the builder stamps HLCs per field and does not read this. */
  baseHlc?: number;
}

/** Build the one Action that carries the whole fixture, without doing HTTP. */
const buildSeedAction: (actorId: string, data: SeedData) => Action;

/** POST the fixture Action to `/sync/actions`. */
const seed: (baseUrl: string, actorId: string, data: SeedData) => Promise<void>;
```

`SyncClient.seed(data)` is the same builder submitted through the client's
public write path, so a browser app seeds with the client it already has.

## How seeding works

`buildSeedAction` emits **one Action** containing every row as an `Update`:
`group` and `groupMember` puts, one `put` per entity patch, `relationship`
puts, and `entityGroup` puts. Every plain field value is stamped into the
wire's per-field envelope (`update_id: "seed_update"` and a fresh HLC). The
acting `actorId` is the Action's actor, which is what the server's per-Action
authorization reads.

`seed()` sends that Action with `encodeSync` and a `POST` whose
`x-ebb-actor-id` header is the actor, then hands the response to
`assertSeedAccepted`. The rejection-tolerance policy is defined once:

- **Tolerated:** `already_exists`, `duplicate_action` — a re-seed of an existing
  fixture is a no-op. Current servers dedupe duplicate Actions and emit neither,
  but the policy is explicit so it is testable.
- **Fatal:** everything else (e.g. `not_authorized`) throws `SeedRejectedError`
  carrying the rejections.

## Dependencies

| Dependency         | What it needs                                                                |
| ------------------ | ---------------------------------------------------------------------------- |
| `@ebbjs/core/seed` | `buildSeedAction` / `assertSeedAccepted` / the `SeedData` and `Action` types |
| `@ebbjs/core`      | `encodeSync`                                                                 |
| `fetch`            | `POST` to the server's `/sync/actions`                                       |
