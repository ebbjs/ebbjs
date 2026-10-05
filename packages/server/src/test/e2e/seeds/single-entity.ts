import type { SeedData } from "@ebbjs/server";

export function buildSingleEntitySeed(): SeedData {
  return {
    groups: [{ id: "grp_001", name: "Test Group" }],
    groupMembers: [
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
        type: "text_document",
        patches: [{ fields: {} }],
      },
    ],
    relationships: [],
    entityGroups: [
      {
        id: "eg_001",
        entityId: "ent_001",
        groupId: "grp_001",
      },
    ],
  };
}
