/**
 * The draft surface and its planner: the synchronous write verbs an
 * `defineAction` callback records work through, and the resolver that turns
 * that work into one wire Action.
 *
 * Two invariants shape the resolver. **Call order is the wire order**: a ready
 * call is pushed as-is, a verb that must read local state first records an
 * intent, and the resolver splices each intent's calls back into its own
 * position — so a created row's `put` precedes a later patch of it. **The batch
 * overlay outranks the capability**: `create` / `duplicate` seed the entity's
 * groups, membership verbs keep them current, and a read consults the overlay
 * before the live store so a later verb sees what the batch did rather than what
 * is materialized.
 */

import { generateId, type Entity, type FieldValue } from "@ebbjs/core";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { ModelDef, ShapeFields } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import type { ModelRegistry } from "@ebbjs/schema";
import type { Schema } from "@ebbjs/schema";
import {
  GROUPS_ACCESSOR,
  groupMemberSystemEntity,
  groupSystemEntity,
  type GroupFields,
  type GroupMemberFields,
} from "@ebbjs/schema";
import { commit, type CommitCapability } from "@ebbjs/write";
import {
  type AccessorKeyOf,
  type AnyRelationshipDef,
  type EntityNameOf,
  type SourceNameOf,
} from "./definition-types";
import type { LiveMembership } from "./entity-group";
import {
  entityGroupId,
  lastGroupMemberRefusal,
  type GroupMemberView,
  type LiveGroupMember,
} from "@ebbjs/write";
import type { EntityFields, EntityPatch, WireCreateStatic } from "./namespace";
import {
  ActionRejectedError,
  call,
  changeGroups,
  createEntity,
  createSystemEntity,
  deleteEntity,
  dropEntity,
  duplicateEntity,
  groupBootstrap,
  lastGroupMemberError,
  patchEntity,
  writeRelationship,
  type MembershipRemoval,
  type OperationCall,
  type RelationshipPointer,
  type ResolvedPointer,
} from "@ebbjs/write";
import { normalizePointer, type PointerValue } from "./query-builder";
import type { ManyPointerValue } from "./relationship";

export { ActionRejectedError, type ActionRejection } from "@ebbjs/write";

type AnyModelDef = ModelDef<Record<string, TSchema>>;

const DRAFT_HANDLE = Symbol.for("@ebbjs/action-draft-handle");

interface DraftHandle {
  readonly id: string;
}

const isDraftHandle = (value: unknown): value is DraftHandle =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[DRAFT_HANDLE] === true;

/** Stamp a create handle so later reference resolution recognises it. */
const markHandle = <T extends Record<string, unknown>>(handle: T): T => {
  Object.defineProperty(handle, DRAFT_HANDLE, { value: true, enumerable: false });
  return handle;
};

/**
 * Error raised when the planner cannot turn the collected drafts into a
 * valid batch — a self-referential field value, or a pointer value that
 * isn't a string / entity / handle.
 */
export class ActionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionResolutionError";
  }
}

/** Handle returned by a draft namespace's `create` / `duplicate`. Carries the id eagerly. */
export type CreatedEntity<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TFields>>
> & { readonly id: string } & Record<string, unknown>;

/**
 * One relationship pointer accepted by a draft `create`: a handle minted
 * earlier in the callback, an id, or an array of either. The resolver
 * distinguishes single- from many-cardinality by the registry's
 * declarations, so both shapes stay representable here.
 */
type DraftPointerInput = PointerValue | readonly PointerValue[];

/**
 * Per-write options. `validate: false` skips the local `Value.Check`
 * pass — useful for tests / pre-validated upstream callers. The
 * registry's name-membership check at `client.write()` still runs.
 */
export interface EntityWriteOptions {
  validate?: boolean;
}

/** A group reference accepted by the draft membership verbs: a group id or an entity-shape handle. */
export type GroupRef = string | { readonly id: string };

/** Point in time a draft `duplicate` copies from. */
export type DuplicateAt = "current" | "preSync";

/**
 * What a one-cardinality unlink's delete must name: the live edge's row id, or
 * the reason there is none.
 */
type UnlinkTarget =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unlinked" }
  | { readonly kind: "existing"; readonly relationshipId: string };

/**
 * Normalize the `{ groups }` option into a de-duplicated, non-empty
 * id list. Throws `EntityValidationError` when the option is missing,
 * empty, or carries a malformed pointer. `operation`/`label` name the
 * caller in the message so `create` and `setGroups` read distinctly.
 */
const resolveGroupIds = (
  groups: readonly GroupRef[] | undefined,
  entityName: string,
  operation = "create",
  label = "groups",
): readonly string[] => {
  const groupsRequired = (): EntityValidationError =>
    new EntityValidationError([
      {
        entityName,
        message: `${operation}: "${label}" is required and must contain at least one group id`,
      },
    ]);
  if (groups === undefined || groups.length === 0) {
    throw groupsRequired();
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    let id: string | null;
    try {
      id = normalizePointer(group, `${label} for "${entityName}"`);
    } catch (err) {
      throw new EntityValidationError([
        { entityName, message: err instanceof Error ? err.message : String(err) },
      ]);
    }
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw groupsRequired();
  }
  return ids;
};

/**
 * Normalize a single group ref for `addToGroup` / `removeFromGroup`.
 * A malformed ref throws `EntityValidationError` naming the operation.
 */
const resolveSingleGroupId = (group: GroupRef, entityName: string, operation: string): string => {
  let id: string | null;
  try {
    id = normalizePointer(group, `group for "${entityName}"`);
  } catch (err) {
    throw new EntityValidationError([
      {
        entityName,
        message: `${operation}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  if (id === null) {
    throw new EntityValidationError([
      { entityName, message: `${operation}: group ref is missing an id` },
    ]);
  }
  return id;
};

/**
 * Resolve an unlink's target before the planner emits `writeRelationship`.
 * The operation owns the accessor and declared-relationship refusals; this only
 * supplies the row id, or reports that there is nothing to delete.
 */
async function resolveUnlinkTarget(
  registry: ModelRegistry,
  entityName: string,
  sourceId: string,
  as: string,
  pointer: RelationshipPointer,
  readLink: ActionReads["relationshipLink"],
): Promise<UnlinkTarget> {
  if (pointer.targetId !== null || pointer.targetIds !== undefined) {
    return { kind: "not-applicable" };
  }
  if (as === GROUPS_ACCESSOR) return { kind: "not-applicable" };
  const rel = registry.getRelationship(entityName, as);
  if (rel === undefined || rel.sourceCardinality !== "one") {
    return { kind: "not-applicable" };
  }
  const link = await readLink(as, rel.type ?? entityName, sourceId);
  return link === undefined
    ? { kind: "unlinked" }
    : { kind: "existing", relationshipId: link.relationshipId };
}

/**
 * Options for a draft namespace's `create`. Mirrors the entity
 * namespace's create signature: `groups` is required and non-empty,
 * and one `entityGroup` row per group lands in the same Action.
 * `validate: false` skips the local field check.
 */
export interface DraftCreateOptions extends EntityWriteOptions {
  readonly groups: readonly GroupRef[];
}

/**
 * Options for a draft namespace's `duplicate`: which point in time to
 * copy from, the copy's membership set (the source's live groups when
 * omitted), and the same `validate` opt-out `create` accepts.
 */
export interface DraftDuplicateOptions extends EntityWriteOptions {
  /** Source of the copy: the live row (`"current"`, default) or the entity's earliest unresolved conflict's `before` row (`"preSync"`). */
  readonly at?: DuplicateAt;
  /** Membership set for the copy; defaults to the source's live groups. */
  readonly groups?: readonly GroupRef[];
}

/**
 * The local state a draft verb reads before it can build its Updates. Kept
 * apart from {@link CommitCapability} so the halves can be supplied
 * separately — a test seeds this one and captures the other.
 */
export interface ActionReads {
  /** Live `entityGroup` rows for an entity id. */
  memberships(entityId: string): Promise<readonly LiveMembership[]>;
  /** The live row of `entityType`, or `null` when it is absent or another type. */
  entity(entityType: string, entityId: string): Promise<Entity | null>;
  /** The `before` row of the entity's earliest unresolved conflict. */
  preSyncRow(entityId: string): Promise<Entity | null>;
  /** The live edge a one-cardinality unlink's delete must name. */
  relationshipLink(
    as: string,
    type: string,
    sourceId: string,
  ): Promise<{ readonly relationshipId: string } | undefined>;
  /** Live `groupMember` rows of a group, for the `last_group_member` guard. */
  groupMembers(groupId: string): Promise<readonly LiveGroupMember[]>;
}

/** The committer plus the local reads the planner resolves an intent against. */
export interface ActionCapability extends CommitCapability {
  readonly read: ActionReads;
}

/** What the batch knows about one entity id before any of it is materialized. */
interface BatchEntity {
  /** Groups the batch has filed the entity into. */
  groups: Set<string>;
  /** `entityGroup` row ids the batch knows, keyed by group. */
  membershipIds: Map<string, string>;
}

/** One membership delta against an entity's group set. */
interface GroupDelta {
  readonly puts: readonly string[];
  readonly removes: readonly string[];
}

/**
 * A verb the callback recorded that still needs a local read. Each one
 * names the entity it writes and the minimal state its resolver needs.
 */
type DraftIntent =
  | {
      readonly kind: "patch";
      readonly entity: string;
      readonly id: string;
      readonly patch: unknown;
      readonly validate: boolean | undefined;
    }
  | { readonly kind: "delete"; readonly entity: string; readonly id: string }
  | {
      readonly kind: "drop";
      readonly entity: string;
      readonly id: string;
      readonly fields: readonly string[];
    }
  | {
      readonly kind: "duplicate";
      readonly entity: string;
      readonly subjectId: string;
      readonly sourceId: string;
      readonly at: DuplicateAt;
      readonly groups: readonly GroupRef[] | undefined;
      readonly validate: boolean | undefined;
    }
  | {
      readonly kind: "relationship";
      readonly entity: string;
      readonly sourceId: string;
      readonly as: string;
      readonly pointer: RelationshipPointer;
    }
  | {
      readonly kind: "group-add";
      readonly entity: string;
      readonly id: string;
      readonly groupId: string;
    }
  | {
      readonly kind: "group-remove";
      readonly entity: string;
      readonly id: string;
      readonly groupId: string;
    }
  | {
      readonly kind: "set-groups";
      readonly entity: string;
      readonly id: string;
      readonly groupIds: readonly string[];
    }
  | {
      readonly kind: "member-patch";
      readonly id: string;
      readonly patch: Record<string, unknown>;
      readonly validate: boolean | undefined;
    }
  | { readonly kind: "member-delete"; readonly id: string };

/** One unit of planned work: a ready call, or a verb waiting on a read. */
type DraftStep =
  | { readonly kind: "call"; readonly call: OperationCall }
  | { readonly kind: "intent"; readonly intent: DraftIntent };

/** The state one Action callback accumulates while it runs. */
interface DraftCollector {
  readonly steps: DraftStep[];
  /** Batch-local membership state, consulted before the capability. */
  readonly batching: Map<string, BatchEntity>;
}

/** The reads and batch state an intent resolves against. */
interface ResolveContext {
  readonly cap: ActionCapability;
  readonly batching: Map<string, BatchEntity>;
}

/**
 * What a draft `create` accepts: the entity's fields (a field that is
 * also a relationship's `as` name takes its pointer type) and the forward
 * relationship pointers themselves.
 */
type DraftCreateInput<TFields extends Record<string, TSchema>, TCreateExtras extends object> = Omit<
  WireCreateStatic<TFields>,
  keyof TCreateExtras & string
> &
  TCreateExtras;

/**
 * Per-entity draft surface. `create` / `duplicate` return the minted id; the
 * rest record work for the enclosing Action and return nothing.
 */
export interface DraftNamespace<
  TFields extends Record<string, TSchema>,
  TCreateExtras extends object = Record<never, never>,
> {
  create(
    input: DraftCreateInput<TFields, TCreateExtras>,
    opts: DraftCreateOptions,
  ): CreatedEntity<TFields>;
  /**
   * Patch an existing entity in the same Action, validated the same way
   * as `create`'s input (during the commit, not at draft time).
   */
  update(id: string, patch: EntityPatch<TFields>, opts?: EntityWriteOptions): void;
  /** Soft-delete an existing entity: one `delete` Update whose `data` is `null`. */
  delete(id: string): void;
  /**
   * Detach components from an existing row: one `drop` Update per field. The
   * row survives — dropping the last component is not a delete. A row the
   * replica cannot see is refused locally, and a system component is not
   * droppable.
   */
  drop(id: string, fields: readonly (keyof TFields & string)[]): void;
  /**
   * Copy an existing row to a fresh id, carrying its field values
   * verbatim and landing in `opts.groups` (the source's live groups when
   * omitted). Returns the new id so a later verb can point at the copy.
   */
  duplicate(id: string, opts?: DraftDuplicateOptions): CreatedEntity<TFields>;
  /** One-cardinality link: a Relationship `put` in the same Action. */
  link(id: string, as: string, target: PointerValue): void;
  /** One-cardinality unlink; a missing live edge is a no-op. */
  unlink(id: string, as: string): void;
  /** Many-cardinality set: the source's canonical FK set plus one Relationship Update per target. */
  setLinks(id: string, as: string, patch: ManyPointerValue): void;
  /** File an existing entity into `groupId`; a group it already holds is a no-op. */
  addToGroup(id: string, groupId: GroupRef): void;
  /** Delete the membership row for `groupId`; a missing row is refused locally. */
  removeFromGroup(id: string, groupId: GroupRef): void;
  /** Replace the entity's membership set: `target − current` puts and `current − target` deletes. */
  setGroups(id: string, groupIds: readonly GroupRef[]): void;
}

/**
 * A draft system namespace: the content verbs minus the membership ones, since
 * an `entityGroup` row for a group or a member has no meaning.
 */
export type SystemDraftNamespace<TFields extends Record<string, TSchema>> = Omit<
  DraftNamespace<TFields>,
  "create" | "drop" | "addToGroup" | "removeFromGroup" | "setGroups"
> & {
  create(input: WireCreateStatic<TFields>, opts?: EntityWriteOptions): CreatedEntity<TFields>;
};

/**
 * `client.group.create`: the name is required, while `apps` is genuinely
 * optional — an absent scope means "every app", which is not `{}`.
 */
export type GroupDraftNamespace = Omit<SystemDraftNamespace<GroupFields>, "create"> & {
  create(
    input: {
      readonly name: string;
      readonly apps?: Record<string, boolean>;
    },
    opts?: EntityWriteOptions,
  ): CreatedEntity<GroupFields>;
};

/**
 * The `groupMember` draft namespace: the system surface, with `update` /
 * `delete` behind the local `last_group_member` guard, so leaving a group
 * is one Action alongside the content changes.
 */
export type MembershipDraftNamespace = SystemDraftNamespace<GroupMemberFields>;

/**
 * The forward relationship keys a draft `create` accepts, typed as pointer
 * values: the field map does not carry them, but a create may point at a
 * row — or a handle — directly.
 */
type DraftPointerInputs<TRels, TName extends string> = [TRels] extends [undefined]
  ? Record<never, never>
  : TRels extends Record<string, AnyRelationshipDef>
    ? {
        [K in keyof TRels as SourceNameOf<TRels[K]> extends TName
          ? AccessorKeyOf<TRels[K]>
          : never]?: DraftPointerInput;
      }
    : Record<never, never>;

/** Draft namespaces keyed by schema entity name, plus the system entities. */
export type ActionDrafts<S> =
  S extends Schema<infer TEntities, infer TRels>
    ? {
        [K in keyof TEntities & string]: DraftNamespace<
          EntityFields<TEntities[K]>,
          DraftPointerInputs<TRels, EntityNameOf<TEntities[K]>>
        >;
      } & {
        readonly group: GroupDraftNamespace;
        readonly membership: MembershipDraftNamespace;
      }
    : Record<string, never>;

/**
 * Resolve a field value into wire-safe data, collapsing draft handles to their
 * id. `seen` tracks the current path, so a back-edge is rejected while a shared
 * (DAG) reference is fine.
 */
export function resolveReferences(
  value: unknown,
  seen: Set<object> = new Set(),
): FieldValue["value"] {
  if (isDraftHandle(value)) return value.id;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new ActionResolutionError("cycle detected while resolving draft write fields");
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
 * Normalize a relationship pointer into target ids: a handle, an id, anything
 * with a string `.id`, or an array of those. `null` / `undefined` drop out.
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
      const id = normalizePointer(item, `draft pointer for "${entityName}.${as}"`);
      if (id !== null) out.push(id);
    } catch (err) {
      throw new ActionResolutionError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
};

const declaresField = (def: AnyModelDef, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(def.shape.properties ?? {}, key);

const record = (collector: DraftCollector, operationCall: OperationCall): void => {
  collector.steps.push({ kind: "call", call: operationCall });
};

const recordIntent = (collector: DraftCollector, intent: DraftIntent): void => {
  collector.steps.push({ kind: "intent", intent });
};

/**
 * Resolve one draft `create` into an operation call. The id is minted here
 * because the callback needs it before commit.
 */
const createDraftNamespace = <
  TFields extends Record<string, TSchema>,
  TCreateExtras extends object = Record<never, never>,
>(
  entityName: string,
  def: AnyModelDef,
  cap: ActionCapability,
  collector: DraftCollector,
): DraftNamespace<TFields, TCreateExtras> => ({
  create(input, opts) {
    const id = generateId("e");
    const source = (input ?? {}) as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    const pointers: ResolvedPointer[] = [];
    const handle: Record<string, unknown> = { id };
    const groups = resolveGroupIds(opts?.groups, entityName);

    for (const [key, value] of Object.entries(source)) {
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
          throw new ActionResolutionError(
            `draft: one-cardinality relationship "${entityName}.${key}" received ${targets.length} targets`,
          );
        }
        const targetId = targets[0];
        handle[key] = targetId ?? null;
        if (targetId !== undefined) {
          pointers.push({ as: key, type: rel.type, targetId });
        }
      }
    }

    collector.batching.set(id, {
      groups: new Set(groups),
      membershipIds: new Map(groups.map((groupId) => [groupId, entityGroupId(id, groupId)])),
    });
    record(
      collector,
      call(createEntity, {
        entity: entityName,
        id,
        fields,
        pointers,
        groups,
        validate: opts?.validate,
      }),
    );
    return markHandle(handle) as unknown as CreatedEntity<TFields>;
  },
  update(id, patch, opts) {
    recordIntent(collector, {
      kind: "patch",
      entity: entityName,
      id,
      patch,
      validate: opts?.validate,
    });
  },
  delete(id) {
    recordIntent(collector, { kind: "delete", entity: entityName, id });
  },
  drop(id, fields) {
    recordIntent(collector, { kind: "drop", entity: entityName, id, fields });
  },
  duplicate(id, opts) {
    const subjectId = generateId("e");
    recordIntent(collector, {
      kind: "duplicate",
      entity: entityName,
      subjectId,
      sourceId: id,
      at: opts?.at ?? "current",
      groups: opts?.groups,
      validate: opts?.validate,
    });
    return markHandle({ id: subjectId }) as unknown as CreatedEntity<TFields>;
  },
  link(id, as, target) {
    recordIntent(collector, {
      kind: "relationship",
      entity: entityName,
      sourceId: id,
      as,
      pointer: { targetId: target },
    });
  },
  unlink(id, as) {
    recordIntent(collector, {
      kind: "relationship",
      entity: entityName,
      sourceId: id,
      as,
      pointer: { targetId: null },
    });
  },
  setLinks(id, as, patch) {
    recordIntent(collector, {
      kind: "relationship",
      entity: entityName,
      sourceId: id,
      as,
      pointer: { targetIds: patch },
    });
  },
  addToGroup(id, groupId) {
    recordIntent(collector, {
      kind: "group-add",
      entity: entityName,
      id,
      groupId: resolveSingleGroupId(groupId, entityName, "addToGroup"),
    });
  },
  removeFromGroup(id, groupId) {
    recordIntent(collector, {
      kind: "group-remove",
      entity: entityName,
      id,
      groupId: resolveSingleGroupId(groupId, entityName, "removeFromGroup"),
    });
  },
  setGroups(id, groupIds) {
    recordIntent(collector, {
      kind: "set-groups",
      entity: entityName,
      id,
      groupIds: resolveGroupIds(groupIds, entityName, "setGroups", "groupIds"),
    });
  },
});

const sharedSystemVerbs = <TFields extends Record<string, TSchema>>(
  namespace: DraftNamespace<TFields>,
): Omit<SystemDraftNamespace<TFields>, "create"> => ({
  update: namespace.update,
  delete: namespace.delete,
  duplicate: namespace.duplicate,
  link: namespace.link,
  unlink: namespace.unlink,
  setLinks: namespace.setLinks,
});

/**
 * The system draft namespaces. Only `create` differs from the content surface:
 * `group.create` bootstraps the group row plus the actor's membership, and
 * `membership.create` is a single `groupMember` put.
 */
const createSystemDrafts = (
  cap: ActionCapability,
  collector: DraftCollector,
): {
  group: GroupDraftNamespace;
  membership: MembershipDraftNamespace;
} => {
  const group = createDraftNamespace<GroupFields>("group", groupSystemEntity, cap, collector);
  const membership = createDraftNamespace<GroupMemberFields>(
    "groupMember",
    groupMemberSystemEntity,
    cap,
    collector,
  );
  return {
    group: {
      ...sharedSystemVerbs(group),
      create(input, opts) {
        const bootstrap = groupBootstrap(cap.registry, input.name, opts?.validate, cap.appId);
        record(collector, bootstrap.call);
        return markHandle({
          id: bootstrap.groupId,
          name: input.name,
        }) as unknown as CreatedEntity<GroupFields>;
      },
    },
    membership: {
      ...sharedSystemVerbs(membership),
      create(input, opts) {
        const id = generateId("e");
        record(
          collector,
          call(createSystemEntity, {
            entity: "groupMember",
            id,
            fields: input as unknown as Record<string, unknown>,
            validate: opts?.validate,
          }),
        );
        return markHandle({ id, ...input }) as unknown as CreatedEntity<GroupMemberFields>;
      },
      update(id, patch, opts) {
        recordIntent(collector, {
          kind: "member-patch",
          id,
          patch: patch as Record<string, unknown>,
          validate: opts?.validate,
        });
      },
      delete(id) {
        recordIntent(collector, { kind: "member-delete", id });
      },
    },
  };
};

const buildDrafts = (
  entityDefs: Record<string, AnyModelDef>,
  cap: ActionCapability,
  collector: DraftCollector,
): Record<string, DraftNamespace<Record<string, TSchema>>> => {
  const out: Record<string, DraftNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(entityDefs)) {
    // The map key is the draft handle's property name; the entity's own
    // name is what the wire carries.
    out[name] = createDraftNamespace<Record<string, TSchema>>(def.name, def, cap, collector);
  }
  const system = createSystemDrafts(cap, collector);
  out["group"] = system.group as unknown as DraftNamespace<Record<string, TSchema>>;
  out["membership"] = system.membership as unknown as DraftNamespace<Record<string, TSchema>>;
  return out;
};

/**
 * The groupMember guard's reads over the client capability, so the
 * draft verbs refuse exactly what the imperative membership verbs do.
 */
const groupMemberView = (cap: ActionCapability): GroupMemberView => ({
  row: (id) => cap.read.entity("groupMember", id),
  groupMembers: (groupId) => cap.read.groupMembers(groupId),
});

/** The entity's group set: the overlay when the batch touched it, else a live read. */
const readGroups = async (ctx: ResolveContext, id: string): Promise<readonly string[]> => {
  const batch = ctx.batching.get(id);
  if (batch !== undefined) return [...batch.groups];
  return (await ctx.cap.read.memberships(id)).map((membership) => membership.groupId);
};

/** The entity's membership state, seeding the overlay from the live view once. */
const readMembershipState = async (ctx: ResolveContext, id: string): Promise<BatchEntity> => {
  const existing = ctx.batching.get(id);
  if (existing !== undefined) return existing;
  const live = await ctx.cap.read.memberships(id);
  const entry: BatchEntity = {
    groups: new Set(live.map((membership) => membership.groupId)),
    membershipIds: new Map(live.map((membership) => [membership.groupId, membership.membershipId])),
  };
  ctx.batching.set(id, entry);
  return entry;
};

/**
 * Emit one `changeGroups` call for the net delta and carry it into the
 * batch overlay. An add the entity already holds is a no-op, which is what
 * keeps a retry safe.
 */
const applyGroupDelta = async (
  intent: { readonly entity: string; readonly id: string },
  delta: GroupDelta,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const state = await readMembershipState(ctx, intent.id);
  const currentGroups = [...state.groups];
  const puts = delta.puts.filter((groupId) => !state.groups.has(groupId));
  const removals: MembershipRemoval[] = [];
  for (const groupId of delta.removes) {
    const membershipId = state.membershipIds.get(groupId);
    if (membershipId === undefined) {
      throw new EntityValidationError([
        {
          entityName: intent.entity,
          message: `removeFromGroup: no entityGroup membership row for "${intent.id}" in group "${groupId}"`,
        },
      ]);
    }
    removals.push({ membershipId, groupId });
  }
  if (puts.length === 0 && removals.length === 0) return [];
  for (const groupId of puts) {
    state.groups.add(groupId);
    state.membershipIds.set(groupId, entityGroupId(intent.id, groupId));
  }
  for (const removal of removals) {
    state.groups.delete(removal.groupId);
    state.membershipIds.delete(removal.groupId);
  }
  return [
    call(changeGroups, {
      entity: intent.entity,
      entityId: intent.id,
      puts,
      removes: removals,
      currentGroups,
    }),
  ];
};

/** `update` / `delete`: the entity's live group set is the write's scope. */
const resolveEntityWrite = async (
  intent: Extract<DraftIntent, { kind: "patch" | "delete" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const groups = await readGroups(ctx, intent.id);
  if (intent.kind === "patch") {
    return [
      call(patchEntity, {
        entity: intent.entity,
        id: intent.id,
        payload: intent.patch,
        groups,
        validate: intent.validate,
      }),
    ];
  }
  return [call(deleteEntity, { entity: intent.entity, id: intent.id, groups })];
};

/**
 * `drop`: a component detach lands on the row's membership scope and needs a
 * row the replica can actually see — an Update for an invisible row would lose
 * its intent on the way to the server, so it is refused here instead.
 */
const resolveDrop = async (
  intent: Extract<DraftIntent, { kind: "drop" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const row = await ctx.cap.read.entity(intent.entity, intent.id);
  if (row === null || row.type !== intent.entity) {
    throw new ActionResolutionError(
      `drop: no ${intent.entity} row for id "${intent.id}" is visible to this action`,
    );
  }
  return [
    call(dropEntity, {
      entity: intent.entity,
      id: intent.id,
      fields: intent.fields,
      groups: await readGroups(ctx, intent.id),
    }),
  ];
};

/** The copy's groups default to the source's live set. */
const resolveDuplicate = async (
  intent: Extract<DraftIntent, { kind: "duplicate" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const source =
    intent.at === "preSync"
      ? await ctx.cap.read.preSyncRow(intent.sourceId)
      : await ctx.cap.read.entity(intent.entity, intent.sourceId);
  if (source === null || source.type !== intent.entity) {
    throw new EntityValidationError([
      {
        entityName: intent.entity,
        message:
          intent.at === "preSync"
            ? `duplicate: no unresolved conflict for "${intent.sourceId}"`
            : `duplicate: no ${intent.entity} row for id "${intent.sourceId}"`,
      },
    ]);
  }
  const groups = resolveGroupIds(
    intent.groups ?? (await readGroups(ctx, intent.sourceId)),
    intent.entity,
    "duplicate",
  );
  // The copy is not in the local store yet, so the batch carries its
  // membership state for the verbs that follow it.
  ctx.batching.set(intent.subjectId, {
    groups: new Set(groups),
    membershipIds: new Map(
      groups.map((groupId) => [groupId, entityGroupId(intent.subjectId, groupId)]),
    ),
  });
  return [
    call(duplicateEntity, {
      entity: intent.entity,
      subjectId: intent.subjectId,
      source,
      groups,
      validate: intent.validate,
    }),
  ];
};

/**
 * `link` / `unlink` / `setLinks`: a one-cardinality unlink resolves the
 * live edge's row id first, and an unlink with no live edge emits
 * nothing. The operation itself owns the built-in-accessor and
 * undeclared-relationship refusals.
 */
const resolveRelationship = async (
  intent: Extract<DraftIntent, { kind: "relationship" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const target = await resolveUnlinkTarget(
    ctx.cap.registry,
    intent.entity,
    intent.sourceId,
    intent.as,
    intent.pointer,
    ctx.cap.read.relationshipLink,
  );
  if (target.kind === "unlinked") return [];
  return [
    call(writeRelationship, {
      entity: intent.entity,
      sourceId: intent.sourceId,
      as: intent.as,
      pointer: intent.pointer,
      relationshipSubjectId: target.kind === "existing" ? target.relationshipId : undefined,
      groups: await readGroups(ctx, intent.sourceId),
    }),
  ];
};

const resolveGroupVerb = async (
  intent: Extract<DraftIntent, { kind: "group-add" | "group-remove" | "set-groups" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  switch (intent.kind) {
    case "group-add":
      return applyGroupDelta(intent, { puts: [intent.groupId], removes: [] }, ctx);
    case "group-remove":
      return applyGroupDelta(intent, { puts: [], removes: [intent.groupId] }, ctx);
    case "set-groups": {
      const target = new Set(intent.groupIds);
      const state = await readMembershipState(ctx, intent.id);
      return applyGroupDelta(
        intent,
        {
          puts: intent.groupIds.filter((groupId) => !state.groups.has(groupId)),
          removes: [...state.groups].filter((groupId) => !target.has(groupId)),
        },
        ctx,
      );
    }
  }
};

/** `membership.update`: the `last_group_member` guard, then the patch. */
const resolveMemberPatch = async (
  intent: Extract<DraftIntent, { kind: "member-patch" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  // Only a permission-only patch is locally provable. A patch that
  // moves the member to another group changes which group is at risk,
  // so leave it to the server; a patch that does not touch
  // `permissions` cannot empty a list either. Changing `actor_id`
  // keeps the same group, so it stays provable.
  const permissions = intent.patch["permissions"];
  if (permissions !== undefined && intent.patch["group_id"] === undefined) {
    const details = await lastGroupMemberRefusal(groupMemberView(ctx.cap), intent.id, {
      removedIds: [],
      upserts: [{ id: intent.id, permissions: permissions as readonly string[] }],
    });
    if (details !== undefined) throw lastGroupMemberError(intent.id, details);
  }
  return [
    call(patchEntity, {
      entity: "groupMember",
      id: intent.id,
      payload: intent.patch,
      groups: await readGroups(ctx, intent.id),
      validate: intent.validate,
    }),
  ];
};

/** `membership.delete`: the same guard, then the soft delete. */
const resolveMemberDelete = async (
  intent: Extract<DraftIntent, { kind: "member-delete" }>,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  const details = await lastGroupMemberRefusal(groupMemberView(ctx.cap), intent.id, {
    removedIds: [intent.id],
    upserts: [],
  });
  if (details !== undefined) throw lastGroupMemberError(intent.id, details);
  return [
    call(deleteEntity, {
      entity: "groupMember",
      id: intent.id,
      groups: await readGroups(ctx, intent.id),
    }),
  ];
};

const resolveIntent = async (
  intent: DraftIntent,
  ctx: ResolveContext,
): Promise<readonly OperationCall[]> => {
  switch (intent.kind) {
    case "patch":
    case "delete":
      return resolveEntityWrite(intent, ctx);
    case "drop":
      return resolveDrop(intent, ctx);
    case "duplicate":
      return resolveDuplicate(intent, ctx);
    case "relationship":
      return resolveRelationship(intent, ctx);
    case "group-add":
    case "group-remove":
    case "set-groups":
      return resolveGroupVerb(intent, ctx);
    case "member-patch":
      return resolveMemberPatch(intent, ctx);
    case "member-delete":
      return resolveMemberDelete(intent, ctx);
  }
};

/** Resolve each recorded step in call order, splicing intents into place. */
const resolveSteps = async (
  collector: DraftCollector,
  cap: ActionCapability,
): Promise<OperationCall[]> => {
  const ctx: ResolveContext = { cap, batching: collector.batching };
  const calls: OperationCall[] = [];
  for (const step of collector.steps) {
    if (step.kind === "call") {
      calls.push(step.call);
      continue;
    }
    calls.push(...(await resolveIntent(step.intent, ctx)));
  }
  return calls;
};

/**
 * Build the Action runtime for a schema. Each call gets a fresh
 * collector, runs the callback to gather work, resolves the intents it
 * recorded, commits everything as one Action, and resolves to the
 * callback's return value. A server rejection of the submitted Action
 * becomes an {@link ActionRejectedError}.
 */
export function createActionRuntime<S extends Schema<Record<string, AnyModelDef>, unknown>>(
  schema: S,
  cap: ActionCapability,
): <T>(build: (drafts: ActionDrafts<S>) => T) => Promise<T> {
  const entityDefs = schema.models as Record<string, AnyModelDef>;
  return async function run<T>(build: (drafts: ActionDrafts<S>) => T): Promise<T> {
    const collector: DraftCollector = { steps: [], batching: new Map() };
    const drafts = buildDrafts(entityDefs, cap, collector);
    const result = build(drafts as ActionDrafts<S>);
    const committed = await commit(await resolveSteps(collector, cap), cap);
    if (committed.response.rejected.length > 0) {
      throw new ActionRejectedError(committed.response.rejected);
    }
    return result;
  };
}
