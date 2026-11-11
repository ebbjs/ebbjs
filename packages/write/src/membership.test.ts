/**
 * Unit tests for the membership checker — the client-side resolution of
 * a system write's fan-out group set, and the `last_membership` net
 * delta that mirrors the server's #264 rule.
 */

import { describe, expect, it } from "vitest";
import { componentName, type Update } from "@ebbjs/core";

import {
  lastGroupMemberViolation,
  lastMembershipViolation,
  membershipScope,
  resultingGroups,
  type LiveGroupMember,
  type MembershipView,
} from "./membership";

const view = (overrides: Partial<MembershipView> = {}): MembershipView => ({
  groupsOf: () => [],
  groupOfMembership: () => undefined,
  ...overrides,
});

interface UpdateSpec {
  readonly subject_id: string;
  /** The model the row is committed under. */
  readonly model: string;
  readonly method?: Update["method"];
  readonly fields?: Record<string, unknown>;
}

/** One Update per field; a delete names no component. */
const update = (spec: UpdateSpec): Update[] => {
  const method = spec.method ?? "replace";
  if (method === "delete") {
    return [{ id: "u_1", subject_id: spec.subject_id, method: "delete", data: null }];
  }
  return Object.entries(spec.fields ?? {}).map(([field, value]) => ({
    id: `u_1_${field}`,
    subject_id: spec.subject_id,
    component: componentName(spec.model, field),
    method: "replace",
    data: { value, update_id: "u_1" },
  }));
};

describe("membership checker — fan-out scope", () => {
  it("resolves a group to its own id", () => {
    const scope = membershipScope(
      update({ subject_id: "g_1", model: "group", fields: { name: "Team" } }),
      view(),
    );
    expect(scope).toEqual(["g_1"]);
  });

  it("resolves a groupMember to its wired group_id", () => {
    const scope = membershipScope(
      update({
        subject_id: "gm_1",
        model: "groupMember",
        fields: { group_id: "g_2" },
      }),
      view(),
    );
    expect(scope).toEqual(["g_2"]);
  });

  it("resolves an entityGroup put to its wired group_id", () => {
    const scope = membershipScope(
      update({
        subject_id: "eg_1",
        model: "entityGroup",
        fields: { entity_id: "todo_1", group_id: "g_3" },
      }),
      view(),
    );
    expect(scope).toEqual(["g_3"]);
  });

  it("resolves an entityGroup delete through the membership row's group", () => {
    const scope = membershipScope(
      update({ subject_id: "eg_1", model: "entityGroup", method: "delete" }),
      view({ groupOfMembership: (id) => (id === "eg_1" ? "g_4" : undefined) }),
    );
    expect(scope).toEqual(["g_4"]);
  });

  it("resolves a relationship through its source's groups", () => {
    const scope = membershipScope(
      update({
        subject_id: "rel_1",
        model: "relationship",
        fields: { source_id: "todo_1" },
      }),
      view({ groupsOf: (id) => (id === "todo_1" ? ["g_5", "g_6"] : []) }),
    );
    expect(scope).toEqual(["g_5", "g_6"]);
  });

  it("returns an empty scope when the subject cannot be resolved", () => {
    expect(
      membershipScope(
        update({ subject_id: "eg_1", model: "entityGroup", method: "delete" }),
        view(),
      ),
    ).toEqual([]);
    expect(membershipScope(update({ subject_id: "rel_1", model: "relationship" }), view())).toEqual(
      [],
    );
    expect(membershipScope(update({ subject_id: "todo_1", model: "todo" }), view())).toEqual([]);
  });

  it("unions a batch's scopes, sorted and de-duplicated", () => {
    const scope = membershipScope(
      [
        ...update({
          subject_id: "eg_1",
          model: "entityGroup",
          fields: { group_id: "g_2" },
        }),
        ...update({ subject_id: "eg_2", model: "entityGroup", method: "delete" }),
        ...update({
          subject_id: "eg_3",
          model: "entityGroup",
          fields: { group_id: "g_1" },
        }),
      ],
      view({ groupOfMembership: (id) => (id === "eg_2" ? "g_2" : undefined) }),
    );
    expect(scope).toEqual(["g_1", "g_2"]);
  });
});

describe("membership checker — last membership net delta", () => {
  it("keeps groups that are put and not removed", () => {
    expect(resultingGroups(["g_1"], { puts: ["g_2"], removedGroups: [] })).toEqual(["g_1", "g_2"]);
  });

  it("drops a removed group when no put re-adds it", () => {
    expect(resultingGroups(["g_1", "g_2"], { puts: [], removedGroups: ["g_1"] })).toEqual(["g_2"]);
  });

  it("cancels a removal when the same Action re-adds the group", () => {
    expect(resultingGroups(["g_1"], { puts: ["g_1"], removedGroups: ["g_1"] })).toEqual(["g_1"]);
  });

  it("swapping the last membership for a new group survives", () => {
    expect(resultingGroups(["g_1"], { puts: ["g_2"], removedGroups: ["g_1"] })).toEqual(["g_2"]);
  });

  it("refuses a delta that nets the entity to zero owning groups", () => {
    const violation = lastMembershipViolation(["g_1"], { puts: [], removedGroups: ["g_1"] });
    expect(violation).toContain("no owning group");
  });

  it("defers when the local view cannot say whether the entity is unowned", () => {
    expect(
      lastMembershipViolation(undefined, { puts: [], removedGroups: ["g_1"] }),
    ).toBeUndefined();
    expect(lastMembershipViolation([], { puts: [], removedGroups: ["g_1"] })).toBeUndefined();
  });

  it("allows a delta that leaves at least one owning group", () => {
    expect(
      lastMembershipViolation(["g_1", "g_2"], { puts: [], removedGroups: ["g_1"] }),
    ).toBeUndefined();
  });
});

describe("membership checker — last group member net delta", () => {
  const member = (
    id: string,
    permissions: readonly string[],
    groupId = "g_1",
  ): LiveGroupMember => ({ id, groupId, permissions });

  it("refuses removing the group's last capable member", () => {
    const violation = lastGroupMemberViolation([member("gm_1", ["group.*"])], {
      removedIds: ["gm_1"],
      upserts: [],
    });
    expect(violation).toContain("no member that can administer it");
  });

  it("allows removing one of two capable members", () => {
    expect(
      lastGroupMemberViolation([member("gm_1", ["group.*"]), member("gm_2", ["group.*"])], {
        removedIds: ["gm_1"],
        upserts: [],
      }),
    ).toBeUndefined();
  });

  it("counts an empty-list member as incapable when the capable one is removed", () => {
    const violation = lastGroupMemberViolation([member("gm_1", ["group.*"]), member("gm_2", [])], {
      removedIds: ["gm_1"],
      upserts: [],
    });
    expect(violation).toContain("no member that can administer it");
  });

  it("refuses emptying the group's only non-empty permission list", () => {
    const violation = lastGroupMemberViolation([member("gm_1", ["group.*"])], {
      removedIds: [],
      upserts: [{ id: "gm_1", permissions: [] }],
    });
    expect(violation).toContain("no member that can administer it");
  });

  it("allows patching one of several members to an empty list", () => {
    expect(
      lastGroupMemberViolation([member("gm_1", ["group.*"]), member("gm_2", ["group.*"])], {
        removedIds: [],
        upserts: [{ id: "gm_1", permissions: [] }],
      }),
    ).toBeUndefined();
  });

  it("defers when the local view cannot say whether the group is unowned", () => {
    expect(
      lastGroupMemberViolation(undefined, { removedIds: ["gm_1"], upserts: [] }),
    ).toBeUndefined();
    expect(lastGroupMemberViolation([], { removedIds: ["gm_1"], upserts: [] })).toBeUndefined();
  });
});
