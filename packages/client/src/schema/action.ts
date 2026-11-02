/**
 * `defineAction` — a schema-bound, reusable cross-entity Action, and the only
 * way to write.
 *
 * A definition is pure (no ids, no writes, no I/O), so it builds at module load
 * and mounts on several clients under different names. Executing one is
 * `client.actions.<name>(params)`, which runs the callback through the runtime
 * in `../sync/drafts` and commits everything it drafts as one Action.
 */

import type { ActionDrafts } from "../sync/drafts";

/** Where a definition keeps its callback. The client reads it; nothing else should. */
export const RUN: unique symbol = Symbol.for("@ebbjs/action-run");

/** A frozen Action descriptor: bound schema, callback params, and its result. */
export interface ActionDef<S, Params, Result> {
  readonly schema: S;
  readonly [RUN]: (drafts: ActionDrafts<S>, params: Params) => Result;
}

/** Erased definition, as an `actions` map holds it; `client.actions` restores the rest. */
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

/** Declare an Action against `schema`; `Params` defaults to `void`. */
export function defineAction<S, Params = void, Result = unknown>(
  schema: S,
  run: (drafts: ActionDrafts<S>, params: Params) => Result,
): ActionDef<S, Params, Result> {
  return Object.freeze({ schema, [RUN]: run });
}

/** What a client mounts: `Promise<Result>`, zero-arg when there are no params. */
export type Action<_S, Params, Result> = Params extends void
  ? () => Promise<Result>
  : (params: Params) => Promise<Result>;
