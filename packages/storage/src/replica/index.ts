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
export { DEFAULT_JOURNAL_CAPACITY, createReplica } from "./replica";
export type { MembershipRow } from "./row-index";
export { jsonBytes, utf8Bytes } from "./size";
export type {
  ChangeDelta,
  ContentChange,
  MembershipChange,
  MembershipQuery,
  MembershipSide,
  MembershipTransition,
  Replica,
  ReplicaBytes,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "./types";
