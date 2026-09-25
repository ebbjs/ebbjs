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
 *   fields, matching the storage-adapter's behavior.
 *
 * - **Forward relationship accessors** for every
 *   `defineRelationship` on this entity as source. Each one
 *   delegates to `client.relationship({...}).forward(id)` from
 *   `#149`; `sourceCardinality: "one"` resolves to
 *   `Promise<Entity | undefined>`, `sourceCardinality: "many"`
 *   resolves to a `QueryBuilder` over the cached target entities.
 *
 * - **Reverse relationship accessors** for every relationship that
 *   targets this entity. All reverse accessors resolve to a
 *   `QueryBuilder` (per #127 / #149: the source side is always a
 *   collection).
 *
 * The handle is a thin wrapper over the relationship primitive
 * (from #149) plus the cached entity read path. It does not own
 * state of its own beyond the entity id and a reference to the
 * `SyncClient`.
 *
 * ## Design pins (per #158)
 *
 * - **Handle named with a `Handle` suffix, not the raw entity
 *   name.** Avoids colliding with the materialized entity shape
 *   used elsewhere (e.g., the eventual TypeScript type the user
 *   binds to `Todo`).
 * - **Field accessors are getters only.** Writes go through
 *   `client.<entity>.update(id, patch)`; a setter would have to
 *   call `client.write()` async, but property assignment is
 *   synchronous — bad ergonomics.
 */

import type { Entity } from "@ebbjs/core";

import type { FieldMarker } from "../schema/entity";
import type { SyncClient } from "./client";
import type { QueryBuilder, PrimitiveQueryBuilder } from "./query-builder";
import type { EntityHandle } from "./namespace";

/**
 * Build an EntityHandle for a specific (entityName, entityId) pair.
 *
 * The returned object has:
 *
 * - One own-field getter per key of `fields` (the entity's declared
 *   field map); each getter reads the current snapshot value.
 * - One forward accessor per registered relationship where this
 *   entity is the source; delegates to
 *   `client.relationship({...}).forward(entityId)`.
 * - One reverse accessor per registered relationship where this
 *   entity is the target; delegates to
 *   `client.relationship({...}).reverse(entityId)`.
 *
 * The static type at the call site is generic on
 * `TFields`/`TEntityDef`; this runtime helper threads the raw
 * `EntityDef` (its `fields` map) so the loop can iterate.
 */
export function buildEntityHandle<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
  entityId: string,
  fields: TFields,
): EntityHandle<TFields> {
  const handle: Record<string | symbol, unknown> = {
    id: entityId,
  };

  // Kick off the (async) materialization into the sync snapshot.
  // The getter's read is synchronous; if the user reads a field
  // before the materialization completes, they get `undefined`.
  // For most usage the user calls `await client.catchUp(...)`
  // before `client.<entity>(id)`, so the snapshot is already
  // populated. The background read is a UX nicety, not a
  // correctness requirement.
  void client.readLocalEntity(entityId).catch(() => {});

  // Own-field getters: read from the synchronous snapshot. Per #158
  // acceptance criterion 6, getters only — no setters. Writes go
  // through `client.<entity>.update(id, patch)`.
  for (const field of Object.keys(fields) as (keyof TFields & string)[]) {
    Object.defineProperty(handle, field, {
      configurable: true,
      enumerable: true,
      get() {
        return client.readLocalEntitySync(entityId, entityName, field);
      },
    });
  }

  // Forward relationships: for each `defineRelationship` with
  // `entityName` as the source, expose `<as>` as either an
  // `Entity | undefined` (one) or a `QueryBuilder` (many).
  const forwardRels = client.registry.getRelationshipsForSource(entityName);
  for (const rel of forwardRels) {
    Object.defineProperty(handle, rel.as, {
      configurable: true,
      enumerable: true,
      get() {
        return invokeForward(client, entityName, entityId, rel.as);
      },
    });
  }

  // Reverse relationships: for each relationship whose target is
  // `entityName`, expose the source set as a QueryBuilder.
  const reverseRels = client.registry.getRelationshipsForTarget(entityName);
  for (const rel of reverseRels) {
    Object.defineProperty(handle, rel.as, {
      configurable: true,
      enumerable: true,
      get() {
        return invokeReverse(client, entityName, entityId, rel.source.name, rel.as);
      },
    });
  }

  return handle as unknown as EntityHandle<TFields>;
}

/**
 * Synchronously read a field off the cached entity. The read goes
 * through `client.readLocalEntitySync`, which falls back to `null`
 * when the entity isn't in the sync snapshot. Returns `undefined`
 * for absent fields, matching the storage-adapter semantics.
 */
function invokeForward(
  client: SyncClient,
  sourceName: string,
  sourceId: string,
  as: string,
): Promise<Entity | undefined> | PrimitiveQueryBuilder {
  const source = client.registry.get(sourceName);
  const rel = client.registry.getRelationship(sourceName, as);
  if (rel === undefined) {
    // No relationship registered for this accessor — fall back to
    // `undefined` so the property reads as `undefined`. The static
    // type already accepts `EntityHandle<TFields>[string] = ... |
    // undefined`, so this isn't a hot-path error case.
    return Promise.resolve(undefined) as Promise<Entity | undefined>;
  }
  // `target` is a stand-in stub — the relationship primitive
  // accepts `{ name }`-shaped stubs without registering them in
  // the registry (the path resolves through the relationship's
  // `target.name` lookup, which the registry has).
  const stubTarget = { name: rel.target.name };
  const handle = client.relationship({
    source: source ?? { name: sourceName, fields: {} },
    target: stubTarget,
    as,
  });
  if (rel.sourceCardinality === "one") {
    return handle.forward(sourceId) as Promise<Entity | undefined>;
  }
  return handle.forward(sourceId) as unknown as PrimitiveQueryBuilder;
}

function invokeReverse(
  client: SyncClient,
  targetName: string,
  targetId: string,
  sourceName: string,
  as: string,
): QueryBuilder<Record<never, never>> {
  const source = client.registry.get(sourceName) ?? { name: sourceName, fields: {} };
  const stubTarget = { name: targetName };
  const handle = client.relationship({ source, target: stubTarget, as });
  return handle.reverse(targetId) as unknown as QueryBuilder<Record<never, never>>;
}

/**
 * Handle shape: an object whose keys mirror the union of
 * `TFields` (own fields) and the relationship accessor names. The
 * static type is generic on `TFields`; the runtime shape is
 * declared dynamically per `buildEntityHandle`.
 *
 * The `EntityHandle<TFields>` interface lives in `namespace.ts`
 * (it's the type returned by `EntityCollection<TFields>`'s call
 * signature). We re-export it below so the runtime helper here
 * can reference the canonical type.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- re-export for callers that already import from sync/handle
export type { EntityHandle } from "./namespace";
