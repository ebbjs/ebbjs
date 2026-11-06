/**
 * `@ebbjs/write` — the shared write planner.
 *
 * The operation vocabulary and the pure wire builders: operations turn a
 * resolved mutation into Updates, verbs map a semantic call onto those
 * operations, the committer wraps a batch in one Action, and the relationship
 * helpers build the relationship and membership rows those Updates carry. No
 * storage reads and no client dependency.
 */

export { isUnset, unset, type Unset } from "@ebbjs/core";
export * from "./committer";
export * from "./field-projection";
export * from "./generated-parts";
export * from "./membership";
export * from "./operations";
export * from "./pointer";
export * from "./rejection";
export * from "./relationship";
export * from "./verbs";
