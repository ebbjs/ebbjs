/**
 * `defineAction` — a schema-bound, reusable cross-entity Action.
 *
 * A definition pairs a `Schema` with the same resolver callback the
 * `client.atomic(...)` form accepts. The result is a frozen,
 * non-callable descriptor: a client built on the same schema is the
 * only way to execute it. Definition is pure — no ids, no writes, no
 * I/O — so the descriptor is safe to build at module load and mount
 * on several clients (under different names).
 *
 * `client.actions.<name>(params)` runs the callback through the
 * resolver in `../sync/atomic`, so a defined action and the
 * equivalent `client.atomic(...)` callback compose the same single
 * Action.
 */

import type { AtomicDrafts } from "../sync/atomic";

/**
 * Symbol under which a definition keeps its resolver callback. The
 * client reads it when mounting; nothing else should.
 */
export const RUN: unique symbol = Symbol.for("@ebbjs/action-run");

/**
 * A frozen Action descriptor. `S` is the schema the Action is bound
 * to, `Params` the callback's second argument, `Result` its return
 * value.
 */
export interface ActionDef<S, Params, Result> {
  readonly schema: S;
  readonly [RUN]: (drafts: AtomicDrafts<S>, params: Params) => Result;
}

/**
 * Erased view of a definition, as held by an `actions` map. Any
 * concrete `ActionDef` is assignable; the per-key `Params` / `Result`
 * are restored on `client.actions`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDef = ActionDef<any, never, unknown>;

/** One configuration mistake in an `actions` map. */
export interface ActionDefinitionViolation {
  /** Name of the offending action; omitted when the map itself is invalid. */
  readonly actionName?: string;
  readonly message: string;
}

/**
 * Thrown by `createClient` when an `actions` map is misconfigured —
 * an action defined against a different schema, or `actions` passed
 * without a `schema`. Mirrors `EntityValidationError`'s shape: a
 * formatted `message` plus the structured violations.
 */
export class ActionDefinitionError extends Error {
  readonly violations: readonly ActionDefinitionViolation[];

  constructor(violations: readonly ActionDefinitionViolation[]) {
    super(formatViolations(violations));
    this.name = "ActionDefinitionError";
    this.violations = violations;
  }
}

const formatViolations = (violations: readonly ActionDefinitionViolation[]): string => {
  if (violations.length === 0) return "ActionDefinitionError";
  const lines = violations.map(
    (v) => `  - ${v.actionName === undefined ? v.message : `${v.actionName}: ${v.message}`}`,
  );
  return `ActionDefinitionError: ${violations.length} violation(s)\n${lines.join("\n")}`;
};

/**
 * Declare a reusable Action against `schema`. The returned descriptor
 * is frozen and allocates nothing; `Params` defaults to `void` when
 * the callback declares none.
 */
export function defineAction<S, Params = void, Result = unknown>(
  schema: S,
  run: (drafts: AtomicDrafts<S>, params: Params) => Result,
): ActionDef<S, Params, Result> {
  return Object.freeze({ schema, [RUN]: run });
}

/**
 * The callable a client mounts for one definition: `Promise<Result>`,
 * zero-arg when the definition declares no params.
 */
export type Action<_S, Params, Result> = Params extends void
  ? () => Promise<Result>
  : (params: Params) => Promise<Result>;
