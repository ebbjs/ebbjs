/**
 * The platform row emitters: one Update per row, carrying the component's
 * whole value.
 *
 * These pin the property the slice exists for — a torn edge, membership, or
 * grant cannot be emitted, because there is no Update that carries half of
 * one.
 */

import { describe, expect, it } from "vitest";
import { EBB_COMPONENTS, EBB_COMPONENT_KINDS, type Update } from "@ebbjs/core";

import {
  grantRowUpdate,
  groupRowUpdate,
  linkRowUpdate,
  membershipRowUpdate,
  systemRowDelete,
  systemRowUpdate,
} from "./system-rows";

/** A fresh id per Update and one fixed clock. */
const ids = (hlc = "hlc_1") => {
  let next = 0;
  return { updateId: () => `u_${++next}`, hlc: () => hlc };
};

/** The Update narrowed to one that carries a component value. */
const valueUpdate = (update: Update): Extract<Update, { method: "replace" | "merge" }> => {
  if (update.method === "delete" || update.method === "drop") {
    throw new Error("a value Update expected");
  }
  return update;
};

/** The value a component Update carries. */
const valueOf = (update: Update): Record<string, unknown> =>
  valueUpdate(update).data.value as Record<string, unknown>;

describe("system row emitters", () => {
  it.each(EBB_COMPONENT_KINDS)("names the %s component from the platform vocabulary", (kind) => {
    const update = systemRowUpdate(kind, "e_1", {}, ids());

    expect(valueUpdate(update).component).toBe(EBB_COMPONENTS[kind]);
  });

  it("writes ebb/link as one Update carrying all four fields", () => {
    const update = linkRowUpdate(
      {
        linkId: "rel_1",
        sourceId: "e_issue",
        targetId: "e_project",
        field: "project",
        type: "issue",
      },
      ids(),
    );

    expect(update).toEqual({
      id: "u_1",
      subject_id: "rel_1",
      component: EBB_COMPONENTS.link,
      method: "replace",
      data: {
        value: {
          source_id: "e_issue",
          target_id: "e_project",
          type: "issue",
          field: "project",
        },
        update_id: "u_1",
        hlc: "hlc_1",
      },
    });
  });

  it("writes ebb/membership as one Update, so a mismatched pair is unrepresentable", () => {
    const update = membershipRowUpdate(
      { membershipId: "eg_1", entityId: "e_todo", groupId: "g_1" },
      ids(),
    );

    expect(valueUpdate(update).component).toBe(EBB_COMPONENTS.membership);
    expect(valueOf(update)).toEqual({ entity_id: "e_todo", group_id: "g_1" });
  });

  it("writes ebb/grant as one Update carrying the actor, group, and permissions", () => {
    const permissions = ["todo.*", "issue.*"];
    const update = grantRowUpdate(
      { grantId: "gm_1", actorId: "a_1", groupId: "g_1", permissions },
      ids(),
    );

    expect(valueUpdate(update).component).toBe(EBB_COMPONENTS.grant);
    expect(valueOf(update)).toEqual({
      actor_id: "a_1",
      group_id: "g_1",
      permissions: ["todo.*", "issue.*"],
    });
    // The value is a copy: a caller mutating its list cannot tear a buffered row.
    expect(valueOf(update)["permissions"]).not.toBe(permissions);
  });

  it("omits apps from an unscoped group and keeps an empty list distinct from absence", () => {
    const unscoped = groupRowUpdate({ groupId: "g_1", name: "Team" }, ids());
    const noApps = groupRowUpdate({ groupId: "g_2", name: "Team", apps: [] }, ids());
    const scoped = groupRowUpdate({ groupId: "g_3", name: "Team", apps: ["notes"] }, ids());

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
