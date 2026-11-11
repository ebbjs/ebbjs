/**
 * `mergeFieldValue` is the protocol's merge rule: the shape the server and
 * every client materializer reproduce. These pin the parts the shared
 * fixture vectors cannot express — that an object leaf is one merge
 * position, and that a losing patch keeps the existing value by reference
 * so a caller can detect a no-op without scanning it.
 *
 * The exact winner for each shape lives in `field-merge.vectors.test.ts`,
 * driven by the cross-package fixture.
 */

import { describe, expect, it } from "vitest";

import { mergeFieldValue, type FieldValue } from "./action";

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

describe("mergeFieldValue — an object leaf", () => {
  const authoredA = leaf({ x: 1, y: 2 }, "1", "u_a");
  const authoredB = leaf({ x: 9, y: 9 }, "2", "u_b");

  it("converges on one authored object in both apply orders", () => {
    expect(mergeFieldValue(authoredA, authoredB)).toEqual(authoredB);
    expect(mergeFieldValue(authoredB, authoredA)).toEqual(authoredB);
  });

  it("breaks an equal HLC by update_id and still picks one authored object", () => {
    const a = leaf({ x: 1, y: 2 }, "1", "u_a");
    const b = leaf({ x: 9, y: 9 }, "1", "u_b");

    expect(mergeFieldValue(a, b)).toEqual(b);
    expect(mergeFieldValue(b, a)).toEqual(b);
  });
});

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

  it("returns the existing map when the incoming map is empty", () => {
    const existing: FieldValue = { map: { a: leaf("a", "1", "u_a") } };
    expect(mergeFieldValue(existing, { map: {} })).toBe(existing);
  });

  it("reuses the existing value when a nested map patch is a no-op", () => {
    const inner: FieldValue = { map: { x: leaf("x", "5", "u_x") } };
    const existing: FieldValue = { map: { outer: inner } };
    const incoming: FieldValue = { map: { outer: { map: { x: leaf("x2", "1", "u_x2") } } } };

    expect(mergeFieldValue(existing, incoming)).toBe(existing);
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
});
