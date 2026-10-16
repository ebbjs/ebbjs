/**
 * Unit tests for the membership checker — the client-side resolution of
 * a system write's fan-out group set, and the `last_membership` net
 * delta that mirrors the server's #264 rule.
 */

import { describe, expect, it } from "vitest";
import type { Update } from "@ebbjs/core";

import {
  SYSTEM_ENTITY_TYPES,
  isSystemEntityType,
  isSystemOnly,
  isSystemUpdate,
  lastMembershipViolation,
  membershipScope,
  resolveUpdateGroups,
  resultingGroups,
  type MembershipView,
} from "../membership";

const view = (overrides: Partial<MembershipView> = {}): MembershipView => ({
  groupsOf: () => [],
  groupOfMembership: () => undefined,
  ...overrides,
});

interface UpdateSpec {
  readonly subject_id: string;
  readonly subject_type: string;
  readonly method?: Update["method"];
  readonly fields?: Record<string, unknown>;
}

const update = (spec: UpdateSpec): Update => ({
  id: "u_1",
  subject_id: spec.subject_id,
  subject_type: spec.subject_type,
  method: spec.method ?? "put",
  data:
    spec.fields === undefined
      ? null
      : {
          fields: Object.fromEntries(
            Object.entries(spec.fields).map(([key, value]) => [key, { value, update_id: "u_1" }]),
          ),
        },
});

describe("membership checker — system classification", () => {
  it("names the server's system entity types", () => {
    expect([...SYSTEM_ENTITY_TYPES]).toEqual([
      "group",
      "groupMember",
      "relationship",
      "entityGroup",
    ]);
  });

  it("classifies a batch as system-only only when every update is system", () => {
    const system = update({ subject_id: "eg_1", subject_type: "entityGroup" });
    const content = update({ subject_id: "todo_1", subject_type: "todo" });
    expect(isSystemUpdate(system)).toBe(true);
    expect(isSystemUpdate(content)).toBe(false);
    expect(isSystemEntityType("todo")).toBe(false);
    expect(isSystemOnly([system])).toBe(true);
    expect(isSystemOnly([system, content])).toBe(false);
    expect(isSystemOnly([])).toBe(true);
  });
});

describe("membership checker — fan-out scope", () => {
  it("resolves a group to its own id", () => {
    const scope = resolveUpdateGroups(update({ subject_id: "g_1", subject_type: "group" }), view());
    expect(scope).toEqual(["g_1"]);
  });

  it("resolves a groupMember to its wired group_id", () => {
    const scope = resolveUpdateGroups(
      update({
        subject_id: "gm_1",
        subject_type: "groupMember",
        fields: { group_id: "g_2" },
      }),
      view(),
    );
    expect(scope).toEqual(["g_2"]);
  });

  it("resolves an entityGroup put to its wired group_id", () => {
    const scope = resolveUpdateGroups(
      update({
        subject_id: "eg_1",
        subject_type: "entityGroup",
        fields: { entity_id: "todo_1", group_id: "g_3" },
      }),
      view(),
    );
    expect(scope).toEqual(["g_3"]);
  });

  it("resolves an entityGroup delete through the membership row's group", () => {
    const scope = resolveUpdateGroups(
      update({ subject_id: "eg_1", subject_type: "entityGroup", method: "delete" }),
      view({ groupOfMembership: (id) => (id === "eg_1" ? "g_4" : undefined) }),
    );
    expect(scope).toEqual(["g_4"]);
  });

  it("resolves a relationship through its source's groups", () => {
    const scope = resolveUpdateGroups(
      update({
        subject_id: "rel_1",
        subject_type: "relationship",
        fields: { source_id: "todo_1" },
      }),
      view({ groupsOf: (id) => (id === "todo_1" ? ["g_5", "g_6"] : []) }),
    );
    expect(scope).toEqual(["g_5", "g_6"]);
  });

  it("returns an empty scope when the subject cannot be resolved", () => {
    expect(
      resolveUpdateGroups(
        update({ subject_id: "eg_1", subject_type: "entityGroup", method: "delete" }),
        view(),
      ),
    ).toEqual([]);
    expect(
      resolveUpdateGroups(update({ subject_id: "rel_1", subject_type: "relationship" }), view()),
    ).toEqual([]);
    expect(
      resolveUpdateGroups(update({ subject_id: "todo_1", subject_type: "todo" }), view()),
    ).toEqual([]);
  });

  it("unions a batch's scopes, sorted and de-duplicated", () => {
    const scope = membershipScope(
      [
        update({
          subject_id: "eg_1",
          subject_type: "entityGroup",
          fields: { group_id: "g_2" },
        }),
        update({ subject_id: "eg_2", subject_type: "entityGroup", method: "delete" }),
        update({
          subject_id: "eg_3",
          subject_type: "entityGroup",
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
