/**
 * Type marker for the `causal-tree` field type.
 *
 * A `collaborativeText()` field carries an opaque encoded tree blob in its
 * `value`. The `@ebbjs/client` field-type module
 * (`@ebbjs/client/src/fields/collaborative-text/`) consumes incoming
 * Actions targeting the entity and maintains a live causal tree; the
 * storage layer just sees a normal LWW field whose `value` is the encoded
 * tree state.
 *
 * The marker is intentionally tiny — it lives in `@ebbjs/core` because it
 * mirrors the v1 public API surface (`import { e } from "@ebbjs/core"`),
 * but it carries no behavior. Algorithm details live in `@ebbjs/client`.
 */
export const collaborativeTextFieldMarker = {
  type: "causal-tree",
} as const;

/**
 * Typed field markers for the v1 API.
 *
 * For the prototype, only `collaborativeText` matters. The other entries
 * are stubs that the prototype doesn't use but exist so the public API
 * shape matches the v1 docs.
 */
export const e = {
  /** Last-writer-wins string field. */
  string: (): { type: "lww" } => ({ type: "lww" }),
  /** Last-writer-wins number field. */
  number: (): { type: "lww" } => ({ type: "lww" }),
  /** Last-writer-wins boolean field. */
  boolean: (): { type: "lww" } => ({ type: "lww" }),
  /** Counter field (additive). */
  counter: (): { type: "counter" } => ({ type: "counter" }),
  /**
   * Causal-tree collaborative text field.
   *
   * Value is an opaque encoded tree blob (the client maintains the actual
   * tree in memory and replays incoming Actions to keep it in sync).
   */
  collaborativeText: (): { type: "causal-tree" } => collaborativeTextFieldMarker,
} as const;
