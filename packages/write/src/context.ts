/**
 * The handler's `ctx` port: what a function may call, and the shapes its calls
 * carry.
 *
 * Two packages publish this port from one definition: `@ebbjs/server` types a
 * handler against it (`Context<S>` narrows the entity names to the schema's
 * models) and `@ebbjs/functions-runtime` implements it at invocation time. A
 * copy in each is a copy that drifts — the runtime already grew `log` and `env`
 * that the SDK's copy never heard about.
 *
 * The port is the verbs only. What each side adds is its own: the runtime adds
 * `log` and `env`, the SDK adds the schema marker.
 */

import type { EntityResponse } from "./entity-response";
import type { CreateHandle, PointerTarget } from "./verbs";

/** A reference to an existing row: its id, or anything carrying one. */
export type RelationshipTarget = PointerTarget;

/** Options for {@link ContextBase.create}. */
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

/** What {@link ContextBase.commit} resolves to. */
export interface CommitOutcome {
  readonly replayed: boolean;
}

/** Who invoked the function: an actor's own call, or a service acting for it. */
export type CallerKind = "actor" | "service";

/** Who invoked the function. Never client-supplied. */
export interface Caller {
  readonly kind: CallerKind;
  readonly id: string;
}

/**
 * The handler's view of one invocation, with the entity names left open.
 *
 * `Entity` is the set of names the write verbs accept. The runtime implements
 * the open form (`string`); the SDK narrows it to the application schema's
 * models. Reads are `get` only: a missing entity and an entity the subject may
 * not read are deliberately indistinguishable, both are `null`.
 */
export interface ContextBase<Entity extends string = string> {
  /** One entity, or `null` when it is absent or not visible to the subject. */
  get(id: string): Promise<EntityResponse | null>;

  /**
   * Create one row and return its handle. `groups` is required and
   * non-empty; one membership row per group lands in the same Action.
   */
  create(entity: Entity, fields: Record<string, unknown>, options: CreateOptions): CreateHandle;
  /** Patch an existing row. Validated against the entity's shape at the call. */
  update(entity: Entity, id: string, patch: Record<string, unknown>, options?: WriteOptions): void;
  /** Soft-delete an existing row. */
  delete(entity: Entity, id: string): void;
  /**
   * Link a relationship. One-cardinality relationships take a single target;
   * a many-cardinality relationship takes the whole set the call carries. The
   * edge is a key on the source row, so each target is one `ebb/link` key.
   */
  relate(
    entity: Entity,
    sourceId: string,
    as: string,
    target: RelationshipTarget | readonly RelationshipTarget[],
  ): void;
  /**
   * Remove a relationship. `target` names the edge's key, for either
   * cardinality. With no target the call clears the accessor, which reads the
   * source row through `get` to learn the live targets.
   */
  unrelate(
    entity: Entity,
    sourceId: string,
    as: string,
    target?: RelationshipTarget,
  ): Promise<void>;

  /**
   * Submit the buffered writes as one Action now. Resolves `{ replayed }`,
   * where `replayed: true` means the server dropped the submission because its
   * `action_id` was already recorded. A no-op when nothing is buffered.
   */
  commit(): Promise<CommitOutcome>;

  /** The subject actor. Never client-supplied. */
  readonly actor: { readonly id: string };
  /** How the subject was resolved: the caller's own actor, or a service for it. */
  readonly caller: Caller;
  readonly invocationId: string;
}
