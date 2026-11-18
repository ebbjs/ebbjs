/**
 * `@ebbjs/storage` (root) entry — types-only.
 *
 * Adapter constructors live under the per-adapter subpaths
 * (`./memory`, `./indexeddb`) so a memory-only consumer does not
 * pay for the IndexedDB code path or the `idb` runtime. The root
 * path remains valid so existing imports of `StorageAdapter`
 * (and other shared types) keep working without a subpath, but
 * runtime adapter imports must move to the per-adapter subpath.
 *
 * The type list lives in `./types`; this entry re-exports it whole so the two
 * paths can never disagree about what `@ebbjs/storage` publishes.
 */
export type * from "./types";
