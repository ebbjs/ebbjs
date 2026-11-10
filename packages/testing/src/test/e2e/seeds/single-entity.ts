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
        // A row with zero components cannot be created on the pinned wire
        // (every non-delete Update names a component), so the seed writes one
        // harmless component. The cell map stays absent, which reads as an
        // empty document. Restore `patches: []` when a wire create lands, not
        // before (#798).
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
