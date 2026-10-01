import type { StorageAdapter } from "../types/storage-adapter";
import { defineAdapterTests } from "../testing/adapter.test-suite";
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
