import { describe, expect, it } from "vitest";

import { KEY_SEP, keyOf, PATH_SEP } from "./keys";

describe("keyOf", () => {
  it("joins parts with the key separator", () => {
    expect(keyOf("subject", "model/field")).toBe(`subject${KEY_SEP}model/field`);
  });

  it("joins an ordered list part with the path separator", () => {
    expect(keyOf("subject", "model/field", ["a", "b"])).toBe(
      `subject${KEY_SEP}model/field${KEY_SEP}a${PATH_SEP}b`,
    );
    expect(keyOf("subject", "model/field", [])).toBe(`subject${KEY_SEP}model/field${KEY_SEP}`);
  });

  it("keeps a part that contains a separator distinct from two parts", () => {
    // The defect a bare join has: an aliased key answers for the wrong entry.
    expect(keyOf(`a${KEY_SEP}b`, "c")).not.toBe(keyOf("a", `b${KEY_SEP}c`));
    expect(keyOf(`a${PATH_SEP}b`, "c")).not.toBe(keyOf("a", `b${PATH_SEP}c`));
    expect(keyOf(["a", "b"])).not.toBe(keyOf([`a${PATH_SEP}b`]));
  });

  it("keeps the escape character unambiguous", () => {
    expect(keyOf("a\\", KEY_SEP)).not.toBe(keyOf("a", `\\${KEY_SEP}`));
    expect(keyOf("a\\0b")).not.toBe(keyOf(`a${KEY_SEP}b`));
  });

  it("is stable for the same tuple", () => {
    expect(keyOf("x", "y", ["z"])).toBe(keyOf("x", "y", ["z"]));
  });
});
