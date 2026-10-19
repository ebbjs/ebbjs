/**
 * `@ebbjs/storage/types` subpath entry.
 *
 * Exposes the shared adapter interfaces. Type-only — this entry
 * has no runtime surface (every export is a TypeScript type), so
 * importing from it adds zero bytes to a consumer's bundle.
 */
export type { ActionLog, LoggedAction } from "./action-log";
export type { DirtyTracker } from "./dirty-tracker";
export type {
  EntityStore,
  RelationshipIndexQuery,
  RelationshipSourceQuery,
  RelationshipLink,
  MembershipLink,
} from "./entity-store";
export type { CursorStore } from "./cursor-store";
export type { ReplicaRecord, ReplicaStore } from "./replica-store";
export type {
  MaterializationPolicy,
  MembershipQuery,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "../replica/types";
export type {
  OutboxEntry,
  OutboxStatus,
  OutboxStore,
  OutboxConflict,
  ConflictSide,
  ConflictSlot,
  ConflictSubjectState,
} from "./outbox-store";
export type { StorageAdapter } from "./storage-adapter";
