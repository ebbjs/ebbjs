/**
 * The "assert this field absent" marker.
 *
 * A cleared field is absent, not `null`, so absence needs its own verb:
 * `update(todo, { dueDate: unset })`. `null` stays the *query* spelling of
 * "no live value" (a question), while a payload asserts (a statement).
 * The marker is a frozen singleton recognised structurally, so it can never
 * be confused with row data, and `wrapFields` compiles it to the tombstone
 * envelope the merge rule already understands.
 */

const UNSET = Symbol.for("@ebbjs/unset");

/** The marker value: a frozen singleton, never row data. */
export interface Unset {
  readonly [UNSET]: true;
}

/** The one `unset` singleton. Identity is not the contract; `isUnset` is. */
export const unset: Unset = Object.freeze({ [UNSET]: true as const });

/** True for the `unset` marker and nothing else. */
export const isUnset = (value: unknown): value is Unset =>
  typeof value === "object" && value !== null && (value as { [UNSET]?: unknown })[UNSET] === true;
