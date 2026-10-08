import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../types/storage-adapter";
import { defineAdapterTests } from "../testing/adapter.test-suite";
import { buildConflictEntry } from "../testing/fixtures";
import { createIndexedDBAdapter, type IndexedDBAdapterOptions } from "./indexeddb-adapter";

/**
 * Each test gets a uniquely-named IndexedDB database so they cannot
 * collide with one another. fake-indexeddb (loaded via test-setup.ts)
 * installs the API on globalThis; happy-dom supplies the surrounding
 * DOM globals.
 */
let adapterCount = 0;

const factory = async (): Promise<StorageAdapter> => {
  const dbName = `ebb-adapter-${Date.now()}-${++adapterCount}`;
  const options: IndexedDBAdapterOptions = { dbName };
  return createIndexedDBAdapter(options);
};

defineAdapterTests({
  name: "IndexedDB",
  factory,
});

describe("IndexedDB adapter persistence", () => {
  it("keeps conflicts across an adapter reopen", async () => {
    const dbName = `ebb-adapter-reload-${Date.now()}-${++adapterCount}`;
    const entry = buildConflictEntry();

    const first = await createIndexedDBAdapter({ dbName });
    await first.conflicts.put(entry);

    const reopened = await createIndexedDBAdapter({ dbName });

    expect(await reopened.conflicts.get(entry.action.id)).toEqual(entry);
  });
});
