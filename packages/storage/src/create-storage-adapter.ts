import type { StorageAdapter } from "./types/storage-adapter";
import { createMemoryAdapter } from "./memory/memory-adapter";

/**
 * Detects whether the current runtime is a browser-like environment
 * that ships `indexedDB`. Used by `createStorageAdapter()` to pick the
 * IndexedDB adapter as the default on web.
 */
const hasIndexedDB = (): boolean => {
  return typeof globalThis !== "undefined" && "indexedDB" in globalThis;
};

export interface CreateStorageAdapterOptions {
  /**
   * Override adapter selection. When omitted, `createStorageAdapter`
   * picks the IndexedDB adapter if the runtime has it, otherwise the
   * in-memory adapter.
   */
  prefer?: "memory" | "indexeddb" | "auto";
}

/**
 * Returns a `StorageAdapter` appropriate for the runtime.
 *
 * Resolution order:
 * - `prefer: "memory"` — always the in-memory adapter.
 * - `prefer: "indexeddb"` — always the IndexedDB adapter.
 * - `prefer: "auto"` (default) — IndexedDB on web, in-memory everywhere else.
 *
 * Async because the IndexedDB factory opens a database; `await` even
 * when the runtime ends up on the in-memory adapter.
 */
export const createStorageAdapter = async (
  options: CreateStorageAdapterOptions = {},
): Promise<StorageAdapter> => {
  const preference = options.prefer ?? "auto";
  const wantIndexedDB = preference === "indexeddb" || (preference === "auto" && hasIndexedDB());

  if (wantIndexedDB) {
    const { createIndexedDBAdapter } = await import("./indexeddb/indexeddb-adapter");
    return createIndexedDBAdapter();
  }

  return createMemoryAdapter();
};
