/**
 * `@ebbjs/storage/indexeddb` subpath entry.
 *
 * Exposes the IndexedDB-backed `StorageAdapter` only. Requires the
 * `idb` peer dependency to be installed; importing from this
 * subpath without `idb` installed will throw at module load time.
 */
export { createIndexedDBAdapter } from "./indexeddb-adapter";
export type { IndexedDBAdapterOptions } from "./indexeddb-adapter";
