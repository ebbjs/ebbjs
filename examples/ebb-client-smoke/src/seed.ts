/**
 * Test seed: bootstraps a group + member + entity so the smoke test can
 * exercise the read path of `@ebbjs/client`.
 *
 * Schema mirrors what `seed-client.buildSingleEntitySeed` produces but adds
 * a typed `title` field so the entity materializes with structured data.
 */

import type { SeedData } from "@ebbjs/server";

export const SMOKE_GROUP_ID = "grp_smoke";
export const SMOKE_MEMBER_ID = "gm_smoke";
export const SMOKE_RELATIONSHIP_ID = "rel_smoke";
export const SMOKE_ENTITY_ID = "ent_smoke";
export const SMOKE_ACTOR_ID = "actor_smoke";

export function buildSmokeSeed(): SeedData {
  return {
    groups: [{ id: SMOKE_GROUP_ID, name: "Smoke Group" }],
    groupMembers: [
      {
        id: SMOKE_MEMBER_ID,
        actorId: SMOKE_ACTOR_ID,
        groupId: SMOKE_GROUP_ID,
        permissions: ["read", "write"],
      },
    ],
    relationships: [
      {
        id: SMOKE_RELATIONSHIP_ID,
        sourceId: SMOKE_ENTITY_ID,
        targetId: SMOKE_GROUP_ID,
        type: "todo",
        field: "ownedBy",
      },
    ],
    entities: [
      {
        id: SMOKE_ENTITY_ID,
        type: "todo",
        patches: [
          {
            fields: {
              title: {
                value: "Hello, ebb",
                updateId: "seed_title",
                hlc: "0",
              },
            },
          },
        ],
      },
    ],
  };
}
