/**
 * The membership pre-flight: the client planner's structural refusals, checked
 * against the invocation's overlay so they surface at the offending call. The
 * checks refuse only what the invocation can prove; everything else defers to
 * the server's fail-whole mapping.
 */

import { describe, expect, it } from "vitest";

import type { Update } from "@ebbjs/core";
import { ActionRejectedError, entityGroupId } from "@ebbjs/write";

import { assertLastMembership, assertMembershipScope } from "./preflight.ts";
import { fakeHost, testContext } from "./test-support/host.ts";

const issue = () => ({ title: "Ship", done: false, labels: [] as string[] });

describe("last_membership", () => {
  it("refuses deleting the last membership row of a row created here", () => {
    const ctx = testContext(fakeHost());
    const created = ctx.create("issue", issue(), { id: "e_solo", groups: ["g_1"] });

    const error = (() => {
      try {
        ctx.delete("entityGroup", entityGroupId(created.id, "g_1"));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections).toMatchObject([
      { id: "e_solo", model: "issue", reason: "last_membership" },
    ]);
  });

  it("allows removing one of several groups, then refuses the last one", () => {
    const ctx = testContext(fakeHost());
    const created = ctx.create("issue", issue(), { id: "e_shared", groups: ["g_1", "g_2"] });

    expect(() => ctx.delete("entityGroup", entityGroupId(created.id, "g_1"))).not.toThrow();
    expect(() => ctx.delete("entityGroup", entityGroupId(created.id, "g_2"))).toThrow(
      ActionRejectedError,
    );
  });

  it("defers when the entity's groups are not visible to the invocation", () => {
    const view = {
      groupsOf: () => [],
      groupOfMembership: () => undefined,
      groupMembersOf: () => undefined,
    };

    expect(() => assertLastMembership(view, "issue", "e_stored", ["g_1"])).not.toThrow();
  });
});

describe("last_group_member", () => {
  it("refuses a member delete that would leave a new group with no capable member", () => {
    const ctx = testContext(fakeHost());
    ctx.create("group", { name: "Team" }, { id: "g_team", groups: ["g_team"] });
    ctx.create(
      "groupMember",
      { group_id: "g_team", actor_id: "a_admin", permissions: [] },
      { id: "e_member", groups: ["g_team"] },
    );

    expect(() => ctx.delete("groupMember", "e_member")).toThrow(ActionRejectedError);
  });

  it("refuses a permission-only patch that empties the group's last capable member", () => {
    const ctx = testContext(fakeHost());
    ctx.create("group", { name: "Team" }, { id: "g_team", groups: ["g_team"] });
    ctx.create(
      "groupMember",
      { group_id: "g_team", actor_id: "a_admin", permissions: ["issue.*"] },
      { id: "e_member", groups: ["g_team"] },
    );

    expect(() => ctx.update("groupMember", "e_member", { permissions: [] })).toThrow(
      ActionRejectedError,
    );
  });

  it("allows emptying a member while another capable member remains", () => {
    const ctx = testContext(fakeHost());
    ctx.create("group", { name: "Team" }, { id: "g_team", groups: ["g_team"] });
    ctx.create(
      "groupMember",
      { group_id: "g_team", actor_id: "a_admin", permissions: ["issue.*"] },
      { id: "e_admin", groups: ["g_team"] },
    );
    ctx.create(
      "groupMember",
      { group_id: "g_team", actor_id: "a_guest", permissions: ["issue.*"] },
      { id: "e_guest", groups: ["g_team"] },
    );

    expect(() => ctx.update("groupMember", "e_guest", { permissions: [] })).not.toThrow();
  });

  it("defers when the group's roster is not visible to the invocation", () => {
    const ctx = testContext(fakeHost());
    // The group predates the invocation, so its members are unknown.
    ctx.create(
      "groupMember",
      { group_id: "g_stored", actor_id: "a_admin", permissions: [] },
      { id: "e_member", groups: ["g_stored"] },
    );

    expect(() => ctx.delete("groupMember", "e_member")).not.toThrow();
  });
});

describe("missing_ownership", () => {
  const view = {
    groupsOf: () => [],
    groupOfMembership: () => undefined,
    groupMembersOf: () => undefined,
  };

  const unowned: Update = {
    id: "u_1",
    subject_id: "eg_unknown",
    method: "delete",
    data: null,
  };

  it("refuses a membership write that resolves to no owning group", () => {
    const error = (() => {
      try {
        assertMembershipScope(view, "entityGroup", "eg_unknown", [unowned]);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections).toMatchObject([
      { reason: "missing_ownership", details: expect.stringContaining("no owning group") },
    ]);
  });

  it("passes a membership row that names its group", () => {
    const owned: Update[] = [
      {
        id: "u_1_entity",
        subject_id: "eg_1",
        component: "entityGroup/entity_id",
        method: "replace",
        data: { value: "e_1", update_id: "u_1" },
      },
      {
        id: "u_1_group",
        subject_id: "eg_1",
        component: "entityGroup/group_id",
        method: "replace",
        data: { value: "g_1", update_id: "u_1" },
      },
    ];

    expect(() => assertMembershipScope(view, "entityGroup", "eg_1", owned)).not.toThrow();
  });

  it("passes a batch with no membership writes", () => {
    expect(() => assertMembershipScope(view, "issue", "e_1", [])).not.toThrow();
  });

  it("passes every membership row a create emits", () => {
    const ctx = testContext(fakeHost());
    expect(() =>
      ctx.create("issue", issue(), { id: "e_ok", groups: ["g_1", "g_2"] }),
    ).not.toThrow();
  });
});
