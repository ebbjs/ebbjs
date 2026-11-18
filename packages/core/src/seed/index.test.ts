/**
 * Unit tests for the browser-safe seed builder (`@ebbjs/core/seed`).
 *
 * `buildSeedAction` turns plain seed rows into one wire `Action`; these
 * tests pin that wire shape — every plain value stamped into a field
 * envelope — and the rejection-tolerance policy in `assertSeedAccepted`.
 */

import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { compare } from "../hlc";
import {
  ActionSchema,
  componentField,
  isComponentUpdate,
  isRowCreate,
  type Action,
  type ComponentUpdate,
  type RowCreate,
  type Update,
} from "../types/action";
import {
  SeedRejectedError,
  assertSeedAccepted,
  buildSeedAction,
  isToleratedSeedRejection,
  type SeedData,
  type SeedRejection,
} from "./index";

const rejection = (reason: string): SeedRejection => ({ id: "action_1", reason });

/** A representative seed exercising every row kind. */
const buildRepresentativeSeed = (): SeedData => ({
  groups: [{ id: "grp_1", name: "Group One" }],
  grants: [
    {
      id: "gm_1",
      actorId: "actor_1",
      groupId: "grp_1",
      permissions: ["todo.*", "list.*"],
    },
  ],
  entities: [
    {
      id: "todo_1",
      model: "todo",
      patches: [
        { fields: { title: "Ship it" } },
        { fields: { status: "todo", assignee_id: null } },
      ],
    },
  ],
  relationships: [
    {
      sourceId: "todo_1",
      targetId: "list_1",
      type: "todo",
      field: "list",
    },
  ],
  memberships: [{ id: "eg_1", entityId: "todo_1", groupId: "grp_1" }],
});

/** Every leaf of a component value, walking nested maps to the innermost. */
const seedLeaves = (value: unknown): Array<{ update_id?: string; hlc?: string }> => {
  if (value !== null && typeof value === "object" && "map" in value) {
    return Object.values((value as { map: Record<string, unknown> }).map).flatMap(seedLeaves);
  }
  return [value as { update_id?: string; hlc?: string }];
};

/** The one Update carrying `component`, or a failure naming the miss. */
const componentOf = (action: Action, component: string, subjectId?: string): ComponentUpdate => {
  const update = action.updates
    .filter(isComponentUpdate)
    .find(
      (u) => u.component === component && (subjectId === undefined || u.subject_id === subjectId),
    );
  if (update === undefined) throw new Error(`no update for component "${component}"`);
  return update;
};

const updatesFor = (action: Action, subjectId: string): Update[] =>
  action.updates.filter((update) => update.subject_id === subjectId);

/** The one row-scoped create for `subjectId`, or a failure naming the miss. */
const createOf = (action: Action, subjectId: string): RowCreate => {
  const creates = updatesFor(action, subjectId).filter(isRowCreate);
  if (creates.length !== 1) throw new Error(`${creates.length} creates for "${subjectId}"`);
  return creates[0] as RowCreate;
};

interface FoldedRow {
  model: string;
  exists: boolean;
  created_hlc: string | null;
  deleted_hlc: string | null;
  fields: Record<string, unknown>;
}

/**
 * Fold a seed Action's Updates into rows the way the contract says a replica
 * does: a create makes the row live at its own HLC, and a component write
 * lands its value at the field after the `/`. Written from the contract, not
 * from any materializer, so the seed is checked against the protocol rather
 * than against another implementation of it.
 */
const foldSeedRows = (action: Action): Map<string, FoldedRow> => {
  const rows = new Map<string, FoldedRow>();
  for (const update of action.updates) {
    const row = rows.get(update.subject_id);
    if (isRowCreate(update)) {
      if (row !== undefined) continue;
      rows.set(update.subject_id, {
        model: update.model,
        exists: true,
        created_hlc: update.hlc,
        deleted_hlc: null,
        fields: {},
      });
      continue;
    }
    if (!isComponentUpdate(update) || update.method === "drop") continue;
    const fields = row?.fields ?? {};
    fields[componentField(update.component)] = update.data;
    rows.set(update.subject_id, {
      model: row?.model ?? update.component.split("/")[0]!,
      exists: row?.exists ?? false,
      created_hlc: row?.created_hlc ?? null,
      deleted_hlc: null,
      fields,
    });
  }
  return rows;
};

describe("buildSeedAction", () => {
  it("opens every seeded row with its create, then writes its components", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.actor_id).toBe("actor_1");
    expect(Value.Check(ActionSchema, action)).toBe(true);
    // Four rows, each a create plus its components: two a piece for the
    // group, grant, and membership rows, three for the entity's patch. The
    // link is a keyed component of the entity, so it adds an Update and no row.
    expect(action.updates).toHaveLength(11);

    const models: Array<[string, string]> = [
      ["grp_1", "ebb"],
      ["gm_1", "ebb"],
      ["todo_1", "todo"],
      ["eg_1", "ebb"],
    ];
    for (const [subjectId, model] of models) {
      const updates = updatesFor(action, subjectId);
      expect(isRowCreate(updates[0])).toBe(true);

      const create = createOf(action, subjectId);
      expect(create.model).toBe(model);
      expect(create.data).toBeNull();
      // The create is stamped from the builder's clock before the row's
      // first component, so the row's creation time never trails its data.
      const firstComponent = updates[1] as ComponentUpdate;
      const firstHlc = (firstComponent.data as { hlc?: string }).hlc;
      expect(firstHlc).toEqual(expect.any(String));
      expect(compare(create.hlc, firstHlc as string)).toBeLessThanOrEqual(0);
    }

    expect(componentOf(action, "ebb/group", "grp_1").data).toMatchObject({
      value: { name: "Group One" },
    });
    expect(componentOf(action, "ebb/grant", "gm_1").data).toMatchObject({
      value: { actor_id: "actor_1", group_id: "grp_1", permissions: ["todo.*", "list.*"] },
    });

    expect(componentOf(action, "todo/title", "todo_1").data).toMatchObject({ value: "Ship it" });
    expect(componentOf(action, "todo/status", "todo_1").data).toMatchObject({ value: "todo" });
    expect(componentOf(action, "todo/assignee_id", "todo_1").data).toMatchObject({ value: null });

    expect(componentOf(action, "ebb/link", "todo_1").method).toBe("merge");
    expect(componentOf(action, "ebb/link", "todo_1").data).toMatchObject({
      map: { list: { map: { todo: { map: { list_1: { value: true } } } } } },
    });

    expect(componentOf(action, "ebb/membership", "eg_1").data).toMatchObject({
      value: { entity_id: "todo_1", group_id: "grp_1" },
    });
  });

  it("seeds an entity row with no patches as one create that folds to a live row", () => {
    const action = buildSeedAction("actor_1", {
      groups: [],
      grants: [],
      entities: [{ id: "todo_1", model: "todo", patches: [] }],
    });

    expect(action.updates).toHaveLength(1);
    const create = createOf(action, "todo_1");
    expect(create.model).toBe("todo");

    const row = foldSeedRows(action).get("todo_1");
    expect(row).toEqual({
      model: "todo",
      exists: true,
      created_hlc: create.hlc,
      deleted_hlc: null,
      fields: {},
    });
  });

  it("writes a group's app scope into the group's one atomic value", () => {
    const action = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared", apps: ["notes", "issues"] }],
      grants: [],
      entities: [],
    });

    expect(action.updates).toHaveLength(2);
    const group = componentOf(action, "ebb/group");
    expect(group.method).toBe("replace");
    expect(group.data).toMatchObject({
      value: { name: "Shared", apps: ["notes", "issues"] },
    });
  });

  it("distinguishes an unscoped group from one scoped to no app", () => {
    const unscoped = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared" }],
      grants: [],
      entities: [],
    });
    const noApps = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared", apps: [] }],
      grants: [],
      entities: [],
    });

    expect(componentOf(unscoped, "ebb/group").data).toMatchObject({ value: { name: "Shared" } });
    expect(componentOf(noApps, "ebb/group").data).toMatchObject({
      value: { name: "Shared", apps: [] },
    });
  });

  it("stamps every plain value into a seed_update envelope with an HLC", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    for (const update of action.updates) {
      if (!isComponentUpdate(update) || update.method === "drop") continue;
      // A keyed component's value is a nest of maps, so the envelope is at
      // each innermost leaf rather than at the component's top level.
      for (const leaf of seedLeaves(update.data)) {
        expect(leaf.update_id).toBe("seed_update");
        expect(leaf.hlc).toEqual(expect.any(String));
        expect(leaf.hlc).not.toBe("");
      }
    }
  });
});

describe("assertSeedAccepted", () => {
  it("tolerates a duplicate or already-present seed", () => {
    for (const reason of ["already_exists", "duplicate_action"]) {
      expect(isToleratedSeedRejection(reason)).toBe(true);
      expect(() => assertSeedAccepted([rejection(reason)])).not.toThrow();
    }
  });

  it("does not tolerate a validation rejection", () => {
    expect(isToleratedSeedRejection("not_authorized")).toBe(false);
    expect(isToleratedSeedRejection(undefined)).toBe(false);
  });

  it("passes an empty rejection list", () => {
    expect(() => assertSeedAccepted([])).not.toThrow();
  });

  it("throws SeedRejectedError carrying the fatal rejections", () => {
    let thrown: unknown;
    try {
      assertSeedAccepted([rejection("already_exists"), rejection("not_authorized")]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeedRejectedError);
    expect((thrown as SeedRejectedError).rejections).toEqual([rejection("not_authorized")]);
  });
});
