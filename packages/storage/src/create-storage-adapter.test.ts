import { describe, expect, it } from "vitest";
import { createStorageAdapter } from "./create-storage-adapter";
import { createMemoryAdapter } from "./memory/memory-adapter";
import { buildPutAction } from "./testing/fixtures";

describe("createStorageAdapter", () => {
  it("returns a fresh in-memory adapter when prefer is 'memory'", async () => {
    const first = await createStorageAdapter({ prefer: "memory" });
    await first.actions.append(buildPutAction());

    const second = await createStorageAdapter({ prefer: "memory" });
    // The IndexedDB adapter reopens one shared database; a memory adapter is
    // fresh per call. This is what distinguishes the two selections.
    expect(await second.actions.getAll()).toEqual([]);
    expect(Object.keys(second).sort()).toEqual(Object.keys(createMemoryAdapter()).sort());
  });

  it("returns the IndexedDB adapter when prefer is 'indexeddb'", async () => {
    const adapter = await createStorageAdapter({ prefer: "indexeddb" });
    expect(typeof adapter.actions.append).toBe("function");
    expect(typeof adapter.entities.get).toBe("function");
    expect(typeof adapter.cursors.set).toBe("function");
    expect(typeof adapter.dirtyTracker.mark).toBe("function");
    expect(typeof adapter.outbox.put).toBe("function");
  });

  it("returns the IndexedDB adapter by default when indexedDB is present", async () => {
    const adapter = await createStorageAdapter();
    expect(typeof adapter.actions.append).toBe("function");
    expect(typeof adapter.entities.get).toBe("function");
  });
});
