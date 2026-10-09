/**
 * `@ebbjs/storage/types` subpath entry.
 *
 * Exposes the shared adapter interfaces. Type-only — this entry
 * has no runtime surface (every export is a TypeScript type), so
 * importing from it adds zero bytes to a consumer's bundle.
 */
export type { ActionLog } from "./action-log";
export type { DirtyTracker } from "./dirty-tracker";
export type { EntityStore, RelationshipIndexQuery } from "./entity-store";
export type { CursorStore } from "./cursor-store";
export type { EntityChangeEmitter } from "./entity-change-emitter";
export type { OutboxEntry, OutboxStatus, OutboxStore } from "./outbox-store";
export type {
  ConflictEntry,
  ConflictLoss,
  ConflictSlot,
  ConflictStore,
  ConflictWinner,
} from "./conflict-store";
export type { StorageAdapter } from "./storage-adapter";
