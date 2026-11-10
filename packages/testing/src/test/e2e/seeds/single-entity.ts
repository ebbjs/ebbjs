import type { SeedData } from "@ebbjs/testing";

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
        // A document row needs at least one component on the wire; the cell
        // map stays absent, which reads as an empty document.
        patches: [{ fields: { version: 1 } }],
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
