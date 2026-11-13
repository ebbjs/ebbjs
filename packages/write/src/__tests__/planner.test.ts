import type { Update } from "@ebbjs/core";
import {
  EntityValidationError,
  defineModel,
  defineRelationship,
  defineSchema,
  e,
} from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import {
  buildRelationshipUpdate,
  call,
  commit,
  createEntity,
  dropEntity,
  groupBootstrap,
  operationCallFor,
  patchEntity,
  writeRelationship,
  type CommitCapability,
  type OpContext,
} from "../index";

const buildRegistry = () => {
  const project = defineModel("project", { name: e.string() });
  const issue = defineModel("issue", { title: e.string(), project: e.string().default("") });
  const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
  return defineSchema({
    models: { project, issue },
    relationships: { belongsTo },
    version: 1,
  })._registry;
};

/** A capability whose ids are unique per Update. */
const buildCapability = (
  registry: ReturnType<typeof buildRegistry>,
  submissions: (readonly Update[])[],
): CommitCapability => {
  let next = 0;
  return {
    registry,
    actorId: "a_actor",
    freshHlc: () => "hlc-1",
    generateUpdateId: () => `u_${++next}`,
    submitRelationshipUpdates: async (updates) => {
      submissions.push(updates);
      return { rejected: [] };
    },
  };
};

/** Commit one operation under a receiving capability and return its Updates. */
const commitUpdates = async (
  registry: ReturnType<typeof buildRegistry>,
  calls: Parameters<typeof commit>[0],
): Promise<readonly Update[]> => {
  const submissions: (readonly Update[])[] = [];
  await commit(calls, buildCapability(registry, submissions));
  return submissions[0] ?? [];
};

/** The one Update carrying `component`. */
const componentOf = (updates: readonly Update[], component: string): Update => {
  const update = updates.find(
    (candidate) => candidate.method !== "delete" && candidate.component === component,
  );
  if (update === undefined) throw new Error(`no update for component "${component}"`);
  return update;
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
  it("runs a batch and submits its flattened component Updates as one Action", async () => {
    const registry = buildRegistry();
    const submissions: (readonly Update[])[] = [];

    const result = await commit(
      [
        call(createEntity, {
          entity: "issue",
          id: "e_issue",
          fields: { title: "Hello" },
          groups: ["g_project"],
        }),
      ],
      buildCapability(registry, submissions),
    );

    expect(result.response.rejected).toEqual([]);
    expect(result.groups).toEqual(["g_project"]);
    expect(submissions).toHaveLength(1);
    expect(
      submissions[0]?.map((update) => (update.method === "delete" ? null : update.component)),
    ).toEqual(["issue/title", "ebb/membership"]);
  });

  it("scopes a bootstrapped group to the app that created it", async () => {
    const registry = buildRegistry();
    const bootstrap = groupBootstrap(registry, "Team", undefined, "notes");

    const updates = await commitUpdates(registry, [bootstrap.call]);
    const group = componentOf(updates, "ebb/group");

    expect(group).toMatchObject({ method: "replace" });
    expect(group.data).toMatchObject({ value: { name: "Team", apps: ["notes"] } });
  });

  it("leaves a group unscoped without an app label", async () => {
    const registry = buildRegistry();
    const bootstrap = groupBootstrap(registry, "Team");

    const updates = await commitUpdates(registry, [bootstrap.call]);

    expect(componentOf(updates, "ebb/group").data).toMatchObject({ value: { name: "Team" } });
    expect(componentOf(updates, "ebb/grant").data).toMatchObject({
      value: {
        group_id: bootstrap.groupId,
        actor_id: "a_actor",
        permissions: expect.arrayContaining(["ebb/group.*", "issue.*"]),
      },
    });
  });

  it("writes a user entity's map field as a merge of a map envelope", async () => {
    const setting = defineModel("setting", { name: e.string(), values: e.map(e.string()) });
    const registry = defineSchema({ models: { setting }, version: 1 })._registry;

    const updates = await commitUpdates(registry, [
      call(createEntity, {
        entity: "setting",
        id: "s_1",
        fields: { name: "Theme", values: { theme: "dark" } },
        groups: ["g_1"],
      }),
    ]);

    const values = componentOf(updates, "setting/values");
    expect(values).toMatchObject({ method: "merge" });
    expect(values.data).toMatchObject({
      map: { theme: { value: "dark", hlc: "hlc-1" } },
    });
    expect(componentOf(updates, "setting/name")).toMatchObject({ method: "replace" });
  });

  it("replaces a platform component's whole value on a patch", async () => {
    const registry = buildRegistry();

    const updates = await commitUpdates(registry, [
      call(patchEntity, {
        entity: "ebb",
        id: "g_1",
        payload: { group: { name: "Team", apps: ["issues"] } },
        groups: ["g_1"],
      }),
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      component: "ebb/group",
      method: "replace",
      data: { value: { name: "Team", apps: ["issues"] } },
    });
  });

  it("builds a relationship delete when the target is null", () => {
    const updates = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "e_issue",
      targetId: null,
      field: "project",
      type: "project",
      updateId: "u_1",
    });

    expect(updates).toEqual([{ id: "u_1", subject_id: "rel_1", method: "delete", data: null }]);
  });

  it("builds one ebb/link Update carrying the whole edge", () => {
    const updates = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "e_issue",
      targetId: "e_project",
      field: "project",
      type: "project",
      updateId: "u_1",
    });

    expect(updates).toEqual([
      {
        id: "u_1",
        subject_id: "rel_1",
        component: "ebb/link",
        method: "replace",
        data: {
          value: {
            source_id: "e_issue",
            target_id: "e_project",
            type: "project",
            field: "project",
          },
          update_id: "u_1",
        },
      },
    ]);
  });

  it("drops one component per named field and never a delete", async () => {
    const registry = buildRegistry();

    const updates = await commitUpdates(registry, [
      call(dropEntity, {
        entity: "issue",
        id: "e_issue",
        fields: ["title", "project"],
        groups: ["g_project"],
      }),
    ]);

    expect(updates).toEqual([
      { id: "u_1", subject_id: "e_issue", component: "issue/title", method: "drop", data: null },
      {
        id: "u_2",
        subject_id: "e_issue",
        component: "issue/project",
        method: "drop",
        data: null,
      },
    ]);
  });

  it("refuses a drop naming no component", () => {
    const registry = buildRegistry();

    let caught: unknown;
    try {
      dropEntity(
        { registry, ids: ids("u_"), actorId: "a_actor" },
        { entity: "issue", id: "e_issue", fields: [], groups: ["g_project"] },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EntityValidationError);
    expect((caught as Error).message).toContain("at least one");
  });

  it("refuses a component the model does not declare, naming it", () => {
    const registry = buildRegistry();

    let caught: unknown;
    try {
      dropEntity(
        { registry, ids: ids("u_"), actorId: "a_actor" },
        { entity: "issue", id: "e_issue", fields: ["draft"], groups: ["g_project"] },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EntityValidationError);
    expect((caught as Error).message).toContain("issue");
    expect((caught as Error).message).toContain('"draft"');
  });

  it("refuses dropping a platform component, naming the model", () => {
    const registry = buildRegistry();

    let caught: unknown;
    try {
      dropEntity(
        { registry, ids: ids("u_"), actorId: "a_actor" },
        { entity: "ebb", id: "rel_1", fields: ["link"], groups: ["g_project"] },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EntityValidationError);
    expect((caught as Error).message).toContain("ebb");
    expect((caught as Error).message).toContain("atomic");
  });

  it("resolves a drop verb without any read", async () => {
    const registry = buildRegistry();

    const entry = operationCallFor(registry, {
      verb: "drop",
      entity: "issue",
      id: "e_issue",
      fields: ["title"],
    });
    const updates = await commitUpdates(registry, [entry!]);

    expect(updates).toEqual([
      { id: "u_1", subject_id: "e_issue", component: "issue/title", method: "drop", data: null },
    ]);
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
    expect(result.updates[0]).toMatchObject({
      component: "ebb/link",
      data: { value: { source_id: "e_issue", target_id: "e_project", field: "project" } },
    });
  });
});
