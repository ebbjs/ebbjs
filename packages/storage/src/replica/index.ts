export { applyUpdate } from "../internal/materialize";
export { contentChanged } from "./content-changed";
export { DEFAULT_PINNED_CAPACITY, DEFAULT_PINNED_TTL_MS, createReplica, holdAll } from "./replica";
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
