import { describe, expect, it } from "vitest";
import { createStorageAdapter } from "./create-storage-adapter";
import { createMemoryAdapter } from "./memory/memory-adapter";

describe("createStorageAdapter", () => {
  it("returns the in-memory adapter when prefer is 'memory'", async () => {
    const adapter = await createStorageAdapter({ prefer: "memory" });
    expect(typeof adapter.actions.append).toBe("function");
    expect(typeof adapter.entities.get).toBe("function");
  });

  it("returns a memory-shaped adapter under happy-dom+fake-indexeddb when prefer is 'memory'", async () => {
    const adapter = await createStorageAdapter({ prefer: "memory" });
    const m = createMemoryAdapter();
    expect(Object.keys(adapter).sort()).toEqual(Object.keys(m).sort());
  });

  it("returns the IndexedDB adapter when prefer is 'indexeddb'", async () => {
    const adapter = await createStorageAdapter({ prefer: "indexeddb" });
    expect(typeof adapter.actions.append).toBe("function");
    expect(typeof adapter.entities.get).toBe("function");
    expect(typeof adapter.cursors.set).toBe("function");
    expect(typeof adapter.dirtyTracker.mark).toBe("function");
  });

  it("returns the IndexedDB adapter by default when indexedDB is present", async () => {
    const adapter = await createStorageAdapter();
    expect(typeof adapter.actions.append).toBe("function");
    expect(typeof adapter.entities.get).toBe("function");
  });
});
