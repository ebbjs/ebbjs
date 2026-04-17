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
    entities: [
      {
        id: "ent_001",
        type: "todo",
        patches: [
          {
            fields: {
              title: { value: "Test Todo", hlc: "1700000000000001", updateId: "upd_ent_001_1" },
            },
          },
          {
            fields: {
              description: {
                value: "A description",
                hlc: "1700000000000002",
                updateId: "upd_ent_001_2",
              },
            },
          },
          {
            fields: {
              status: { value: "open", hlc: "1700000000000003", updateId: "upd_ent_001_3" },
            },
          },
        ],
      },
    ],
  };
}
