import type { EntityResponse } from "@ebbjs/client";
import type { CreateHandle, PointerTarget } from "@ebbjs/write";

/** A reference to an existing row: its id, or anything carrying one. */
export type RelationshipTarget = PointerTarget;

/** Options for {@link Context.create}; mirrors `@ebbjs/functions-runtime`'s. */
export interface CreateOptions {
  /** The groups the new row is filed into. Required and non-empty. */
  readonly groups: readonly PointerTarget[];
  /** Explicit row id, for a caller that needs a deterministic batch. */
  readonly id?: string;
  /** Skip the local field-shape check; the server still validates. */
  readonly validate?: boolean;
}

/** Options shared by the entity write verbs. */
export interface WriteOptions {
  readonly validate?: boolean;
}

/** Options for {@link Context.unrelate}. */
export interface UnrelateOptions {
  /** A one-cardinality edge's `relationship` row id. */
  readonly relationshipId?: string;
}

/** What {@link Context.commit} resolves to. */
export interface CommitOutcome {
  readonly replayed: boolean;
}

/**
 * The entity names the application schema declares.
 *
 * A schema without an `entities` map (a bare `{ tables: {} }`, say) cannot
 * narrow the set, so the verbs accept any name and the server validates it.
 */
export type EntityName<S> = S extends {
  readonly entities: infer E extends Record<string, unknown>;
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
 * This is the type-only SDK surface; `@ebbjs/functions-runtime` supplies the
 * implementation the runner hands to the handler.
 */
export interface Context<S = unknown> {
  /** One entity, or `null` when it is absent or not visible to the subject. */
  get(id: string): Promise<EntityResponse | null>;

  /**
   * Create one row and return its handle. `groups` is required and
   * non-empty; one membership row per group lands in the same Action.
   */
  create(
    entity: EntityName<S>,
    fields: Record<string, unknown>,
    options: CreateOptions,
  ): CreateHandle;
  /** Patch an existing row. Validated against the entity's shape at the call. */
  update(
    entity: EntityName<S>,
    id: string,
    patch: Record<string, unknown>,
    options?: WriteOptions,
  ): void;
  /** Soft-delete an existing row. */
  delete(entity: EntityName<S>, id: string): void;
  /**
   * Link a relationship. One-cardinality relationships take a single target;
   * a many-cardinality relationship's canonical FK set lives on the source
   * row, so passing a list sets the whole set.
   */
  relate(
    entity: EntityName<S>,
    sourceId: string,
    as: string,
    target: RelationshipTarget | readonly RelationshipTarget[],
  ): void;
  /**
   * Remove a relationship. A one-cardinality edge is deleted by its
   * `relationship` row id (taken explicitly unless this invocation created
   * the edge); a many-cardinality edge drops `target` from the current FK set,
   * or clears the set when no target is given.
   */
  unrelate(
    entity: EntityName<S>,
    sourceId: string,
    as: string,
    target?: RelationshipTarget,
    options?: UnrelateOptions,
  ): Promise<void>;

  /**
   * Submit the buffered writes as one Action now. Resolves `{ replayed }`,
   * where `replayed: true` means the server dropped the submission because its
   * `action_id` was already recorded. A no-op when nothing is buffered.
   */
  commit(): Promise<CommitOutcome>;

  /** The subject actor. Never client-supplied. */
  readonly actor: { readonly id: string };
  readonly caller: { readonly kind: "actor" | "service"; readonly id: string };
  readonly invocationId: string;
  /** Type-only marker for the application schema; never present at runtime. */
  readonly "~schema"?: S;
}
