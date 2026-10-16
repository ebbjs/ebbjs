/**
 * `client.atomic(...)` — resolve forward references between entities
 * created in one call and emit exactly one wire-level Action.
 *
 * The callback form receives one draft namespace per schema entity.
 * `draft.create(input)` allocates the entity's id eagerly, resolves the
 * input into wire fields, relationship pointers, and derived bodies,
 * records an operation call, and returns a handle carrying the id plus
 * the materialized field values. A value that is itself a handle (or a
 * string id / anything with a string `.id`) under a registered
 * relationship key is substituted with the target's id.
 *
 * Every operation collected during the callback is flattened into one
 * batch by the committer, so the server sees a single Action and
 * commits it atomically. The batch runs the same {@link createEntity}
 * operation the imperative `client.<entity>.create(...)` delegates to,
 * so the two surfaces cannot drift.
 *
 * The schema-bound `defineAction` form (#232) layers on top of this
 * resolver; this module stays independent of it.
 *
 * ### Permission coherence (#233)
 *
 * #127 makes an Action fully visible or fully invisible to a client, so
 * every content write in one call must resolve to the identical group
 * set. The committer enforces the rule over the collected operations
 * before submission, so an incoherent batch never reaches the outbox.
 */

import { generateId, type FieldValue } from "@ebbjs/core";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef, ShapeFields } from "../schema/entity";
import { EntityValidationError } from "../schema/entity-registry";
import type { Schema } from "../schema/schema";
import type { GroupFields, GroupMemberFields } from "../schema/system-entities";
import { normalizePointer } from "./query-builder";
import {
  resolveGroupIds,
  resolveSingleGroupId,
  type EntityFields,
  type GroupRef,
  type WireStatic,
} from "./namespace";
import type { LiveMembership } from "./entity-group";
import { commit, type CommitCapability } from "./committer";
import {
  AtomicActionError,
  call,
  changeGroups,
  createEntity,
  createSystemEntity,
  groupBootstrap,
  type MembershipRemoval,
  type OperationCall,
  type ResolvedPointer,
} from "./operations";

export { AtomicActionError, type AtomicRejection } from "./operations";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;

const ATOMIC_HANDLE = Symbol.for("@ebbjs/atomic-handle");

interface AtomicHandle {
  readonly id: string;
}

const isAtomicHandle = (value: unknown): value is AtomicHandle =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[ATOMIC_HANDLE] === true;

/** Stamp a create handle so later reference resolution recognises it. */
const markHandle = <T extends Record<string, unknown>>(handle: T): T => {
  Object.defineProperty(handle, ATOMIC_HANDLE, { value: true, enumerable: false });
  return handle;
};

/**
 * Error raised when the resolver cannot turn the collected drafts into
 * a valid batch — a self-referential field value, or a pointer value
 * that isn't a string / entity / handle.
 */
export class AtomicResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicResolutionError";
  }
}

/** Handle returned by a draft namespace's `create`. Carries the id eagerly. */
export type CreatedEntity<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TFields>>
> & { readonly id: string } & Record<string, unknown>;

/**
 * Input accepted by a draft namespace's `create`. Field values and
 * relationship pointers (a handle, id, or array of either) share one
 * loose record: the resolver distinguishes them by the registry's
 * relationship declarations, and validates the entity fields before
 * submission.
 */
export type AtomicCreateInput = Record<string, unknown>;

/**
 * Options for a draft namespace's `create`. Mirrors the entity
 * namespace's create signature: `groups` is required and non-empty,
 * and one `entityGroup` row per group lands in the same Action.
 */
export interface AtomicCreateOptions {
  readonly groups: readonly GroupRef[];
}

/**
 * The committer capability plus the local membership read the draft
 * planner needs to resolve a `removeFromGroup` (and an idempotent
 * `addToGroup`) after the synchronous callback returns.
 */
export interface AtomicCapability extends CommitCapability {
  readMemberships(entityId: string): Promise<readonly LiveMembership[]>;
}

/** One membership verb a draft collected, resolved after the callback. */
interface MembershipIntent {
  readonly kind: "add" | "remove";
  readonly entity: string;
  readonly entityId: string;
  readonly groupId: string;
}

/** The state a `client.atomic` call accumulates while the callback runs. */
interface DraftCollector {
  readonly calls: OperationCall[];
  readonly intents: MembershipIntent[];
  /** Groups a batch-local `create` already filed an entity into. */
  readonly createdGroups: Map<string, ReadonlySet<string>>;
}

/** Per-entity draft surface passed to the `client.atomic` callback. */
export interface AtomicDraftNamespace<TFields extends Record<string, TSchema>> {
  create(input: AtomicCreateInput, opts: AtomicCreateOptions): CreatedEntity<TFields>;
  /**
   * File an existing entity into `groupId` in the same Action. A no-op
   * when the batch already created the entity into that group; an
   * already-committed membership is skipped after the callback reads
   * the local view.
   */
  addToGroup(id: string, groupId: GroupRef): void;
  /**
   * Delete an existing entity's membership row for `groupId` in the
   * same Action. The row is resolved from the local view after the
   * callback returns; a missing row throws `EntityValidationError`.
   */
  removeFromGroup(id: string, groupId: GroupRef): void;
}

/**
 * A draft system namespace. `create` is the only verb: an
 * `entityGroup` row scoping a `group` or `groupMember` is meaningless,
 * so the membership verbs the content draft surface carries are absent.
 */
export interface AtomicSystemDraftNamespace<TFields extends Record<string, TSchema>> {
  create(input: WireStatic<TFields>): CreatedEntity<TFields>;
}

/** Draft namespaces keyed by schema entity name, plus the system entities. */
export type AtomicDrafts<S> =
  S extends Schema<infer TEntities, unknown>
    ? { [K in keyof TEntities & string]: AtomicDraftNamespace<EntityFields<TEntities[K]>> } & {
        readonly group: AtomicSystemDraftNamespace<GroupFields>;
        readonly groupMember: AtomicSystemDraftNamespace<GroupMemberFields>;
      }
    : Record<string, never>;

/**
 * `client.atomic` surface, present only when the client was built with
 * a `Schema`. `T` is the callback's return value, so the caller reads
 * the eagerly-created handles straight off the awaited result.
 */
export type AtomicClient<S> =
  S extends Schema<Record<string, AnyEntityDef>, unknown>
    ? { atomic<T>(build: (drafts: AtomicDrafts<S>) => T): Promise<T> }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Resolve a field value into wire-safe data: atomic handles collapse
 * to their id, arrays and plain objects are walked, everything else
 * passes through. `seen` is the current path, so a value that contains
 * itself is rejected instead of recursing forever. A shared (DAG)
 * reference is fine — only a back-edge is a cycle.
 */
export function resolveReferences(
  value: unknown,
  seen: Set<object> = new Set(),
): FieldValue["value"] {
  if (isAtomicHandle(value)) return value.id;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new AtomicResolutionError("cycle detected while resolving atomic write fields");
  }
  seen.add(value);
  const resolved = Array.isArray(value)
    ? value.map((item) => resolveReferences(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveReferences(item, seen)]),
      );
  seen.delete(value);
  return resolved;
}

/**
 * Normalize a relationship pointer value into a list of target ids.
 * Accepts a handle, a string id, anything with a string `.id`, or an
 * array of those; `null`/`undefined` drop out (clear semantics).
 */
const resolvePointerTargets = (
  value: unknown,
  entityName: string,
  as: string,
): readonly string[] => {
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    try {
      const id = normalizePointer(item, `atomic pointer for "${entityName}.${as}"`);
      if (id !== null) out.push(id);
    } catch (err) {
      throw new AtomicResolutionError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
};

const declaresField = (def: AnyEntityDef, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(def.shape.properties ?? {}, key);

/**
 * Resolve one draft `create` into an operation call. The entity id is
 * minted here (the callback needs it before commit); field references
 * collapse to ids; derived collaborative-text bodies route to the same
 * document-expansion path the imperative `create` uses.
 */
const createDraftNamespace = (
  entityName: string,
  def: AnyEntityDef,
  cap: CommitCapability,
  collector: DraftCollector,
): AtomicDraftNamespace<Record<string, TSchema>> => ({
  create(input, opts) {
    const id = generateId("e");
    const source = (input ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    const pointers: ResolvedPointer[] = [];
    const bodies: Record<string, string> = {};
    const handle: Record<string, unknown> = { id };
    const groups = resolveGroupIds(opts?.groups, entityName);
    const derived = def.derived as Record<string, unknown> | undefined;

    for (const [key, value] of Object.entries(source)) {
      if (derived !== undefined && Object.prototype.hasOwnProperty.call(derived, key)) {
        if (value === undefined || value === null) {
          handle[key] = null;
          continue;
        }
        if (typeof value !== "string") {
          throw new EntityValidationError([
            {
              entityName,
              field: key,
              message: `create: derived field "${key}" must be a string body`,
            },
          ]);
        }
        handle[key] = value;
        if (value.length > 0) bodies[key] = value;
        continue;
      }
      const rel = cap.registry.getRelationship(entityName, key);
      if (rel === undefined) {
        const resolved = resolveReferences(value);
        fields[key] = resolved;
        handle[key] = resolved;
        continue;
      }
      const targets = resolvePointerTargets(value, entityName, key);
      if (rel.sourceCardinality === "many") {
        handle[key] = targets;
        // A declared `as` field carries the canonical FK set on the
        // entity; an undeclared one lives only on the Relationship
        // records.
        if (declaresField(def, key)) fields[key] = targets;
        for (const targetId of targets) {
          pointers.push({ as: key, type: rel.type, targetId });
        }
      } else {
        if (targets.length > 1) {
          throw new AtomicResolutionError(
            `atomic: one-cardinality relationship "${entityName}.${key}" received ${targets.length} targets`,
          );
        }
        const targetId = targets[0];
        handle[key] = targetId ?? null;
        if (targetId !== undefined) {
          pointers.push({ as: key, type: rel.type, targetId });
        }
      }
    }

    const marked = markHandle(handle);
    collector.createdGroups.set(id, new Set(groups));
    collector.calls.push(
      call(createEntity, {
        entity: entityName,
        id,
        fields,
        pointers,
        bodies,
        groups,
      }),
    );
    return marked as unknown as CreatedEntity<Record<string, TSchema>>;
  },
  addToGroup(id, groupId) {
    const target = resolveSingleGroupId(groupId, entityName, "addToGroup");
    // A group the batch's own create already filed is redundant; the
    // committed view is consulted after the callback for the rest.
    if (collector.createdGroups.get(id)?.has(target) === true) return;
    collector.intents.push({ kind: "add", entity: entityName, entityId: id, groupId: target });
  },
  removeFromGroup(id, groupId) {
    const target = resolveSingleGroupId(groupId, entityName, "removeFromGroup");
    collector.intents.push({ kind: "remove", entity: entityName, entityId: id, groupId: target });
  },
});

/**
 * Resolve the membership verbs a draft collected, after the callback
 * returns and before commit. The local view is read once per entity;
 * an add that already holds the group is skipped, and a remove with no
 * row throws the same `EntityValidationError` the imperative verb does.
 */
const resolveMembershipIntents = async (
  intents: readonly MembershipIntent[],
  cap: AtomicCapability,
): Promise<OperationCall[]> => {
  const byEntity = new Map<string, { entity: string; adds: Set<string>; removes: Set<string> }>();
  for (const intent of intents) {
    const entry = byEntity.get(intent.entityId) ?? {
      entity: intent.entity,
      adds: new Set<string>(),
      removes: new Set<string>(),
    };
    (intent.kind === "add" ? entry.adds : entry.removes).add(intent.groupId);
    byEntity.set(intent.entityId, entry);
  }

  const calls: OperationCall[] = [];
  for (const [entityId, { entity, adds, removes }] of byEntity) {
    const live = await cap.readMemberships(entityId);
    const currentGroups = live.map((membership) => membership.groupId);
    const liveByGroup = new Map(live.map((membership) => [membership.groupId, membership]));
    const puts = [...adds].filter((groupId) => !liveByGroup.has(groupId));
    const removals: MembershipRemoval[] = [];
    for (const groupId of removes) {
      const row = liveByGroup.get(groupId);
      if (row === undefined) {
        throw new EntityValidationError([
          {
            entityName: entity,
            message: `removeFromGroup: no entityGroup membership row for "${entityId}" in group "${groupId}"`,
          },
        ]);
      }
      removals.push({ membershipId: row.membershipId, groupId });
    }
    if (puts.length === 0 && removals.length === 0) continue;
    calls.push(call(changeGroups, { entity, entityId, puts, removes: removals, currentGroups }));
  }
  return calls;
};

/**
 * The system draft namespaces. `group.create` records the same
 * bootstrap operation `client.group.create` commits; `groupMember.create`
 * records a single system put. Neither emits an `entityGroup` row.
 */
const createSystemDrafts = (
  cap: CommitCapability,
  collector: DraftCollector,
): {
  group: AtomicSystemDraftNamespace<GroupFields>;
  groupMember: AtomicSystemDraftNamespace<GroupMemberFields>;
} => ({
  group: {
    create(input) {
      const bootstrap = groupBootstrap(cap.registry, input.name);
      collector.calls.push(bootstrap.call);
      return markHandle({
        id: bootstrap.groupId,
        name: input.name,
      }) as unknown as CreatedEntity<GroupFields>;
    },
  },
  groupMember: {
    create(input) {
      const id = generateId("e");
      collector.calls.push(
        call(createSystemEntity, {
          entity: "groupMember",
          id,
          fields: input as Record<string, unknown>,
        }),
      );
      return markHandle({ id, ...input }) as unknown as CreatedEntity<GroupMemberFields>;
    },
  },
});

const buildDrafts = (
  entityDefs: Record<string, AnyEntityDef>,
  cap: CommitCapability,
  collector: DraftCollector,
): Record<string, AtomicDraftNamespace<Record<string, TSchema>>> => {
  const out: Record<string, AtomicDraftNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(entityDefs)) {
    // The map key is the draft handle's property name; the entity's own
    // name is what the wire carries.
    out[name] = createDraftNamespace(def.name, def, cap, collector);
  }
  const system = createSystemDrafts(cap, collector);
  out["group"] = system.group as unknown as AtomicDraftNamespace<Record<string, TSchema>>;
  out["groupMember"] = system.groupMember as unknown as AtomicDraftNamespace<
    Record<string, TSchema>
  >;
  return out;
};

/**
 * Build the `client.atomic` runtime for a schema. Each call gets a
 * fresh collector, runs the callback to gather operations, commits them
 * as one Action, and resolves to the callback's return value. The
 * committer enforces coherence; a server rejection of the submitted
 * Action becomes an {@link AtomicActionError}.
 */
export function createAtomicRuntime<S extends Schema<Record<string, AnyEntityDef>, unknown>>(
  schema: S,
  cap: AtomicCapability,
): <T>(build: (drafts: AtomicDrafts<S>) => T) => Promise<T> {
  const entityDefs = schema.entities as Record<string, AnyEntityDef>;
  return async function atomic<T>(build: (drafts: AtomicDrafts<S>) => T): Promise<T> {
    const collector: DraftCollector = {
      calls: [],
      intents: [],
      createdGroups: new Map(),
    };
    const drafts = buildDrafts(entityDefs, cap, collector);
    const result = build(drafts as AtomicDrafts<S>);
    collector.calls.push(...(await resolveMembershipIntents(collector.intents, cap)));
    const committed = await commit(collector.calls, cap);
    if (committed.response.rejected.length > 0) {
      throw new AtomicActionError(committed.response.rejected);
    }
    return result;
  };
}
