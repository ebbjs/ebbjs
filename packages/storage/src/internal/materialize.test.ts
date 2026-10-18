import { describe, expect, it } from "vitest";
import type { Entity, FieldValue, Update } from "@ebbjs/core";
import { applyUpdate, mergeFields } from "./materialize";

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

const entity = (): Entity => ({
  id: "doc_1",
  type: "doc",
  data: {
    fields: {
      content: { map: { a: leaf("a", "1", "u_a"), b: leaf("b", "1", "u_b") } },
    },
  },
  created_hlc: "1",
  updated_hlc: "5",
  deleted_hlc: null,
  last_gsn: 1,
});

const patch = (content: FieldValue): Update => ({
  id: "upd_1",
  subject_id: "doc_1",
  subject_type: "doc",
  method: "patch",
  data: { fields: { content } },
});

/**
 * A patch that changes nothing must not allocate a new field map, so the
 * read model can use `data` reference identity as its change signal instead
 * of rescanning the map.
 */
describe("mergeFields reference reuse", () => {
  it("returns the existing data when the patch loses", () => {
    const base = entity();
    const update = patch({ map: { a: leaf("x", "0", "u_x") } });
    expect(mergeFields(base.data, update)).toBe(base.data);
  });

  it("returns new data when a key wins", () => {
    const base = entity();
    const update = patch({ map: { a: leaf("new", "9", "u_x") } });
    const merged = mergeFields(base.data, update);

    expect(merged).not.toBe(base.data);
    expect(merged.fields.content).not.toBe(base.data.fields.content);
    expect(merged).toEqual({
      fields: {
        content: { map: { a: leaf("new", "9", "u_x"), b: leaf("b", "1", "u_b") } },
      },
    });
  });
});

describe("applyUpdate reference reuse", () => {
  it("reuses the data object on a losing patch while advancing bookkeeping", () => {
    const base = entity();
    const next = applyUpdate(base, patch({ map: { a: leaf("x", "0", "u_x") } }), 2, "0");

    expect(next).not.toBeNull();
    expect(next!.data).toBe(base.data);
    // The delivery cursor still advances; only observable content is reused.
    expect(next!.last_gsn).toBe(2);
    expect(next!.updated_hlc).toBe("5");
  });

  it("produces new data on a winning patch and keeps the result LWW-correct", () => {
    const base = entity();
    const next = applyUpdate(base, patch({ map: { a: leaf("new", "9", "u_x") } }), 2, "9");

    expect(next!.data).not.toBe(base.data);
    expect(next).toEqual({
      ...base,
      data: {
        fields: {
          content: { map: { a: leaf("new", "9", "u_x"), b: leaf("b", "1", "u_b") } },
        },
      },
      updated_hlc: "9",
      last_gsn: 2,
    });
  });
});
