/**
 * The invocation's write surface: one buffer of Updates, the overlay reads
 * resolve against, and the verbs that fill it.
 *
 * Every verb resolves through `@ebbjs/write`'s shared verb table and runs the
 * planner operation synchronously, so field validation, relationship
 * resolution, and the membership pre-flight fail at the offending call rather
 * than at return. The buffer goes out as exactly one Action — on
 * `ctx.commit()` or when the runner flushes a handler that returned — and is
 * sealed from the moment it is submitted.
 */

import {
  componentField,
  componentModel,
  ebbComponentField,
  ebbComponentKind,
  EBB_MODEL_NAME,
  generateId,
  isEbbComponent,
  isFieldMap,
  localEvent,
  type EbbComponentKind,
  type FieldValue,
  type HLCState,
  type Update,
} from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";
import { EntityValidationError, type ModelRegistry } from "@ebbjs/schema";
import {
  createHandle,
  normalizeGroupIds,
  operationCallFor,
  requireRelationship,
  type CreateHandle,
  type LiveGroupMember,
  type OperationCall,
  type OperationIds,
  type OpContext,
  type PointerTarget,
  type RelateVerb,
  type UnrelateVerb,
  type UpdateVerb,
  UNRESOLVED,
} from "@ebbjs/write";

import { callFailure, commitAction, readCommitOutcome, type CommitOutcome } from "./commit.ts";
import { MissingSchemaError, WritesCommittedError } from "./errors.ts";
import { createOverlay } from "./overlay.ts";
import {
  assertLastGroupMember,
  assertLastMembership,
  assertMembershipScope,
  type PreflightView,
} from "./preflight.ts";
import type { HostTransport } from "./transport.ts";

/** Options for {@link WriteSurface.create}. */
export interface CreateOptions {
  /** The groups the new row is filed into. Required and non-empty, as in the client API. */
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

/** Options for {@link WriteSurface.unrelate}. */
export interface UnrelateOptions {
  /**
   * A one-cardinality edge's `relationship` row id. Required unless this
   * invocation created the edge: `ctx.get` cannot read relationship rows in
   * v1, so an edge that predates the call has no other way to be named.
   */
  readonly relationshipId?: string;
}

export interface WriteSurfaceOptions {
  readonly transport: HostTransport;
  readonly invocationId: string;
  readonly actorId: string;
  readonly ids: OperationIds;
  readonly registry?: ModelRegistry;
}

export interface WriteSurface extends PreflightView {
  /** Read one entity through the overlay. */
  read(id: string): Promise<EntityResponse | null>;
  create(entity: string, fields: Record<string, unknown>, options: CreateOptions): CreateHandle;
  update(entity: string, id: string, patch: Record<string, unknown>, options?: WriteOptions): void;
  delete(entity: string, id: string): void;
  relate(
    entity: string,
    sourceId: string,
    as: string,
    targets: PointerTarget | readonly PointerTarget[],
  ): void;
  unrelate(
    entity: string,
    sourceId: string,
    as: string,
    target?: PointerTarget,
    options?: UnrelateOptions,
  ): Promise<void>;
  /** Submit the buffered Updates as one Action and seal the buffer. */
  commit(): Promise<CommitOutcome>;
}

/** The key a buffered link edge is found by. */
const edgeKey = (type: string, sourceId: string, as: string): string =>
  `${type}\u0000${sourceId}\u0000${as}`;

/**
 * The model a component write commits under: `ebb` for a platform component, the
 * component's own namespace otherwise. The two coincide today; #820's overlay
 * components are where they stop coinciding.
 */
const committedModelOf = (component: string): string =>
  isEbbComponent(component) ? EBB_MODEL_NAME : componentModel(component);

const stringListField = (
  fields: Record<string, FieldValue>,
  key: string,
): readonly string[] | undefined => {
  const field = fields[key];
  if (field === undefined || isFieldMap(field)) return undefined;
  const value = field.value;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
};

/** A component's projected plain value, from the buffered row so far. */
const plainField = (fields: Record<string, unknown>, key: string): unknown => fields[key];

/** One platform component's atomic value from a buffered row or a patch, or `undefined`. */
const platformValue = (
  values: Record<string, unknown>,
  kind: EbbComponentKind,
): Record<string, unknown> | undefined => {
  const value = plainField(values, ebbComponentField(kind));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const stringValue = (fields: Record<string, unknown>, key: string): string | undefined => {
  const value = plainField(fields, key);
  return typeof value === "string" ? value : undefined;
};

const stringListValue = (
  fields: Record<string, unknown>,
  key: string,
): readonly string[] | undefined => {
  const value = plainField(fields, key);
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
};

/** Whatever value a projected list field carries, when it is a list of ids. */
export const createWriteSurface = (options: WriteSurfaceOptions): WriteSurface => {
  const { transport, invocationId, actorId, ids, registry } = options;

  /** Buffered Updates, in wire order — the Action's `updates[]`. */
  const updates: Update[] = [];
  const updatesById = new Map<string, Update[]>();
  const types = new Map<string, string>();
  /** Membership row id → the group it scopes to. */
  const membershipGroup = new Map<string, string>();
  /** Membership row id → the entity it files. */
  const membershipEntity = new Map<string, string>();
  /** Row id → the platform kind its buffered writes named. */
  const rowKinds = new Map<string, EbbComponentKind>();
  /** Entity id → groups this invocation has filed/or scoped it into. */
  const groupsByEntity = new Map<string, Set<string>>();
  /** Group ids this invocation created; their member rosters are knowable. */
  const createdGroups = new Set<string>();
  /** Group id → the member rows of that group this invocation wrote. */
  const membersByGroup = new Map<string, Map<string, readonly string[]>>();
  /** Grant row id → its group. */
  const memberGroup = new Map<string, string>();
  /** Edge key → the live buffered edge, or `gone` when a buffered delete removed it. */
  const edges = new Map<
    string,
    { readonly relationshipId: string; readonly targetId: string } | "gone"
  >();
  /** Link row id → the edge key it belongs to. */
  const edgeKeys = new Map<string, string>();

  let sealed = false;

  const requireRegistry = (): ModelRegistry => {
    if (registry === undefined) throw new MissingSchemaError();
    return registry;
  };

  const assertWritable = (): void => {
    if (sealed) throw new WritesCommittedError();
  };

  const addGroup = (entityId: string, groupId: string): void => {
    const held = groupsByEntity.get(entityId) ?? new Set<string>();
    held.add(groupId);
    groupsByEntity.set(entityId, held);
  };

  const removeGroup = (entityId: string, groupId: string): void => {
    groupsByEntity.get(entityId)?.delete(groupId);
  };

  const markEdgeGone = (relationshipId: string): void => {
    const key = edgeKeys.get(relationshipId);
    if (key === undefined) return;
    edges.set(key, "gone");
    edgeKeys.delete(relationshipId);
  };

  /**
   * The plain component values each buffered subject carries so far. A row's
   * components arrive as separate Updates, so the index folds them here before
   * resolving a membership or an edge.
   */
  const rowValues = new Map<string, Record<string, unknown>>();

  /** Fold one component Update into the subject's plain values. */
  const foldRow = (update: Update): Record<string, unknown> | undefined => {
    if (update.method === "delete") return undefined;
    const field = componentField(update.component);
    const previous = rowValues.get(update.subject_id) ?? {};
    const values = { ...previous };
    if (update.method === "drop") delete values[field];
    else values[field] = isFieldMap(update.data) ? undefined : update.data.value;
    rowValues.set(update.subject_id, values);
    return values;
  };

  /**
   * Index one buffered Update so later verbs and reads can resolve against it.
   * The dispatch is on the component: the four kinds share one committed model.
   */
  const indexWrite = (update: Update): void => {
    const id = update.subject_id;
    if (update.method === "delete") {
      const kind = rowKinds.get(id);
      rowKinds.delete(id);
      if (kind === "membership") {
        removeGroup(membershipEntity.get(id) ?? "", membershipGroup.get(id) ?? "");
        membershipGroup.delete(id);
        membershipEntity.delete(id);
        return;
      }
      if (kind === "link") {
        markEdgeGone(id);
        return;
      }
      if (kind === "grant") {
        const groupId = memberGroup.get(id);
        if (groupId !== undefined) {
          membersByGroup.get(groupId)?.delete(id);
          memberGroup.delete(id);
        }
      }
      rowValues.delete(id);
      return;
    }

    const kind = ebbComponentKind(update.component);
    const values = foldRow(update);
    if (values === undefined) return;
    if (kind === null) return;
    rowKinds.set(id, kind);

    const value = platformValue(values, kind);
    if (value === undefined) return;

    switch (kind) {
      case "membership": {
        const groupId = stringValue(value, "group_id");
        const entityId = stringValue(value, "entity_id");
        if (groupId === undefined || entityId === undefined) return;
        membershipGroup.set(id, groupId);
        membershipEntity.set(id, entityId);
        addGroup(entityId, groupId);
        return;
      }
      case "link": {
        const sourceId = stringValue(value, "source_id");
        const field = stringValue(value, "field");
        const type = stringValue(value, "type");
        const targetId = stringValue(value, "target_id");
        if (
          sourceId === undefined ||
          field === undefined ||
          type === undefined ||
          targetId === undefined
        ) {
          return;
        }
        const key = edgeKey(type, sourceId, field);
        edges.set(key, { relationshipId: id, targetId });
        edgeKeys.set(id, key);
        return;
      }
      case "group": {
        createdGroups.add(id);
        addGroup(id, id);
        return;
      }
      case "grant": {
        const groupId = stringValue(value, "group_id");
        if (groupId === undefined) return;
        const permissions = stringListValue(value, "permissions") ?? [];
        memberGroup.set(id, groupId);
        const roster = membersByGroup.get(groupId) ?? new Map<string, readonly string[]>();
        roster.set(id, permissions);
        membersByGroup.set(groupId, roster);
        addGroup(id, groupId);
        return;
      }
    }
  };

  const record = (batch: readonly Update[]): void => {
    for (const update of batch) {
      updates.push(update);
      const held = updatesById.get(update.subject_id);
      if (held === undefined) updatesById.set(update.subject_id, [update]);
      else held.push(update);
      if (update.method !== "delete") {
        types.set(update.subject_id, committedModelOf(update.component));
      }
      indexWrite(update);
    }
  };

  const opContext: OpContext = {
    registry: registry as ModelRegistry,
    ids,
    actorId,
  };

  const run = (entry: OperationCall | undefined): readonly Update[] => {
    if (entry === undefined) return [];
    const result = entry.operation(opContext, entry.input);
    record(result.updates);
    return result.updates;
  };

  const groupsOf = (entityId: string): readonly string[] => [
    ...(groupsByEntity.get(entityId) ?? []),
  ];

  const groupOfMembership = (membershipId: string): string | undefined =>
    membershipGroup.get(membershipId);

  const groupMembersOf = (groupId: string): readonly LiveGroupMember[] | undefined => {
    if (!createdGroups.has(groupId)) return undefined;
    const roster = membersByGroup.get(groupId) ?? new Map<string, readonly string[]>();
    return [...roster].map(([id, permissions]) => ({ id, groupId, permissions }));
  };

  const relationshipIdFor = (
    sourceId: string,
    as: string,
    type: string,
  ): string | null | undefined => {
    const edge = edges.get(edgeKey(type, sourceId, as));
    if (edge === undefined) return undefined;
    return edge === "gone" ? null : edge.relationshipId;
  };

  const preflightView: PreflightView = { groupsOf, groupOfMembership, groupMembersOf };

  const readHost = async (id: string): Promise<EntityResponse | null> => {
    try {
      const value = await transport.call("get", { id });
      return (value ?? null) as EntityResponse | null;
    } catch (error) {
      throw callFailure(error, "get");
    }
  };

  const overlay = createOverlay({
    updatesFor: (id) => updatesById.get(id) ?? [],
    typeOf: (id) => types.get(id),
    readHost,
  });

  const read = async (id: string): Promise<EntityResponse | null> => {
    if (typeof id !== "string" || id === "") {
      throw new TypeError("ctx.get(id) requires a non-empty entity id");
    }
    return overlay.read(id);
  };

  /** Refuse a grant patch that would empty its group's capable members. */
  const guardGrantUpdate = (id: string, patch: Record<string, unknown>): void => {
    const value = platformValue(patch, "grant");
    if (value === undefined) return;
    const groupId = memberGroup.get(id);
    const nextGroupId = stringValue(value, "group_id");
    const permissions = value["permissions"];
    // Only a same-group permission write is locally provable. A move between
    // groups re-points the grant, which the server refuses.
    if (groupId === undefined || nextGroupId !== groupId) return;
    if (!Array.isArray(permissions)) return;
    if (!permissions.every((entry) => typeof entry === "string")) return;
    assertLastGroupMember({ groupsOf, groupOfMembership, groupMembersOf }, id, groupId, {
      removedIds: [],
      upserts: [{ id, permissions }],
    });
  };

  const guardMemberDelete = (id: string): void => {
    const groupId = memberGroup.get(id);
    if (groupId === undefined) return;
    assertLastGroupMember(preflightView, id, groupId, { removedIds: [id], upserts: [] });
  };

  const guardMembershipDelete = (membershipId: string): void => {
    const groupId = membershipGroup.get(membershipId);
    const entityId = membershipEntity.get(membershipId);
    if (groupId === undefined || entityId === undefined) return;
    assertLastMembership(preflightView, types.get(entityId) ?? "", entityId, [groupId]);
  };

  const create = (
    entity: string,
    fields: Record<string, unknown>,
    createOptions: CreateOptions,
  ): CreateHandle => {
    assertWritable();
    const schema = requireRegistry();
    if (schema.get(entity) === undefined) {
      throw new EntityValidationError([
        {
          entityName: entity,
          message: `create: entity "${entity}" is not registered in the schema`,
        },
      ]);
    }
    const groups = normalizeGroupIds(createOptions.groups, entity);
    const id = createOptions.id ?? ids.newId("e");
    const batch = run(
      operationCallFor(schema, {
        verb: "create",
        entity,
        id,
        fields,
        groups,
        validate: createOptions.validate,
      }),
    );
    assertMembershipScope(
      preflightView,
      entity,
      id,
      batch.filter(
        (update) =>
          update.method !== "delete" && ebbComponentKind(update.component) === "membership",
      ),
    );
    return createHandle(id);
  };

  const update = (
    entity: string,
    id: string,
    patch: Record<string, unknown>,
    writeOptions?: WriteOptions,
  ): void => {
    assertWritable();
    const schema = requireRegistry();
    if (rowKinds.get(id) === "grant") guardGrantUpdate(id, patch);
    const verb: UpdateVerb = {
      verb: "update",
      entity,
      id,
      patch,
      groups: groupsOf(id),
      validate: writeOptions?.validate,
    };
    run(operationCallFor(schema, verb));
  };

  const remove = (entity: string, id: string): void => {
    assertWritable();
    const schema = requireRegistry();
    // A delete names no component, so a row's kind is knowable only when this
    // invocation wrote the row itself; anything else defers to the server.
    const kind = rowKinds.get(id);
    if (kind === "membership") guardMembershipDelete(id);
    if (kind === "grant") guardMemberDelete(id);
    run(operationCallFor(schema, { verb: "delete", entity, id, groups: groupsOf(id) }));
  };

  const relate = (
    entity: string,
    sourceId: string,
    as: string,
    targets: PointerTarget | readonly PointerTarget[],
  ): void => {
    assertWritable();
    const schema = requireRegistry();
    const verb: RelateVerb = Array.isArray(targets)
      ? { verb: "relate", entity, id: sourceId, as, targets, groups: groupsOf(sourceId) }
      : {
          verb: "relate",
          entity,
          id: sourceId,
          as,
          target: targets as PointerTarget,
          groups: groupsOf(sourceId),
        };
    run(operationCallFor(schema, verb));
  };

  const unrelate = async (
    entity: string,
    sourceId: string,
    as: string,
    target?: PointerTarget,
    unrelateOptions?: UnrelateOptions,
  ): Promise<void> => {
    assertWritable();
    const schema = requireRegistry();
    const rel = requireRelationship(schema, entity, as);
    // A many-cardinality unlink of one target computes the remainder from the
    // source row's canonical FK set, which only a read can supply.
    let fkTargets: readonly string[] | undefined;
    if (rel.sourceCardinality === "many" && target !== undefined) {
      const view = await read(sourceId);
      fkTargets =
        view === null
          ? undefined
          : stringListField(view.data.fields as Record<string, FieldValue>, as);
      if (fkTargets === undefined) {
        throw new EntityValidationError([
          {
            entityName: entity,
            field: as,
            message:
              `unrelate: cannot resolve the current "${as}" FK set for "${sourceId}"; ` +
              `read the row with ctx.get before unlinking one target, or call unrelate without one to clear the set`,
          },
        ]);
      }
    }
    const verb: UnrelateVerb = {
      verb: "unrelate",
      entity,
      id: sourceId,
      as,
      target,
      relationshipId: unrelateOptions?.relationshipId,
      groups: groupsOf(sourceId),
    };
    run(
      operationCallFor(schema, verb, {
        ...UNRESOLVED,
        groupsOf,
        relationshipIdFor,
        fkTargetsOf: () => fkTargets,
      }),
    );
  };

  const commit = async (): Promise<CommitOutcome> => {
    if (updates.length === 0) return { replayed: false };
    if (invocationId === "") {
      throw new Error(
        "ctx.commit() requires a non-empty invocation id: the Action id is derived from it",
      );
    }
    const action = commitAction({ invocationId, actorId, hlc: ids.hlc(), updates });
    // The same registry pass the client runs before it enqueues an Action, so a
    // write the server would reject on field-name membership never leaves here.
    const violations = registry?.validateAction(action) ?? [];
    if (violations.length > 0) throw new EntityValidationError(violations);
    sealed = true;
    updates.length = 0;
    updatesById.clear();
    try {
      return readCommitOutcome(await transport.call("commit", action));
    } catch (error) {
      throw callFailure(error, "commit");
    }
  };

  return {
    read,
    create,
    update,
    delete: remove,
    relate,
    unrelate,
    commit,
    groupsOf,
    groupOfMembership,
    groupMembersOf,
  };
};

/** The default ids/clock a context uses when the caller supplies none. */
export const defaultOperationIds = (clock: HLCState): OperationIds => ({
  updateId: () => generateId("u"),
  hlc: () => localEvent(clock),
  newId: (prefix: string) => generateId(prefix),
});
