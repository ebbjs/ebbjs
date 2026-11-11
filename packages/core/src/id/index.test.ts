import { describe, expect, it } from "vitest";
import { generateId, ID_PREFIX_ACTION, ID_PREFIX_UPDATE } from "./index";

describe("generateId", () => {
  it.each([ID_PREFIX_ACTION, ID_PREFIX_UPDATE, "custom"])(
    "namespaces the id under the %s prefix",
    (prefix) => {
      expect(generateId(prefix)).toMatch(new RegExp(`^${prefix}_[a-z0-9]{16}$`));
    },
  );

  it("generates unique IDs across many calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId(ID_PREFIX_ACTION)));
    expect(ids.size).toBe(1000);
  });
});
