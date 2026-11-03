/**
 * `@ebbjs/functions-runtime` — the context a function handler runs against.
 *
 * Reads go out as `get` host calls and see the invocation's own buffered
 * writes through an overlay. Writes buffer in call order, run the shared
 * `@ebbjs/write` planner at the call site, and go out as one `commit` frame —
 * one Action, one GSN, atomic across its Updates — on `ctx.commit()` or when
 * the runner flushes a handler that returned. A handler that throws submits
 * nothing.
 */

import { createClock, type HLCState } from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";
import type { EntityRegistry } from "@ebbjs/schema";
import type { CreateHandle, OperationIds, PointerTarget } from "@ebbjs/write";

import type { CommitOutcome } from "./commit.ts";
import type { Caller, HostOp, HostTransport } from "./transport.ts";
import {
  createWriteSurface,
  defaultOperationIds,
  type CreateOptions,
  type UnrelateOptions,
  type WriteOptions,
  type WriteSurface,
} from "./writes.ts";

export { ActionRejectedError } from "@ebbjs/write";
export { EntityValidationError } from "@ebbjs/schema";
export { HostCallError, actionIdForInvocation, type CommitOutcome } from "./commit.ts";
export { MissingSchemaError, WritesCommittedError } from "./errors.ts";
export type { Caller, HostOp, HostTransport } from "./transport.ts";
export type { CreateOptions, UnrelateOptions, WriteOptions } from "./writes.ts";
export type { CreateHandle } from "@ebbjs/write";
export type { OperationIds } from "@ebbjs/write";
export type { EntityRegistry } from "@ebbjs/schema";

/** A reference to an existing row: its id, or anything carrying one. */
export type RelationshipTarget = PointerTarget;

/**
 * The handler's view of one invocation.
 *
 * `get` is the only entity read in v1 (<code>ctx.query</code> and
 * <code>ctx.getMany</code> are not in v1). A missing entity and an entity the
 * subject may not read are deliberately indistinguishable: both are `null`.
 * There is no `ctx.fetch`; handlers use the runtime's global `fetch`.
 *
 * The write verbs buffer; nothing reaches the server until {@link Context.commit}
 * or the runner's flush at handler return. See the package README for the
 * one-Action rule and the v1 resolution gaps.
 */
export interface Context {
  get(id: string): Promise<EntityResponse | null>;

  /**
   * Create one row and return its handle. `groups` is required and
   * non-empty; one membership row per group lands in the same Action.
   */
  create(entity: string, fields: Record<string, unknown>, options: CreateOptions): CreateHandle;
  /** Patch an existing row. Validated against the entity's shape at the call. */
  update(entity: string, id: string, patch: Record<string, unknown>, options?: WriteOptions): void;
  /** Soft-delete an existing row. */
  delete(entity: string, id: string): void;
  /**
   * Link a relationship. One-cardinality relationships take a single target;
   * a many-cardinality relationship's canonical FK set lives on the source
   * row, so passing a list sets the whole set.
   */
  relate(
    entity: string,
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
    entity: string,
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

  readonly actor: { readonly id: string };
  readonly caller: Caller;
  readonly invocationId: string;
}

export interface CreateContextOptions {
  readonly transport: HostTransport;
  readonly invocationId: string;
  readonly actor: { readonly id: string };
  readonly caller: Caller;
  /** The schema the write verbs resolve entity and relationship names against. */
  readonly registry?: EntityRegistry;
  /** Deterministic id seam; defaults to core's nanoid `generateId`. */
  readonly ids?: OperationIds;
  /** The invocation's clock; defaults to a fresh `createClock()`. */
  readonly clock?: HLCState;
}

/**
 * Build the `ctx` a handler receives.
 *
 * Reads are independent host calls, so two concurrent `get`s are independent
 * snapshots rather than a consistent read; the only consistency the context
 * adds is the overlay of its own buffered writes.
 */
export function createContext(options: CreateContextOptions): Context {
  const clock = options.clock ?? createClock();
  const ids = options.ids ?? defaultOperationIds(clock);
  const surface: WriteSurface = createWriteSurface({
    transport: options.transport,
    invocationId: options.invocationId,
    actorId: options.actor.id,
    ids,
    registry: options.registry,
  });

  return Object.freeze({
    get: surface.read,
    create: surface.create,
    update: surface.update,
    delete: surface.delete,
    relate: surface.relate,
    unrelate: surface.unrelate,
    commit: surface.commit,
    actor: Object.freeze({ id: options.actor.id }),
    caller: Object.freeze({ kind: options.caller.kind, id: options.caller.id }),
    invocationId: options.invocationId,
  });
}
