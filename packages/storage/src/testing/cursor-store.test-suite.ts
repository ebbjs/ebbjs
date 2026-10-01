import { describe, expect, it } from "vitest";
import type { CursorStore } from "../types/cursor-store";

export interface CursorStoreTestSuiteOptions {
  name: string;
  factory: () => Promise<CursorStore> | CursorStore;
}

export const defineCursorStoreTests = ({ name, factory }: CursorStoreTestSuiteOptions): void => {
  describe(`${name} CursorStore`, () => {
    describe("get", () => {
      it("returns null for unknown group", async () => {
        const store = await factory();
        const cursor = await store.get("group_1");
        expect(cursor).toBe(null);
      });
    });

    describe("set", () => {
      it("stores cursor for group", async () => {
        const store = await factory();
        await store.set("group_1", 100);
        const cursor = await store.get("group_1");
        expect(cursor).toBe(100);
      });

      it("updates existing cursor", async () => {
        const store = await factory();
        await store.set("group_1", 100);
        await store.set("group_1", 200);
        const cursor = await store.get("group_1");
        expect(cursor).toBe(200);
      });

      it("can store multiple group cursors", async () => {
        const store = await factory();
        await store.set("group_1", 100);
        await store.set("group_2", 200);
        expect(await store.get("group_1")).toBe(100);
        expect(await store.get("group_2")).toBe(200);
      });

      it("accepts cursor value 0 (falsy boundary)", async () => {
        const store = await factory();
        await store.set("group_1", 0);
        const cursor = await store.get("group_1");
        expect(cursor).toBe(0);
      });
    });
  });
};
