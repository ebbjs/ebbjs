import type { SeedData } from "@ebbjs/server";

export function buildSingleEntitySeed(): SeedData {
  return {
    groups: [{ id: "grp_001", name: "Test Group" }],
    groupMembers: [
      {
        id: "gm_001",
        actorId: "actor_test",
        groupId: "grp_001",
        permissions: ["read", "write"],
      },
    ],
    relationships: [
      {
        id: "rel_001",
        sourceId: "ent_001",
        targetId: "grp_001",
        type: "todo",
        field: "ownedBy",
      },
    ],
  };
}
