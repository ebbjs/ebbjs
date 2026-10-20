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

      it("returns null for a group that only holds a seed marker", async () => {
        const store = await factory();
        await store.setRecord("group_1", { seed: { group_id: "group_1" } });
        expect(await store.get("group_1")).toBe(null);
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

      it("keeps a seed marker in flight", async () => {
        const store = await factory();
        const seed = { group_id: "group_1", w: 42, token: "page-2" };
        await store.setRecord("group_1", { seed });
        await store.set("group_1", 7);

        expect(await store.getRecord("group_1")).toEqual({ cursor: 7, seed });
      });
    });

    describe("getRecord / setRecord", () => {
      it("returns null for unknown group", async () => {
        const store = await factory();
        expect(await store.getRecord("group_1")).toBe(null);
      });

      it("stores the cursor and the seed marker together", async () => {
        const store = await factory();
        const seed = { group_id: "group_1", w: 12, token: "tok" };
        await store.setRecord("group_1", { cursor: 3, seed });

        expect(await store.getRecord("group_1")).toEqual({ cursor: 3, seed });
        expect(await store.get("group_1")).toBe(3);
      });

      it("replaces the whole record, clearing an omitted seed", async () => {
        const store = await factory();
        await store.setRecord("group_1", { seed: { group_id: "group_1", w: 9 } });
        await store.setRecord("group_1", { cursor: 9 });

        expect(await store.getRecord("group_1")).toEqual({ cursor: 9 });
      });

      it("drops the record when it holds nothing", async () => {
        const store = await factory();
        await store.set("group_1", 5);
        await store.setRecord("group_1", {});

        expect(await store.getRecord("group_1")).toBe(null);
        expect((await store.records()).has("group_1")).toBe(false);
      });

      it("keeps groups independent", async () => {
        const store = await factory();
        await store.setRecord("group_1", { cursor: 1, seed: { group_id: "group_1" } });
        await store.set("group_2", 2);

        expect(await store.getRecord("group_1")).toEqual({
          cursor: 1,
          seed: { group_id: "group_1" },
        });
        expect(await store.getRecord("group_2")).toEqual({ cursor: 2 });
      });
    });

    describe("records", () => {
      it("returns every group's record", async () => {
        const store = await factory();
        await store.set("group_1", 100);
        await store.setRecord("group_2", { seed: { group_id: "group_2", w: 4, token: "t" } });

        const records = await store.records();
        expect([...records.keys()].sort()).toEqual(["group_1", "group_2"]);
        expect(records.get("group_1")).toEqual({ cursor: 100 });
        expect(records.get("group_2")).toEqual({
          seed: { group_id: "group_2", w: 4, token: "t" },
        });
      });

      it("is empty before anything is written", async () => {
        const store = await factory();
        expect((await store.records()).size).toBe(0);
      });
    });

    describe("clear", () => {
      it("drops every group's cursor and seed", async () => {
        const store = await factory();
        await store.set("group_1", 100);
        await store.setRecord("group_2", { seed: { group_id: "group_2", w: 1 } });

        await store.clear();

        expect((await store.records()).size).toBe(0);
        expect(await store.get("group_1")).toBe(null);
        expect(await store.getRecord("group_2")).toBe(null);
      });
    });
  });
};
