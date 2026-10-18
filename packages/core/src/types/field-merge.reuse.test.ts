import { describe, expect, it } from "vitest";
import { mergeFieldValue, type FieldValue } from "./action";

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

/**
 * The merge copies a map only when a key changes. These pin the
 * reference-identity convention callers use to detect a no-op without a
 * structural scan: a losing patch returns the existing value unchanged.
 */
describe("mergeFieldValue reference reuse", () => {
  it("returns the existing leaf when the incoming leaf loses", () => {
    const existing = leaf("old", "2", "u_a");
    expect(mergeFieldValue(existing, leaf("new", "1", "u_b"))).toBe(existing);
  });

  it("returns the incoming leaf when it wins", () => {
    const existing = leaf("old", "1", "u_a");
    const incoming = leaf("new", "2", "u_b");
    expect(mergeFieldValue(existing, incoming)).toBe(incoming);
  });

  it("returns the existing map when every incoming key loses", () => {
    const existing: FieldValue = {
      map: { a: leaf("a", "5", "u_a"), b: leaf("b", "5", "u_b") },
    };
    const incoming: FieldValue = { map: { a: leaf("x", "1", "u_x") } };
    expect(mergeFieldValue(existing, incoming)).toBe(existing);
  });

  it("returns the existing map when the incoming map is empty", () => {
    const existing: FieldValue = { map: { a: leaf("a", "1", "u_a") } };
    expect(mergeFieldValue(existing, { map: {} })).toBe(existing);
  });

  it("copies only on a winning key and reuses untouched siblings", () => {
    const sibling = leaf("keep", "1", "u_b");
    const existing: FieldValue = { map: { a: leaf("old", "1", "u_a"), b: sibling } };
    const incoming: FieldValue = { map: { a: leaf("new", "2", "u_c") } };

    const merged = mergeFieldValue(existing, incoming);
    expect(merged).not.toBe(existing);
    expect(merged).toEqual({ map: { a: leaf("new", "2", "u_c"), b: sibling } });
    if (!("map" in merged)) throw new Error("expected a map");
    expect(merged.map.b).toBe(sibling);
  });

  it("returns a new map when a key is added", () => {
    const existing: FieldValue = { map: { a: leaf("a", "1", "u_a") } };
    const incoming: FieldValue = { map: { b: leaf("b", "2", "u_b") } };

    const merged = mergeFieldValue(existing, incoming);
    expect(merged).not.toBe(existing);
    expect(merged).toEqual({
      map: { a: leaf("a", "1", "u_a"), b: leaf("b", "2", "u_b") },
    });
  });

  it("reuses the existing value when a nested map patch is a no-op", () => {
    const inner: FieldValue = { map: { x: leaf("x", "5", "u_x") } };
    const existing: FieldValue = { map: { outer: inner } };
    const incoming: FieldValue = { map: { outer: { map: { x: leaf("x2", "1", "u_x2") } } } };

    expect(mergeFieldValue(existing, incoming)).toBe(existing);
  });
});
