/**
 * An object leaf is one merge position (#796). Two concurrent writes of a
 * whole object converge on exactly one authored value in both apply orders;
 * the merge never synthesizes a value from both.
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

  it("converges on the newer authored object in both apply orders", () => {
    expect(mergeFieldValue(authoredA, authoredB)).toEqual(authoredB);
    expect(mergeFieldValue(authoredB, authoredA)).toEqual(authoredB);
  });

  it("never synthesizes a value from both objects", () => {
    const merged = mergeFieldValue(authoredA, authoredB);

    expect(merged).not.toEqual(leaf({ x: 9, y: 2 }, "2", "u_b"));
    expect(merged).not.toEqual(leaf({ x: 1, y: 9 }, "2", "u_b"));
  });

  it("breaks an equal HLC by update_id and still picks one authored object", () => {
    const a = leaf({ x: 1, y: 2 }, "1", "u_a");
    const b = leaf({ x: 9, y: 9 }, "1", "u_b");

    expect(mergeFieldValue(a, b)).toEqual(b);
    expect(mergeFieldValue(b, a)).toEqual(b);
  });
});
