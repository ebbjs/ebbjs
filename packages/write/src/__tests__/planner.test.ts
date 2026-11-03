import type { Update } from "@ebbjs/core";
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import {
  buildRelationshipUpdate,
  call,
  commit,
  createEntity,
  writeRelationship,
  type CommitCapability,
  type OpContext,
} from "../index";

const buildRegistry = () => {
  const project = defineEntity("project", { name: e.string() });
  const issue = defineEntity("issue", { title: e.string(), project: e.string().nullable() });
  const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
  return defineSchema({
    entities: { project, issue },
    relationships: { belongsTo },
    version: 1,
  })._registry;
};

const ids = (prefix: string) => {
  let next = 0;
  return {
    updateId: () => `${prefix}${++next}`,
    hlc: () => `${prefix}hlc-${next}`,
  };
};

describe("@ebbjs/write", () => {
  it("runs a batch and submits its flattened Updates as one Action", async () => {
    const registry = buildRegistry();
    const submissions: (readonly Update[])[] = [];
    const capability: CommitCapability = {
      registry,
      actorId: "a_actor",
      freshHlc: () => "hlc-1",
      generateUpdateId: () => "u_1",
      submitRelationshipUpdates: async (updates) => {
        submissions.push(updates);
        return { rejected: [] };
      },
    };

    const result = await commit(
      [
        call(createEntity, {
          entity: "issue",
          id: "e_issue",
          fields: { title: "Hello" },
          groups: ["g_project"],
        }),
      ],
      capability,
    );

    expect(result.response.rejected).toEqual([]);
    expect(result.groups).toEqual(["g_project"]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.map((update) => update.subject_type)).toEqual(["issue", "entityGroup"]);
  });

  it("builds a relationship delete when the target is null", () => {
    const update = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "e_issue",
      targetId: null,
      field: "project",
      type: "project",
      updateId: "u_1",
    });

    expect(update).toMatchObject({
      id: "u_1",
      subject_id: "rel_1",
      subject_type: "relationship",
      method: "delete",
      data: null,
    });
  });

  it("keeps a relationship write pure under a shared OpContext", () => {
    const registry = buildRegistry();
    const ctx: OpContext = { registry, ids: ids("u_"), actorId: "a_actor" };

    const result = writeRelationship(ctx, {
      entity: "issue",
      sourceId: "e_issue",
      as: "project",
      pointer: { targetId: "e_project" },
      groups: ["g_project"],
    });

    expect(result.groups).toEqual(["g_project"]);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.subject_type).toBe("relationship");
  });
});
