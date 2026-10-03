/**
 * `@ebbjs/storage` (root) entry — types-only.
 *
 * Adapter constructors live under the per-adapter subpaths
 * (`./memory`, `./indexeddb`) so a memory-only consumer does not
 * pay for the IndexedDB code path or the `idb` runtime. The root
 * path remains valid so existing imports of `StorageAdapter`
 * (and other shared types) keep working without a subpath, but
 * runtime adapter imports must move to the per-adapter subpath.
 */
export type { ActionLog } from "./types/action-log";
export type { DirtyTracker } from "./types/dirty-tracker";
export type { EntityStore, RelationshipIndexQuery } from "./types/entity-store";
export type { CursorStore } from "./types/cursor-store";
export type { StorageAdapter } from "./types/storage-adapter";
