/**
 * `@ebbjs/storage/memory` subpath entry.
 *
 * Exposes the in-memory `StorageAdapter` only. Tree-shaking
 * guarantee: this entry does not import `idb` and has no static
 * dependency on the IndexedDB adapter, so a consumer who only
 * imports from this subpath will not pull `idb` into their bundle.
 */
export { createMemoryAdapter } from "./memory-adapter";
