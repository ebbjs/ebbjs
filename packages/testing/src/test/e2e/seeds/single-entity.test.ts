/**
 * Unit tests for the e2e suite's single-entity fixture: the seed and the ids a
 * test asserts on come out of one builder, so overriding either moves both.
 */

import { describe, expect, it } from "vitest";

import { buildSingleEntitySeed } from "./single-entity";

describe("buildSingleEntitySeed", () => {
  it("defaults to one group, one granted actor, and one zero-component row", () => {
    const { seed, groupId, actorId, entityId, model } = buildSingleEntitySeed();

    expect({ groupId, actorId, entityId, model }).toEqual({
      groupId: "grp_001",
      actorId: "actor_test",
      entityId: "ent_001",
      model: "text_document",
    });
    expect(seed.groups).toEqual([{ id: groupId, name: "Test Group" }]);
    expect(seed.grants).toEqual([
      {
        id: `gm_${actorId}`,
        actorId,
        groupId,
        permissions: [`${model}.*`, "read", "write"],
      },
    ]);
    expect(seed.entities).toEqual([{ id: entityId, model, patches: [] }]);
    expect(seed.memberships).toEqual([{ id: `eg_${entityId}`, entityId, groupId }]);
    expect(seed.relationships).toEqual([]);
  });

  it("moves the grant, the row, and the membership with the overridden ids", () => {
    const { seed, groupId, actorId, entityId, model } = buildSingleEntitySeed({
      groups: [{ id: "grp_other", name: "Other" }],
      actorId: "actor_other",
      entityId: "todo_1",
      model: "todo",
    });

    expect(groupId).toBe("grp_other");
    expect(seed.groups).toEqual([{ id: "grp_other", name: "Other" }]);
    expect(seed.grants[0]).toMatchObject({
      actorId,
      groupId,
      permissions: ["todo.*", "read", "write"],
    });
    expect(seed.entities[0]).toEqual({ id: entityId, model, patches: [] });
    expect(seed.memberships[0]).toEqual({ id: `eg_${entityId}`, entityId, groupId });
  });
});
