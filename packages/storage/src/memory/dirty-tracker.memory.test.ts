import { describe, it, expect } from "vitest";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";

describe("MemoryDirtyTracker", () => {
  describe("mark", () => {
    it("marks an entity as dirty", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      const dirty = await tracker.isDirty("todo_1");
      expect(dirty).toBe(true);
    });

    it("can mark multiple entities", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_2", "todo");
      expect(await tracker.isDirty("todo_1")).toBe(true);
      expect(await tracker.isDirty("todo_2")).toBe(true);
    });

    it("does not duplicate already marked entity", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_1", "todo");
      const dirty = await tracker.getDirtyForType("todo");
      expect(dirty).toHaveLength(1);
    });
  });

  describe("isDirty", () => {
    it("returns false for unknown entity", async () => {
      const tracker = createMemoryDirtyTracker();
      const dirty = await tracker.isDirty("unknown");
      expect(dirty).toBe(false);
    });

    it("returns true for marked entity", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      const dirty = await tracker.isDirty("todo_1");
      expect(dirty).toBe(true);
    });
  });

  describe("getDirtyForType", () => {
    it("returns all dirty entities of a type", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_2", "todo");
      await tracker.mark("doc_1", "document");
      const dirty = await tracker.getDirtyForType("todo");
      expect(dirty).toEqual(["todo_1", "todo_2"]);
    });

    it("returns empty array for unknown type", async () => {
      const tracker = createMemoryDirtyTracker();
      const dirty = await tracker.getDirtyForType("unknown");
      expect(dirty).toEqual([]);
    });
  });

  describe("clear", () => {
    it("clears dirty flag for entity", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.clear("todo_1");
      expect(await tracker.isDirty("todo_1")).toBe(false);
    });

    it("removes entity from type index", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.clear("todo_1");
      const dirty = await tracker.getDirtyForType("todo");
      expect(dirty).toEqual([]);
    });

    it("does nothing for unknown entity", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.clear("unknown");
      expect(await tracker.isDirty("unknown")).toBe(false);
    });
  });

  describe("clearAll", () => {
    it("resets all dirty state", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_2", "todo");
      await tracker.clearAll();
      expect(await tracker.isDirty("todo_1")).toBe(false);
      expect(await tracker.isDirty("todo_2")).toBe(false);
      expect(await tracker.getDirtyForType("todo")).toEqual([]);
    });
  });
});
