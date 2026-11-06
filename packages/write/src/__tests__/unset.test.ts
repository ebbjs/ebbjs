import { describe, expect, it } from "vitest";
import { isUnset, unset } from "@ebbjs/core";
import { defineEntity, e, validatePayload } from "@ebbjs/schema";

import { patchEntity, wrapFields } from "../index";

const task = defineEntity("task", {
  title: e.string(),
  dueDate: e.string(),
  tags: e.map(e.string()).default({}),
});

describe("unset — the wire envelope", () => {
  it("compiles a leaf unset to a tombstone with the write's HLC", () => {
    const fields = wrapFields({ dueDate: unset }, "u1", "h1", task.fields as never);
    expect(fields.dueDate).toEqual({ value: null, update_id: "u1", hlc: "h1" });
  });

  it("compiles an unset map entry to a tombstone and keeps its siblings", () => {
    const fields = wrapFields({ tags: { a: unset, b: "kept" } }, "u1", "h1", task.fields as never);
    expect(fields.tags).toEqual({
      map: {
        a: { value: null, update_id: "u1", hlc: "h1" },
        b: { value: "kept", update_id: "u1", hlc: "h1" },
      },
    });
  });

  it("still passes a literal null through: other producers send tombstones", () => {
    const fields = wrapFields({ title: null }, "u1", "h1", task.fields as never);
    expect(fields.title).toEqual({ value: null, update_id: "u1", hlc: "h1" });
  });

  it("the marker itself never reaches the wire", () => {
    const fields = wrapFields({ dueDate: unset }, "u1", "h1");
    expect(JSON.stringify(fields)).not.toContain("unset");
    expect(isUnset(fields.dueDate)).toBe(false);
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
    expect(result.updates[0]?.data?.fields.dueDate).toEqual({
      value: null,
      update_id: "u1",
      hlc: "h1",
    });
  });
});
