import type { SeedData } from "@ebbjs/testing";

export function buildSingleEntitySeed(): SeedData {
  return {
    groups: [{ id: "grp_001", name: "Test Group" }],
    grants: [
      {
        id: "gm_001",
        actorId: "actor_test",
        groupId: "grp_001",
        permissions: ["text_document.*", "read", "write"],
      },
    ],
    entities: [
      {
        id: "ent_001",
        model: "text_document",
        patches: [],
      },
    ],
    relationships: [],
    memberships: [
      {
        id: "eg_001",
        entityId: "ent_001",
        groupId: "grp_001",
      },
    ],
  };
}
