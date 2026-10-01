/**
 * `@ebbjs/storage/types` subpath entry.
 *
 * Exposes the shared adapter interfaces. Type-only — this entry
 * has no runtime surface (every export is a TypeScript type), so
 * importing from it adds zero bytes to a consumer's bundle.
 */
export type { ActionLog } from "./action-log";
export type { DirtyTracker } from "./dirty-tracker";
export type { EntityStore } from "./entity-store";
export type { CursorStore } from "./cursor-store";
export type { StorageAdapter } from "./storage-adapter";
