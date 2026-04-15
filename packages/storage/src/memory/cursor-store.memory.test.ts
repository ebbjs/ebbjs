import { describe, it, expect } from "vitest";
import { createMemoryCursorStore } from "./cursor-store.memory";

describe("MemoryCursorStore", () => {
  describe("get", () => {
    it("returns null for unknown group", async () => {
      const store = createMemoryCursorStore();
      const cursor = await store.get("group_1");
      expect(cursor).toBe(null);
    });
  });

  describe("set", () => {
    it("stores cursor for group", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      const cursor = await store.get("group_1");
      expect(cursor).toBe(100);
    });

    it("updates existing cursor", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      await store.set("group_1", 200);
      const cursor = await store.get("group_1");
      expect(cursor).toBe(200);
    });

    it("can store multiple group cursors", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      await store.set("group_2", 200);
      expect(await store.get("group_1")).toBe(100);
      expect(await store.get("group_2")).toBe(200);
    });
  });
});
