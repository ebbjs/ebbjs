/**
 * The platform row emitters: a create plus one Update per row, the single
 * Update carrying the component's whole value.
 *
 * These pin the property the slice exists for — a torn membership or grant
 * cannot be emitted, because there is no Update that carries half of one — and
 * that a platform row is created before anything is written to it. `ebb/link`
 * is a keyed component of its source, so its Updates are pinned in
 * `relationship.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  EBB_COMPONENTS,
  isComponentUpdate,
  isRowCreate,
  type ComponentUpdate,
  type Update,
} from "@ebbjs/core";

import {
  grantRowUpdates,
  groupRowUpdates,
  membershipRowUpdates,
  systemRowDelete,
  systemRowUpdate,
} from "./system-rows";

/** A fresh id per Update and one fixed clock. */
const ids = (hlc = "hlc_1") => {
  let next = 0;
  return { updateId: () => `u_${++next}`, hlc: () => hlc };
};

/** A component Update that carries a value. */
type ValueUpdate = Extract<ComponentUpdate, { method: "merge" | "replace" }>;

/** The one component Update of a row. */
const valueUpdate = (updates: readonly Update[]): ValueUpdate => {
  const update = updates.filter(isComponentUpdate);
  expect(update).toHaveLength(1);
  const [only] = update;
  if (only === undefined || only.method === "drop") throw new Error("a value Update expected");
  return only;
};

/** The row's create: always first, always naming the platform model. */
const createOf = (updates: readonly Update[]): Update => {
  const [first] = updates;
  if (first === undefined || !isRowCreate(first)) throw new Error("a create Update expected first");
  return first;
};

/** The value a component Update carries. */
const valueOf = (updates: readonly Update[]): Record<string, unknown> =>
  valueUpdate(updates).data.value as Record<string, unknown>;
/** The three platform kinds that are one atomic value on a row of their own. */
const ROW_KINDS = ["group", "grant", "membership"] as const;

describe("system row emitters", () => {
  it.each(ROW_KINDS)("names the %s component from the platform vocabulary", (kind) => {
    const update = systemRowUpdate(kind, "e_1", {}, ids());

    expect(valueUpdate([update]).component).toBe(EBB_COMPONENTS[kind]);
  });

  it("writes ebb/membership as one Update, so a mismatched pair is unrepresentable", () => {
    const updates = membershipRowUpdates(
      { membershipId: "eg_1", entityId: "e_todo", groupId: "g_1" },
      ids(),
    );

    expect(createOf(updates)).toMatchObject({ subject_id: "eg_1", model: "ebb" });
    expect(valueUpdate(updates).component).toBe(EBB_COMPONENTS.membership);
    expect(valueOf(updates)).toEqual({ entity_id: "e_todo", group_id: "g_1" });
  });

  it("writes ebb/grant as one Update carrying the actor, group, and permissions", () => {
    const permissions = ["todo.*", "issue.*"];
    const updates = grantRowUpdates(
      { grantId: "gm_1", actorId: "a_1", groupId: "g_1", permissions },
      ids(),
    );

    expect(createOf(updates)).toMatchObject({ subject_id: "gm_1", model: "ebb" });
    expect(valueUpdate(updates).component).toBe(EBB_COMPONENTS.grant);
    expect(valueOf(updates)).toEqual({
      actor_id: "a_1",
      group_id: "g_1",
      permissions: ["todo.*", "issue.*"],
    });
    // The value is a copy: a caller mutating its list cannot tear a buffered row.
    expect(valueOf(updates)["permissions"]).not.toBe(permissions);
  });

  it("omits apps from an unscoped group and keeps an empty list distinct from absence", () => {
    const unscoped = groupRowUpdates({ groupId: "g_1", name: "Team" }, ids());
    const noApps = groupRowUpdates({ groupId: "g_2", name: "Team", apps: [] }, ids());
    const scoped = groupRowUpdates({ groupId: "g_3", name: "Team", apps: ["notes"] }, ids());

    expect(valueUpdate(unscoped).component).toBe(EBB_COMPONENTS.group);
    expect(valueOf(unscoped)).toEqual({ name: "Team" });
    expect(valueOf(noApps)).toEqual({ name: "Team", apps: [] });
    expect(valueOf(scoped)).toEqual({ name: "Team", apps: ["notes"] });
  });

  it("emits a delete that names no component, so the server resolves the kind", () => {
    const update = systemRowDelete("eg_1", { updateId: () => "u_1" });

    expect(update).toEqual({ id: "u_1", subject_id: "eg_1", method: "delete", data: null });
  });
});
