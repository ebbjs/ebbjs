export { applyUpdate, foldEntityAction } from "../internal/materialize";
export { contentChanged } from "./content-changed";
export { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
export {
  DEFAULT_JOURNAL_CAPACITY,
  DEFAULT_CACHE_CAPACITY,
  DEFAULT_CACHE_TTL_MS,
  createReplica,
  holdAll,
} from "./replica";
export type {
  MaterializationPolicy,
  MembershipQuery,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "./types";
