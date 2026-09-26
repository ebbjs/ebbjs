/**
 * Instance handle — `TodoHandle`, `ListHandle`, etc.
 *
 * The shape returned by `client.todo(todoId)`. The handle wraps a
 * single materialized entity id and exposes:
 *
 * - **Field getters** for every field declared on the entity. The
 *   getters read from a synchronous snapshot kept on the
 *   `SyncClient` (populated by `client.readLocalEntity` and by
 *   every `_applyAction` receipt). Returns `undefined` for absent
 *   fields, matching the storage-adapter's behavior (per Path A on
 *   #158).
 *
 * - **`.entity` escape hatch** for users who need the full wire
 *   envelope (set / nulled / absent distinction — per Path A on
 *   #158).
 *
 * - **Forward relationship accessors** for every `defineRelationship`
 *   on this entity as source. Each one delegates to
 *   `client.relationship({...}).forward(id)` from #149;
 *   `sourceCardinality: "one"` resolves to `Promise<Entity | null>`
 *   (nullable FK narrows the static type); `sourceCardinality: "many"`
 *   resolves to a typed `QueryBuilder` over the target entity's
 *   field map.
 *
 * - **Reverse relationship accessors** for every relationship that
 *   targets this entity. All reverse accessors resolve to a typed
 *   `QueryBuilder` (per #127 / #149: the source side is always a
 *   collection).
 *
 * The handle is a thin wrapper over the relationship primitive
 * (from #149) plus the cached entity read path. It does not own
 * state of its own beyond the entity id and a reference to the
 * `SyncClient`.
 */

import type { Entity } from "@ebbjs/core";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import type { SyncClient } from "./client";
import type {
  EntityHandle,
  EntityRelationshipAccessors,
  ForwardManyAccessor,
  ForwardOneAccessor,
  ReverseAccessor,
} from "./namespace";
import { forwardMany, forwardOne, forwardOneNullable, reverse } from "./relationship";

/**
 * Build an EntityHandle for a specific (entityName, entityId) pair.
 *
 * The returned object has:
 *
 * - One own-field getter per key of `fields` (the entity's declared
 *   field map); each getter reads the current snapshot value.
 * - `entity` — the raw `Entity` envelope, populated from the sync
 *   snapshot or `undefined` when the entity isn't materialized.
 * - One forward accessor per registered relationship where this
 *   entity is the source; delegates to the runtime relationship
 *   primitive.
 * - One reverse accessor per registered relationship where this
 *   entity is the target; delegates to the runtime relationship
 *   primitive.
 *
 * The runtime returns a `Record<string | symbol, unknown>` whose
 * properties are `Object.defineProperty` getters; the static type is
 * `EntityHandle<TFields, TRelAccessors>` at the call site.
 */
export function buildEntityHandle<
  TFields extends Record<string, TSchema>,
  TRelAccessors extends EntityRelationshipAccessors<TFields, Record<string, TSchema>>,
>(
  client: SyncClient,
  entityName: string,
  entityId: string,
  shape: TObject<TFields>,
): EntityHandle<TFields, TRelAccessors> {
  const handle: Record<string | symbol, unknown> = {
    id: entityId,
  };

  // Fire-and-forget hydration so the snapshot is warm by the
  // time the user reads a field — the getter's read is sync, so
  // without this kick the first field read would be `undefined`.
  // Callers who already awaited `client.catchUp(...)` don't need
  // this; the background read is a UX nicety.
  void client.readLocalEntity(entityId).catch(() => {});

  Object.defineProperty(handle, "entity", {
    configurable: true,
    enumerable: true,
    get() {
      return client.readLocalEntitySync(entityId, entityName);
    },
  });

  // Per #158 acceptance criterion 6: getters only. Writes go
  // through `client.<entity>.update(id, patch)`.
  for (const field of Object.keys(shape.properties) as (keyof TFields & string)[]) {
    Object.defineProperty(handle, field, {
      configurable: true,
      enumerable: true,
      get() {
        return client.readLocalEntitySync(entityId, entityName, field);
      },
    });
  }

  const forwardRels = client.registry.getRelationshipsForSource(entityName);
  for (const rel of forwardRels) {
    Object.defineProperty(handle, rel.as, {
      configurable: true,
      enumerable: true,
      get() {
        return invokeForward(rel, client, entityName, entityId, shape);
      },
    });
  }

  const reverseRels = client.registry.getRelationshipsForTarget(entityName);
  for (const rel of reverseRels) {
    Object.defineProperty(handle, rel.as, {
      configurable: true,
      enumerable: true,
      get() {
        return invokeReverse(rel, client, entityName, entityId);
      },
    });
  }

  return handle as unknown as EntityHandle<TFields, TRelAccessors>;
}

/**
 * Build a forward accessor result. The static type at the call site
 * narrows per the relationship's cardinality; the runtime here just
 * dispatches to the existing primitive.
 *
 * `sourceCardinality: "one"` → `Promise<Entity | null>` (the runtime
 * can return `undefined` when the source is missing — the static
 * type allows both for nullable FK narrowing per #171). When the FK
 * field is declared `.nullable()`, the runtime uses
 * `forwardOneNullable` so the user can distinguish "null FK" from
 * "missing source" at the call site.
 *
 * `sourceCardinality: "many"` → `QueryBuilder<TTargetFields>` over
 * the target entity's TypeBox shape (projected on `await`).
 */
// (Old invokeForward removed; see the new signature below.)

/**
 * True when the schema's field at `as` is nullable. Drives the
 * runtime dispatch between `forwardOne` (collapses null/absent)
 * and `forwardOneNullable` (preserves the null distinction) — per
 * the spec, the nullable FK case surfaces `null` for cleared fields.
 *
 * Type.Union emits `{ anyOf: [...] }` or `{ type: [...] }`; we
 * accept either shape. Type.Optional isn't enumerated here because
 * its accessors return `undefined`, not `null`.
 */
function isNullableField(shape: TObject<Record<string, TSchema>>, fieldName: string): boolean {
  const fieldSchema = (shape.properties as Record<string, unknown>)[fieldName] as
    | { anyOf?: unknown[]; type?: unknown }
    | undefined;
  if (fieldSchema === undefined) return false;
  const unionMembers: readonly unknown[] = Array.isArray(fieldSchema.anyOf)
    ? fieldSchema.anyOf
    : Array.isArray(fieldSchema.type)
      ? (fieldSchema.type as unknown[])
      : [];
  return unionMembers.some((m) => {
    if (typeof m !== "object" || m === null) return false;
    return (m as { type?: unknown }).type === "null";
  });
}

/**
 * Build a forward accessor result. Cardinality determines the
 * shape: `one` → `Promise<Entity | null>` (nullable FK narrows
 * via `forwardOneNullable` to preserve the null vs. undefined
 * distinction); `many` → a typed QueryBuilder projected on
 * `await`.
 */
function invokeForward(
  rel: {
    source: { name: string };
    target: { name: string };
    as: string;
    sourceCardinality: "one" | "many";
  },
  client: SyncClient,
  sourceEntityName: string,
  sourceId: string,
  sourceShape: TObject<Record<string, TSchema>>,
):
  | ForwardOneAccessor<Record<string, TSchema>, string>
  | ForwardManyAccessor<Record<string, TSchema>> {
  const readLocalEntity = (id: string): Promise<Entity | null> => client.storage.entities.get(id);
  const queryEntitiesByType = (type: string): Promise<readonly Entity[]> =>
    client.storage.entities.query(type);
  if (rel.sourceCardinality === "one") {
    if (isNullableField(sourceShape, rel.as)) {
      return forwardOneNullable(
        readLocalEntity,
        sourceId,
        sourceEntityName,
        rel.as,
      ) as ForwardOneAccessor<Record<string, TSchema>, string>;
    }
    return forwardOne(readLocalEntity, sourceId, sourceEntityName, rel.as) as ForwardOneAccessor<
      Record<string, TSchema>,
      string
    >;
  }
  const targetShape = client.registry.get(rel.target.name)?.shape;
  if (targetShape === undefined) {
    // oxlint-disable-next-line no-thenable -- guard clause; caller never awaits this branch.
    return { then: () => Promise.resolve([]) } as unknown as ForwardManyAccessor<
      Record<string, TSchema>
    >;
  }
  return forwardMany(
    readLocalEntity,
    queryEntitiesByType,
    sourceId,
    sourceEntityName,
    rel.target.name,
    targetShape,
    rel.as,
  );
}

/**
 * Build a reverse accessor result. Reverse accessors always return
 * a `QueryBuilder<TSourceFields>` (per #149: the source side is
 * always a collection).
 */
function invokeReverse(
  rel: { source: { name: string }; as: string; type: string },
  client: SyncClient,
  targetName: string,
  targetId: string,
): ReverseAccessor<Record<string, TSchema>> {
  const readLocalEntity = (id: string): Promise<Entity | null> => client.storage.entities.get(id);
  const queryEntitiesByType = (type: string): Promise<readonly Entity[]> =>
    client.storage.entities.query(type);
  const sourceShape = client.registry.get(rel.source.name)?.shape;
  if (sourceShape === undefined) {
    // oxlint-disable-next-line no-thenable -- guard clause; caller never awaits this branch.
    return { then: () => Promise.resolve([]) } as unknown as ReverseAccessor<
      Record<string, TSchema>
    >;
  }
  return reverse(
    readLocalEntity,
    queryEntitiesByType,
    targetId,
    rel.source.name,
    sourceShape,
    rel.as,
    rel.type,
  );
}

// Re-export the handle type so callers can import from `handle.ts`.
export type { EntityHandle };
