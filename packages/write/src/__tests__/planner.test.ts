import {
  isComponentUpdate,
  isRowCreate,
  type ComponentUpdate,
  type RowCreate,
  type Update,
} from "@ebbjs/core";
import {
  EntityValidationError,
  defineModel,
  defineRelationship,
  defineSchema,
  e,
} from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import {
  buildMembershipDelete,
  buildManyEntityUpdate,
  buildRelationshipUpdate,
  call,
  commit,
  createEntity,
  deleteEntity,
  dropEntity,
  duplicateEntity,
  groupBootstrap,
  operationCallFor,
  patchEntity,
  writeRelationship,
  type CommitCapability,
  type OpContext,
} from "../index";

/** A model whose components are all optional, so a zero-component row is legal. */
const buildOptionalRegistry = () =>
  defineSchema({
    models: { draft: defineModel("draft", { title: e.string().default("") }) },
    version: 1,
  })._registry;

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
const componentOf = (updates: readonly Update[], component: string): ComponentUpdate => {
  const update = updates.find(
    (candidate) => isComponentUpdate(candidate) && candidate.component === component,
  );
  if (update === undefined || !isComponentUpdate(update)) {
    throw new Error(`no update for component "${component}"`);
  }
  return update;
};

const updatesWithComponent = (
  updates: readonly Update[],
  component: string,
): readonly ComponentUpdate[] =>
  updates.filter(
    (update): update is ComponentUpdate =>
      isComponentUpdate(update) && update.component === component,
  );

/** Every create the operation emitted, in order. */
const createsOf = (updates: readonly Update[]): readonly RowCreate[] => updates.filter(isRowCreate);

/** The row a create names, for asserting a create is followed by its own writes. */
const createdSubjectOf = (update: Update | undefined): string => {
  if (update === undefined || !isRowCreate(update)) {
    throw new Error("expected a create Update");
  }
  return update.subject_id;
};

const ids = (prefix: string) => {
  let next = 0;
  return {
    updateId: () => `${prefix}${++next}`,
    hlc: () => `${prefix}hlc-${next}`,
    newId: (kind: string) => `${prefix}${kind}-${++next}`,
  };
};

const ctxOf = (registry: ReturnType<typeof buildRegistry>, prefix = "u_"): OpContext => ({
  registry,
  ids: ids(prefix),
  actorId: "a_actor",
});

describe("@ebbjs/write", () => {
  it("opens each new row with its create, then writes the row's fields", async () => {
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
    expect(submissions[0]?.[0]).toEqual({
      id: "u_1",
      subject_id: "e_issue",
      model: "issue",
      method: "create",
      hlc: "hlc-1",
      data: null,
    });
    expect(submissions[0]?.filter(isComponentUpdate).map((update) => update.component)).toEqual([
      "issue/title",
      "ebb/membership",
    ]);
    const creates = createsOf(submissions[0] ?? []);
    expect(creates.map((create) => create.model)).toEqual(["issue", "ebb"]);
  });

  it("creates a zero-component row as one create Update", async () => {
    const registry = buildOptionalRegistry();

    const updates = await commitUpdates(registry, [
      call(createEntity, { entity: "draft", id: "e_draft", fields: {}, groups: [] }),
    ]);

    expect(updates).toEqual([
      {
        id: "u_1",
        subject_id: "e_draft",
        model: "draft",
        method: "create",
        hlc: "hlc-1",
        data: null,
      },
    ]);
  });

  it("creates every membership row before writing it", async () => {
    const registry = buildOptionalRegistry();

    const updates = await commitUpdates(registry, [
      call(createEntity, {
        entity: "draft",
        id: "e_draft",
        fields: {},
        groups: ["g_project", "g_other"],
      }),
    ]);

    expect(updates.map((update) => update.method)).toEqual([
      "create",
      "create",
      "replace",
      "create",
      "replace",
    ]);
    expect(createsOf(updates).map((create) => create.model)).toEqual(["draft", "ebb", "ebb"]);
    // Each membership's create is followed by the component of the same row.
    for (const [index, update] of updates.entries()) {
      if (!isRowCreate(update) || update.subject_id === "e_draft") continue;
      expect(updates[index + 1]?.subject_id).toBe(update.subject_id);
      expect(updates[index + 1]?.method).toBe("replace");
    }
  });

  it("scopes a bootstrapped group to the app that created it", async () => {
    const registry = buildRegistry();
    const bootstrap = groupBootstrap(registry, "Team", undefined, "notes");

    const updates = await commitUpdates(registry, [bootstrap.call]);
    const group = componentOf(updates, "ebb/group");

    expect(group.method).toBe("replace");
    expect(group.data).toMatchObject({ value: { name: "Team", apps: ["notes"] } });
    expect(createsOf(updates).map((create) => create.subject_id)).toEqual([
      bootstrap.groupId,
      bootstrap.memberId,
    ]);
    expect(createsOf(updates).every((create) => create.model === "ebb")).toBe(true);
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
        permissions: ["ebb.*", "issue.*", "project.*"],
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
    expect(values.method).toBe("merge");
    expect(values.data).toMatchObject({
      map: { theme: { value: "dark", hlc: "hlc-1" } },
    });
    expect(componentOf(updates, "setting/name").method).toBe("replace");
    expect(createdSubjectOf(updates[0])).toBe("s_1");
  });

  it("replaces a platform component's whole value on a patch, without creating it", async () => {
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
    expect(createsOf(updates)).toEqual([]);
  });

  it("builds a relationship delete when the target is null, and no create with it", () => {
    const updates = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "e_issue",
      targetId: null,
      field: "project",
      type: "project",
      ids: { updateId: () => "u_1", hlc: () => "hlc-1" },
    });

    expect(updates).toEqual([{ id: "u_1", subject_id: "rel_1", method: "delete", data: null }]);
  });

  it("creates a link row, then writes its one ebb/link component", () => {
    const updates = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "e_issue",
      targetId: "e_project",
      field: "project",
      type: "project",
      ids: { updateId: () => "u_1", hlc: () => "hlc-1" },
    });

    expect(updates[0]).toEqual({
      id: "u_1",
      subject_id: "rel_1",
      model: "ebb",
      method: "create",
      hlc: "hlc-1",
      data: null,
    });
    expect(componentOf(updates, "ebb/link").data).toEqual({
      value: {
        source_id: "e_issue",
        target_id: "e_project",
        type: "project",
        field: "project",
      },
      update_id: "u_1",
      hlc: "hlc-1",
    });
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

  it("never creates a row it only updates or deletes", async () => {
    const registry = buildRegistry();

    const updates = await commitUpdates(registry, [
      call(patchEntity, {
        entity: "issue",
        id: "e_issue",
        payload: { title: "Renamed" },
        groups: ["g_project"],
      }),
      call(dropEntity, {
        entity: "issue",
        id: "e_issue",
        fields: ["title"],
        groups: ["g_project"],
      }),
      call(deleteEntity, { entity: "issue", id: "e_issue", groups: ["g_project"] }),
    ]);

    expect(createsOf(updates)).toEqual([]);
    expect(updates.some((update) => update.method === "delete")).toBe(true);
  });

  it("never creates a row for a membership delete or a many-cardinality FK merge", () => {
    const membershipDelete = buildMembershipDelete({ membershipId: "eg_1", updateId: "u_1" });
    const entityUpdate = buildManyEntityUpdate({
      sourceId: "e_issue",
      sourceEntityName: "issue",
      as: "projects",
      targetIds: ["e_project"],
      updateId: "u_2",
      hlc: "hlc-1",
    });

    expect(membershipDelete).toEqual({
      id: "u_1",
      subject_id: "eg_1",
      method: "delete",
      data: null,
    });
    expect(entityUpdate.method).toBe("merge");
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

  it("keeps a relationship write pure under a shared OpContext, creating the link row", () => {
    const registry = buildRegistry();

    const result = writeRelationship(ctxOf(registry), {
      entity: "issue",
      sourceId: "e_issue",
      as: "project",
      pointer: { targetId: "e_project" },
      groups: ["g_project"],
    });

    expect(result.groups).toEqual(["g_project"]);
    expect(result.updates).toHaveLength(2);
    expect(result.updates[0]).toMatchObject({
      subject_id: "u_rel-1",
      model: "ebb",
      method: "create",
    });
    expect(result.updates[1]).toMatchObject({
      subject_id: "u_rel-1",
      component: "ebb/link",
      data: { value: { source_id: "e_issue", target_id: "e_project", field: "project" } },
    });
  });

  it("writes a many-cardinality relationship as the FK merge plus one created link row", () => {
    const project = defineModel("project", { name: e.string(), issues: e.array(e.string()) });
    const issue = defineModel("issue", { title: e.string() });
    const hasIssues = defineRelationship({
      source: project,
      target: issue,
      as: "issues",
      sourceCardinality: "many",
    });
    const registry = defineSchema({
      models: { project, issue },
      relationships: { hasIssues },
      version: 1,
    })._registry;

    const result = writeRelationship(ctxOf(registry), {
      entity: "project",
      sourceId: "p_1",
      as: "issues",
      pointer: { targetIds: { replace: ["i_1"] } },
      groups: ["g_1"],
    });

    expect(result.updates.map((update) => update.method)).toEqual(["merge", "create", "replace"]);
    expect(result.updates[0]).toMatchObject({ subject_id: "p_1", component: "project/issues" });
    expect(result.updates[1]).toMatchObject({ model: "ebb", method: "create" });
    expect(result.updates[2]).toMatchObject({
      component: "ebb/link",
      subject_id: createdSubjectOf(result.updates[1]),
    });
  });

  it("creates the copy's row before writing the copied fields", () => {
    const registry = buildRegistry();
    const source = {
      id: "e_source",
      model: "issue",
      data: { fields: { title: { value: "Ship it", update_id: "u_0" } } },
      exists: true,
      created_hlc: "hlc-0",
      updated_hlc: "hlc-0",
      deleted_hlc: null,
      last_gsn: 1,
    };

    const result = duplicateEntity(ctxOf(registry), {
      entity: "issue",
      subjectId: "e_copy",
      source,
      groups: ["g_project"],
    });

    expect(result.updates.map((update) => update.method)).toEqual([
      "create",
      "replace",
      "create",
      "replace",
    ]);
    expect(createsOf(result.updates).map((create) => create.model)).toEqual(["issue", "ebb"]);
    expect(updatesWithComponent(result.updates, "issue/title")).toHaveLength(1);
  });
});
