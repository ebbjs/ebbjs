import { describe, expect, it } from "vitest";
import { isUnset, unset } from "@ebbjs/core";
import { defineModel, e, validatePayload } from "@ebbjs/schema";

import { componentUpdates, patchEntity } from "../index";

const task = defineModel("task", {
  title: e.string(),
  dueDate: e.string(),
  tags: e.map(e.string()).default({}),
});

const plan = defineModel("plan", {
  anchor: e.object({ x: e.number(), y: e.number() }),
  tags: e.map(e.string()),
});

/** The id/HLC seam one component write consumes. */
const ids = (updateId = "u1", hlc = "h1") => ({
  updateId: () => updateId,
  hlc,
});

describe("unset — the wire envelope", () => {
  it("compiles a leaf unset to a tombstone with the write's HLC", () => {
    const [write] = componentUpdates(
      "t1",
      "task",
      { dueDate: unset },
      ids(),
      task.markers as never,
    );
    expect(write).toMatchObject({
      subject_id: "t1",
      component: "task/dueDate",
      method: "merge",
      data: { value: null, update_id: "u1", hlc: "h1" },
    });
  });

  it("compiles an unset map entry to a tombstone and keeps its siblings", () => {
    const [write] = componentUpdates(
      "t1",
      "task",
      { tags: { a: unset, b: "kept" } },
      ids(),
      task.markers as never,
    );
    expect(write).toMatchObject({
      component: "task/tags",
      method: "merge",
      data: {
        map: {
          a: { value: null, update_id: "u1", hlc: "h1" },
          b: { value: "kept", update_id: "u1", hlc: "h1" },
        },
      },
    });
  });

  it("still passes a literal null through: other producers send tombstones", () => {
    const [write] = componentUpdates(
      "t1",
      "task",
      { title: null },
      ids(),
      task.markers as never,
    );
    expect(write!.data).toEqual({ value: null, update_id: "u1", hlc: "h1" });
  });

  it("the marker itself never reaches the wire", () => {
    const updates = componentUpdates("t1", "task", { dueDate: unset }, ids());
    expect(JSON.stringify(updates)).not.toContain("unset");
    expect(isUnset((updates[0] as { data: unknown }).data)).toBe(false);
  });
});

describe("unset — nested in an object leaf", () => {
  it("keeps a whole-object leaf in one value envelope", () => {
    const [write] = componentUpdates(
      "p1",
      "plan",
      { anchor: { x: 1, y: 2 } },
      ids(),
      plan.markers as never,
    );

    expect(write).toMatchObject({
      component: "plan/anchor",
      data: { value: { x: 1, y: 2 }, update_id: "u1", hlc: "h1" },
    });
  });

  it("throws for an unset nested in an object leaf, naming the path and e.map", () => {
    expect(() =>
      componentUpdates("p1", "plan", { anchor: { x: 1, y: unset } }, ids(), plan.markers as never),
    ).toThrow(/anchor\.y.*e\.map/);
  });

  it("throws for an unset nested in an array leaf", () => {
    expect(() =>
      componentUpdates("t1", "task", { title: [unset] }, ids(), task.markers as never),
    ).toThrow(/title\[0\].*e\.map/);
  });

  it("still compiles a map field's top-level unset entry to a tombstone", () => {
    const [write] = componentUpdates(
      "p1",
      "plan",
      { tags: { a: unset } },
      ids(),
      plan.markers as never,
    );

    expect(write).toMatchObject({
      component: "plan/tags",
      method: "merge",
      data: { map: { a: { value: null, update_id: "u1", hlc: "h1" } } },
    });
  });

  it("throws for an unset deeper than a map field's entries", () => {
    expect(() =>
      componentUpdates("p1", "plan", { tags: { a: { x: unset } } }, ids(), plan.markers as never),
    ).toThrow(/tags\.a\.x.*e\.map/);
  });
});

describe("unset — validation", () => {
  it("skips an unset value instead of type-checking it (partial)", () => {
    expect(validatePayload(task.shape, { dueDate: unset }, "task", true)).toEqual([]);
  });

  it("counts an unset key as present on a full create", () => {
    expect(
      validatePayload(task.createShape, { title: "x", dueDate: unset }, "task", false),
    ).toEqual([]);
  });

  it("rejects a literal null with a message naming unset (partial)", () => {
    const violations = validatePayload(task.shape, { dueDate: null }, "task", true);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("unset");
  });

  it("rejects a literal null with a message naming unset (full create)", () => {
    const violations = validatePayload(
      task.createShape,
      { title: "x", dueDate: null },
      "task",
      false,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("unset");
  });

  it("a full create still requires a field that is neither present nor unset", () => {
    const violations = validatePayload(task.createShape, { dueDate: "soon" }, "task", false);
    expect(violations.some((v) => v.field === "title")).toBe(true);
  });

  it("the committed patch operation carries an unset to the envelope", () => {
    const context = {
      ids: { updateId: () => "u1", hlc: () => "h1" },
      registry: { get: () => task },
    } as never;
    const result = patchEntity(context, {
      entity: "task",
      id: "t1",
      payload: { dueDate: unset },
      groups: ["g1"],
      validate: false,
    } as never);
    expect(result.updates[0]?.data).toEqual({
      value: null,
      update_id: "u1",
      hlc: "h1",
    });
  });
});
