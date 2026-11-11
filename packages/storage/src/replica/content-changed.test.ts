import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";

import { contentChanged } from "./content-changed";

const leaf = (value: unknown, updateId: string, ms: number): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

const map = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  id: "e_1",
  type: "todo",
  data: { fields: {} },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
  ...overrides,
});

describe("contentChanged", () => {
  it("is false for the same reference and true for absence", () => {
    const row = entity();
    expect(contentChanged(row, row)).toBe(false);
    expect(contentChanged(undefined, undefined)).toBe(false);
    expect(contentChanged(null, undefined)).toBe(false);
    expect(contentChanged(row, undefined)).toBe(true);
  });

  it("ignores a last_gsn-only change", () => {
    const row = entity();
    expect(contentChanged(row, { ...row, last_gsn: 99 })).toBe(false);
  });

  it("detects type, exists, created_hlc, updated_hlc, deleted_hlc and field changes", () => {
    const row = entity();
    expect(contentChanged(row, { ...row, type: "note" })).toBe(true);
    expect(contentChanged(row, { ...row, exists: false })).toBe(true);
    expect(contentChanged(row, { ...row, created_hlc: null })).toBe(true);
    expect(contentChanged(row, { ...row, updated_hlc: makeHlc(9) })).toBe(true);
    expect(contentChanged(row, { ...row, deleted_hlc: makeHlc(9) })).toBe(true);
    expect(contentChanged(row, { ...row, data: { fields: { title: leaf("x", "u_x", 1) } } })).toBe(
      true,
    );
  });

  it("sees through a touched key while sharing untouched siblings", () => {
    const shared = leaf("a", "u_a", 1);
    const before = entity({
      data: { fields: { content: map({ a: shared, b: leaf("b", "u_b", 1) }) } },
    });
    const after = entity({
      data: { fields: { content: map({ a: shared, b: leaf("b2", "u_b2", 2) }) } },
    });
    expect(contentChanged(before, after)).toBe(true);
    expect(contentChanged(before, before)).toBe(false);
  });
});
