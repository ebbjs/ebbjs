import type { Update } from "@ebbjs/core";
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import {
  buildRelationshipUpdate,
  call,
  commit,
  createEntity,
  groupBootstrap,
  patchEntity,
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

/** Commit one operation under a receiving capability and return its Updates. */
const commitUpdates = async (
  registry: ReturnType<typeof buildRegistry>,
  calls: Parameters<typeof commit>[0],
): Promise<readonly Update[]> => {
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
  await commit(calls, capability);
  return submissions[0] ?? [];
};

const ids = (prefix: string) => {
  let next = 0;
  return {
    updateId: () => `${prefix}${++next}`,
    hlc: () => `${prefix}hlc-${next}`,
    newId: (kind: string) => `${prefix}${kind}-${++next}`,
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

  it("scopes a bootstrapped group to the app that created it", async () => {
    const registry = buildRegistry();
    const bootstrap = groupBootstrap(registry, "Team", undefined, "notes");

    const updates = await commitUpdates(registry, [bootstrap.call]);
    const group = updates.find((update) => update.subject_type === "group")!;

    expect(group.data!.fields!["apps"]).toEqual({
      map: { notes: { value: true, update_id: "u_1", hlc: "hlc-1" } },
    });
  });

  it("leaves a group unscoped without an app label", async () => {
    const registry = buildRegistry();
    const bootstrap = groupBootstrap(registry, "Team");

    const updates = await commitUpdates(registry, [bootstrap.call]);
    const group = updates.find((update) => update.subject_type === "group")!;

    expect(group.data!.fields!["apps"]).toBeUndefined();
  });

  it("writes a user entity's map field as a map envelope", async () => {
    const setting = defineEntity("setting", { name: e.string(), values: e.map(e.string()) });
    const registry = defineSchema({ entities: { setting }, version: 1 })._registry;

    const updates = await commitUpdates(registry, [
      call(createEntity, {
        entity: "setting",
        id: "s_1",
        fields: { name: "Theme", values: { theme: "dark" } },
        groups: ["g_1"],
      }),
    ]);

    expect(updates[0]!.data!.fields!["values"]).toEqual({
      map: { theme: { value: "dark", update_id: "u_1", hlc: "hlc-1" } },
    });
  });

  it("writes a scope patch as a map envelope so app keys merge independently", async () => {
    const registry = buildRegistry();

    const updates = await commitUpdates(registry, [
      call(patchEntity, {
        entity: "group",
        id: "g_1",
        payload: { apps: { issues: false } },
        groups: ["g_1"],
      }),
    ]);

    expect(updates[0]!.data!.fields!["apps"]).toEqual({
      map: { issues: { value: false, update_id: "u_1", hlc: "hlc-1" } },
    });
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
