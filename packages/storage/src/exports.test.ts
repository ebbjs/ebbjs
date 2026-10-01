import { describe, expect, it } from "vitest";

/**
 * Pin the per-adapter subpath shape described in issue #203.
 * Each subpath must import cleanly and expose exactly the surface
 * documented in the issue:
 *
 *   @ebbjs/storage/memory     — createMemoryAdapter
 *   @ebbjs/storage/indexeddb  — createIndexedDBAdapter, IndexedDBAdapterOptions
 *   @ebbjs/storage/types      — ActionLog, DirtyTracker, EntityStore, CursorStore, StorageAdapter
 */

describe("@ebbjs/storage subpaths", () => {
  it("@ebbjs/storage/memory re-exports createMemoryAdapter", async () => {
    const mod = await import("./memory/index");
    expect(typeof mod.createMemoryAdapter).toBe("function");
    expect(Object.keys(mod).sort()).toEqual(["createMemoryAdapter"]);
  });

  it("@ebbjs/storage/indexeddb re-exports createIndexedDBAdapter and IndexedDBAdapterOptions", async () => {
    const mod = await import("./indexeddb/index");
    expect(typeof mod.createIndexedDBAdapter).toBe("function");
    // IndexedDBAdapterOptions is type-only; we check the runtime surface
    expect(Object.keys(mod).sort()).toEqual(["createIndexedDBAdapter"]);
  });

  it("@ebbjs/storage/types re-exports the five public types as type-only", async () => {
    // Type-only exports have no runtime presence; the module surface is empty.
    const mod = await import("./types/index");
    expect(Object.keys(mod)).toEqual([]);
  });
});

describe("@ebbjs/storage memory bundle isolation", () => {
  it("memory entry module does not reference idb or indexedDB in its source", async () => {
    // Source-level check: read the file and assert the strings are absent.
    // (A build-level check is in scripts/bundle-check.ts.)
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(import.meta.url);
    const memoryIndexPath = `${here.replace(/\/[^/]+$/, "")}/memory/index.ts`;
    const src = await readFile(memoryIndexPath, "utf8");
    expect(src).not.toMatch(/from\s+["']idb["']/);
    expect(src).not.toMatch(/indexedDB/);
  });
});
