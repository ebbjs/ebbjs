export { applyUpdate, foldEntityAction } from "../internal/materialize";
export { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
export { contentChanged } from "./content-changed";
export { createLeaseTable, DEFAULT_RESIDENCY_TTL_MS, residencyTtlOf, unrefTimer } from "./leases";
export type {
  ComponentLeaseStats,
  LeaseKey,
  LeaseStats,
  LeaseTable,
  LeaseTableOptions,
  LeaseTimerHandle,
  LeaseTimers,
  Release,
} from "./leases";
export { DEFAULT_JOURNAL_CAPACITY, createReplica, holdAll } from "./replica";
export type {
  ContentChange,
  MaterializationPolicy,
  MembershipChange,
  MembershipQuery,
  MembershipTransition,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "./types";
