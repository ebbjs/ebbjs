import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { fieldsOf, onlyUpdate, projectFieldValue, projectUpdate, updatesOfType } from "./index";

const hlc = makeHlc(1_711_036_800_000, 0);

const leaf = (value: unknown): FieldValue => ({ value, update_id: "u_1", hlc });

const update = (
  subjectId: string,
  subjectType: string,
  data: Update["data"],
  method: Update["method"] = "put",
): Update => ({
  id: `u_${subjectId}`,
  subject_id: subjectId,
  subject_type: subjectType,
  method,
  data,
});

const actionWith = (updates: readonly Update[]): Action => ({
  id: "a_1",
  actor_id: "alice",
  hlc,
  gsn: 1,
  updates: [...updates],
});

describe("fieldsOf", () => {
  it("asserts field values without peeling `.value`", () => {
    const action = actionWith([
      update("ws_alice", "workspace", {
        fields: {
          name: leaf("alice's Workspace"),
          slug: leaf("alice"),
        },
      }),
    ]);

    expect(fieldsOf(action, "ws_alice")).toEqual({
      name: "alice's Workspace",
      slug: "alice",
    });
  });

  it("throws when no Update targets the subject", () => {
    const action = actionWith([
      update("ws_alice", "workspace", { fields: { name: leaf("Alice") } }),
    ]);

    expect(() => fieldsOf(action, "ws_missing")).toThrow(/expected exactly one Update/);
  });

  it("throws when more than one Update targets the subject", () => {
    const action = actionWith([
      update("ws_alice", "workspace", { fields: { name: leaf("Alice") } }),
      update("ws_alice", "workspace", { fields: { slug: leaf("alice") } }, "patch"),
    ]);

    expect(() => onlyUpdate(action, "ws_alice")).toThrow(/found 2/);
  });
});

describe("projectUpdate", () => {
  it("recursively unwraps a map field and drops tombstoned keys", () => {
    const action = actionWith([
      update("prof_alice", "profile", {
        fields: {
          prefs: { map: { theme: leaf("dark"), removed: leaf(null) } },
        },
      }),
    ]);

    expect(projectUpdate(onlyUpdate(action, "prof_alice"))).toEqual({
      prefs: { theme: "dark" },
    });
  });

  it("returns an empty field map for a delete Update", () => {
    expect(projectUpdate(update("ws_alice", "workspace", null, "delete"))).toEqual({});
  });
});

describe("updatesOfType", () => {
  it("filters Updates by subject type in action order", () => {
    const action = actionWith([
      update("grp_alice", "group", { fields: { name: leaf("alice") } }),
      update("ws_alice", "workspace", { fields: { name: leaf("alice") } }),
      update("gm_alice", "groupMember", { fields: { actor_id: leaf("alice") } }),
    ]);

    expect(updatesOfType(action, "group").map((entry) => entry.subject_id)).toEqual(["grp_alice"]);
    expect(updatesOfType(action, "workspace")).toHaveLength(1);
    expect(updatesOfType(action, "issue")).toEqual([]);
  });
});

describe("projectFieldValue", () => {
  it("is re-exported so tests project a single field without re-implementing it", () => {
    expect(projectFieldValue(leaf("dark"))).toBe("dark");
    expect(projectFieldValue({ map: { theme: leaf("dark"), gone: leaf(null) } })).toEqual({
      theme: "dark",
    });
  });
});
