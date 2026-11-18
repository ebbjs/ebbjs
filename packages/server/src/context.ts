import type { ContextBase } from "@ebbjs/write";

/**
 * The port's value types are `@ebbjs/write`'s; re-exported so a handler author
 * keeps importing them from the SDK that typed the handler.
 */
export type { CommitOutcome, CreateOptions, RelationshipTarget, WriteOptions } from "@ebbjs/write";

/**
 * The entity names the application schema declares.
 *
 * A schema without a `models` map (a bare `{ tables: {} }`, say) cannot
 * narrow the set, so the verbs accept any name and the server validates it.
 */
export type EntityName<S> = S extends {
  readonly models: infer E extends Record<string, unknown>;
}
  ? keyof E & string
  : string;

/**
 * The handler's view of one invocation.
 *
 * `S` is the application schema the function was defined against, carried so
 * handlers can be typed against the same schema as the rest of the app. When
 * that schema declares entities, the write verbs only accept those names.
 *
 * Everything but that narrowing is {@link ContextBase}, declared in
 * `@ebbjs/write` and shared with the runtime that implements it. This is the
 * type-only SDK surface; `@ebbjs/functions-runtime` supplies the implementation
 * the runner hands to the handler.
 */
export interface Context<S = unknown> extends ContextBase<EntityName<S>> {
  /** Type-only marker for the application schema; never present at runtime. */
  readonly "~schema"?: S;
}
