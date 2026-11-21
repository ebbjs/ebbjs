export { applyUpdate, foldEntityAction } from "../internal/materialize";
export { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
export { contentChanged } from "./content-changed";
export { createLeaseTable, DEFAULT_RESIDENCY_TTL_MS } from "./leases";
export type {
  LeaseKey,
  LeaseStats,
  LeaseTable,
  LeaseTableOptions,
  LeaseTimerHandle,
  LeaseTimers,
  Release,
} from "./leases";
export { DEFAULT_JOURNAL_CAPACITY, DEFAULT_PINNED_TTL_MS, createReplica, holdAll } from "./replica";
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
