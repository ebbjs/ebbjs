import { describe, expect, it } from "vitest";
import { generateId, ID_PREFIX_ACTION, ID_PREFIX_UPDATE } from "./index";

describe("generateId", () => {
  it("produces IDs with correct action prefix format", () => {
    const id = generateId(ID_PREFIX_ACTION);
    expect(id).toMatch(/^a_[a-z0-9]{16}$/);
  });

  it("produces IDs with correct update prefix format", () => {
    const id = generateId(ID_PREFIX_UPDATE);
    expect(id).toMatch(/^u_[a-z0-9]{16}$/);
  });

  it("produces IDs with correct custom prefix format", () => {
    const id = generateId("custom");
    expect(id).toMatch(/^custom_[a-z0-9]{16}$/);
  });

  it("generates unique IDs across many calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId(ID_PREFIX_ACTION)));
    expect(ids.size).toBe(1000);
  });

  it("generates unique IDs for different prefixes", () => {
    const ids = new Set([generateId(ID_PREFIX_ACTION), generateId(ID_PREFIX_UPDATE)]);
    expect(ids.size).toBe(2);
  });

  it("idempotent prefixes are consistent", () => {
    const id = generateId("test");
    expect(id.startsWith("test_")).toBe(true);
    expect(id.length).toBe(5 + 16);
  });
});
