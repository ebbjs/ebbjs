/**
 * Unit tests for the `changeGroups` operation — the pure membership
 * delta every draft membership verb builds.
 */

import { describe, expect, it } from "vitest";
import { componentModel, EBB_COMPONENTS, type Update } from "@ebbjs/core";

import { EntityValidationError, ModelRegistry, defineModel, defineSchema, e } from "@ebbjs/schema";
import {
  ActionRejectedError,
  changeGroups,
  createEntity,
  dropEntity,
  patchEntity,
  type OpContext,
} from "./operations";

/** The Updates of one model, grouped into one list per subject row. */
const rowsOf = (updates: readonly Update[], model: string): readonly (readonly Update[])[] => {
  const bySubject = new Map<string, Update[]>();
  for (const update of updates) {
    if (update.method === "delete" || componentModel(update.component) !== model) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/** A row's component values, keyed by field. */
const fieldsOf = (row: readonly Update[]): Record<string, unknown> =>
  Object.fromEntries(
    row
      .filter((update) => update.method === "merge" || update.method === "replace")
      .map((update) => [
        update.method === "delete" ? "" : update.component.slice(update.component.indexOf("/") + 1),
        update.method === "delete" ? null : (update.data as { value: unknown }).value,
      ]),
  );

const mkCtx = (registry: ModelRegistry = new ModelRegistry()): OpContext => {
  let next = 0;
  return {
    registry,
    ids: {
      updateId: () => `u_${++next}`,
      hlc: () => "hlc_1",
      newId: (prefix: string) => `${prefix}_1`,
    },
    actorId: "actor_1",
  };
};

/** A registry carrying the platform model, as every real schema does. */
const platformRegistry = (): ModelRegistry =>
  defineSchema({
    models: { todo: defineModel("todo", { title: e.string() }) },
    version: 1,
  })._registry;

describe("changeGroups", () => {
  it("emits one membership put per added group then a delete per removed row", () => {
    const result = changeGroups(mkCtx(), {
      entity: "todo",
      entityId: "todo_1",
      puts: ["g_2"],
      removes: [{ membershipId: "eg_1", groupId: "g_1" }],
      currentGroups: ["g_1"],
    });

    expect(result.updates.map((update) => update.method)).toEqual(["replace", "delete"]);
    const [membershipRow] = rowsOf(result.updates, "ebb");
    expect(membershipRow).toHaveLength(1);
    expect(fieldsOf(membershipRow!)["membership"]).toEqual({
      entity_id: "todo_1",
      group_id: "g_2",
    });
    expect(result.updates.at(-1)!.subject_id).toBe("eg_1");
    expect(result.groups).toEqual(["g_1", "g_2"]);
    expect(result.subject).toEqual({ id: "todo_1", type: "todo" });
  });

  it("refuses a delta that would leave the entity with no owning group", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "g_1" }],
        currentGroups: ["g_1"],
      }),
    ).toThrowError(ActionRejectedError);
  });

  it("refuses a membership write whose fan-out scope cannot be resolved", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "" }],
      }),
    ).toThrowError(ActionRejectedError);
  });
});

describe("platform rows", () => {
  it("writes one whole-value Update for the component a create names", () => {
    const result = createEntity(mkCtx(platformRegistry()), {
      entity: "ebb",
      id: "g_1",
      fields: { group: { name: "Team", apps: ["notes"] } },
      groups: ["g_1"],
    });

    const groupRows = rowsOf(result.updates, "ebb").filter(
      (row) => row[0]!.subject_id === "g_1" && row[0]!.method !== "delete",
    );
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0]).toHaveLength(1);
    expect(groupRows[0]![0]).toMatchObject({
      component: EBB_COMPONENTS.group,
      method: "replace",
      data: { value: { name: "Team", apps: ["notes"] } },
    });
  });

  it("refuses a create naming two components, because a row carries one kind", () => {
    expect(() =>
      createEntity(mkCtx(platformRegistry()), {
        entity: "ebb",
        id: "x_1",
        fields: {
          group: { name: "Team" },
          membership: { entity_id: "todo_1", group_id: "g_1" },
        },
        groups: ["g_1"],
      }),
    ).toThrowError(/exactly one component/);
  });

  it("refuses a create naming no component, because a row has no kind", () => {
    expect(() =>
      createEntity(mkCtx(platformRegistry()), {
        entity: "ebb",
        id: "x_1",
        fields: {},
        groups: ["g_1"],
      }),
    ).toThrowError(/exactly one component/);
  });

  it("refuses a platform value missing a required field", () => {
    expect(() =>
      createEntity(mkCtx(platformRegistry()), {
        entity: "ebb",
        id: "g_1",
        fields: { group: { apps: ["notes"] } },
        groups: ["g_1"],
      }),
    ).toThrowError(EntityValidationError);
  });

  it("refuses a patch naming two components", () => {
    expect(() =>
      patchEntity(mkCtx(platformRegistry()), {
        entity: "ebb",
        id: "x_1",
        payload: {
          group: { name: "Team" },
          grant: { actor_id: "a_1", group_id: "g_1", permissions: [] },
        },
        groups: ["g_1"],
      }),
    ).toThrowError(/exactly one component/);
  });

  it("refuses dropping a platform component", () => {
    expect(() =>
      dropEntity(mkCtx(platformRegistry()), {
        entity: "ebb",
        id: "rel_1",
        fields: ["link"],
        groups: ["g_1"],
      }),
    ).toThrowError(/atomic component/);
  });
});
