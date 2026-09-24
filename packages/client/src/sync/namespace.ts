/**
 * `client.<entity>` namespace mounting.
 *
 * Derives the per-entity accessor surface from a `Schema` value at
 * `createClient` time. For each entry in `schema.entities`, this
 * module installs:
 *
 * - A **collection** under `client.<entity>` with:
 *     - `create(input)` → `Promise<Entity>` (resolves from local
 *       cache after submission; full round-trip via `client.write`)
 *     - `update(id, patch)` → `Promise<void>`
 *     - `delete(id)` → `Promise<void>`
 *     - `find()` → `QueryBuilder<typeof schema.entities.<entity>.fields>`
 * - An **instance accessor** at `client.<entity>(id)` returning a
 *   typed `TodoHandle`-style handle with field getters and
 *   forward/reverse relationship accessors.
 *
 * ## Mounting strategy
 *
 * Static `Object.defineProperty` mounting at `createClient` time,
 * not Proxy. The schema is fixed at client construction so the
 * runtime-extensible wins of a Proxy don't apply; eager mounting
 * gives consumers autocomplete and a debuggable surface.
 *
 * Type-pinning comes from the schema: `entity.fields` is a
 * `Record<string, FieldMarker>` whose `keyof` drives the
 * compile-time narrowing on `eq` / `orderBy` / `create` / `update`.
 * The runtime carries no types; the type-only mounts happen via
 * the public `createClient` return type, which is parameterized on
 * the `Schema`'s generic args.
 *
 * ## Relationship writes
 *
 * Collection `create` / `update` route through
 * `client.buildRelationshipWrite` whenever the `input` payload
 * carries a relationship-pointer field. The routing is local to
 * this module — see `collectRelationshipUpdates` below for the
 * logic. Field-name vs. relationship-pointer detection uses the
 * schema's `getRelationshipsForSource(entityName)` lookup.
 *
 * ## Sync reads via the handle
 *
 * Handle getters read `SyncClient.readLocalEntitySync`, which keeps
 * a synchronous `Map<id, Entity>` snapshot up to date with every
 * `_applyAction` receipt. The snapshot is hydrated lazily by the
 * first `readLocalEntity` call against a given id, so a user who
 * only reads handles after a `client.catchUp(...)` will see the
 * freshly materialized entities without an extra round trip.
 *
 * ## Out of scope (deferred)
 *
 * - `#161` reactive `subscribe` on the handle / collection.
 * - `#163` additional QueryBuilder terminals (`.first()` /
 *   `.count()` / `[Symbol.asyncIterator]`).
 */

import { createAction, createClock, generateId } from "@ebbjs/core";

import type { EntityDef, FieldMarker, FieldValueFor } from "../schema/entity";
import type { RelationshipDef } from "../schema/relationship";
import type { Schema } from "../schema/schema";

import { buildQueryBuilder, type QueryBuilder } from "./query-builder";
import { buildEntityHandle } from "./handle";
import type { SyncClient } from "./client";

/**
 * Wire-level Update shape used by the namespace write paths. Mirrors
 * the `Update` from `@ebbjs/core`; re-stated here so the namespace
 * doesn't need to reach into the core module's surface.
 */
type Update = import("@ebbjs/core").Update;

/**
 * The collection surface mounted under `client.<entity>`. Each
 * method is the public write / read entry point. The instance
 * accessor is the call signature (the same value carries the
 * methods — TypeScript models this as a function-with-properties).
 *
 * `create(input)` and `update(id, patch)` validate the input's keys
 * at compile time against the schema; unknown field names are a
 * static error. Relationship-pointer fields are detected by the
 * schema's relationship map and routed through
 * `client.buildRelationshipWrite`.
 */
export interface EntityCollection<TFields extends Record<string, FieldMarker>> {
  /** Instance accessor — returns a typed handle for `id`. */
  (id: string): EntityHandle<TFields>;
  /** Create a new entity; submits one wire Action. */
  create(input: CreateInput<TFields>): Promise<import("@ebbjs/core").Entity>;
  /** Patch an entity's own fields; submits one wire Action. */
  update(id: string, patch: UpdateInput<TFields>): Promise<void>;
  /** Soft-delete an entity; submits one wire Action. */
  delete(id: string): Promise<void>;
  /** Start a typed query chain. Terminal: `.toArray()`. */
  find(): QueryBuilder<TFields>;
}

/**
 * Shape of the entity instance handle. Carries declared fields as
 * getters + relationship accessors. Field values are typed via
 * `FieldValueFor<F>`.
 */
export interface EntityHandle<_TFields extends Record<string, FieldMarker>> {
  readonly id: string;
  readonly [field: string]: unknown;
}

/**
 * Input shape for `create` / `update`. Every declared field is
 * optional (writes are field-level). Relationship-pointer fields
 * are reachable too — the schema's relationship map drives the
 * dispatch between own-field writes and relationship writes.
 */
export type CreateInput<TFields extends Record<string, FieldMarker>> = {
  [K in keyof TFields]?: FieldValueFor<TFields[K]>;
};
export type UpdateInput<TFields extends Record<string, FieldMarker>> = CreateInput<TFields>;

/**
 * Namespaced client shape. For each entry in `schema.entities`,
 * mounts an `EntityCollection` under the matching key. `SyncClient`
 * exposes this surface via the `Object.defineProperty` calls in
 * `mountNamespace`; the static type alias here is the canonical
 * shape TypeScript sees at the call site.
 */
export type NamespacedClient<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
> = {
  [K in keyof TEntities]: TEntities[K] extends EntityDef<infer TFields>
    ? EntityCollection<TFields>
    : never;
};

/**
 * Mount the per-entity namespace onto the given `SyncClient`. Walks
 * `client.schema.entities` once at call time and installs:
 * - `client.<entity>` (function with `create` / `update` /
 *   `delete` / `find` methods attached),
 * - `client.<entity>(id)` returning a typed handle,
 * - handle's own-field getters (per schema) and relationship
 *   accessors (per schema relationships).
 *
 * This call is a side effect on `client`; static type access at
 * the `client.<entity>` site works through the conditional return
 * type of `createClient` rather than via a separate value. See
 * `types.ts` for the conditional `NamespacedClient<S>` extension
 * on `createClient`.
 *
 * Caller is responsible for ordering: `mountNamespace` must run
 * after `client.registry` is populated and after the schema is
 * known. `createClient` handles that ordering in the constructor.
 */
export function mountNamespace<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
>(
  client: SyncClient,
  schema: Schema<
    TEntities,
    | Record<
        string,
        RelationshipDef<
          EntityDef<Record<string, FieldMarker>>,
          EntityDef<Record<string, FieldMarker>>
        >
      >
    | undefined
  >,
): void {
  const entities = schema.entities;
  for (const name of Object.keys(entities) as (keyof TEntities & string)[]) {
    const def = entities[name];
    if (def === undefined) continue;
    mountEntityCollection(client, name, def);
  }
}

/**
 * Install one EntityCollection onto `client.<entityName>`. The
 * runtime representation is a function (the instance accessor)
 * with `create` / `update` / `delete` / `find` attached as
 * properties. `Object.defineProperty` is used to mirror the
 * eager-static-mount design pin.
 */
function mountEntityCollection<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
  entityDef: EntityDef<TFields>,
): void {
  const collection = buildNamespacedCollection<TFields>(client, entityName, entityDef);
  // Mirror the static-mounter's design pin. We deliberately
  // install with a normal assignment so inspection in the
  // debugger shows `client.<entity>` as a function-with-properties,
  // not a getter wrapper.
  Object.defineProperty(client, entityName, {
    configurable: true,
    enumerable: true,
    writable: false,
    value: collection,
  });
}

/**
 * Build the EntityCollection runtime shape for one entity type.
 * Static type signature: `EntityCollection<TFields>`. The runtime
 * value is a function (instance accessor) with the four methods
 * attached.
 *
 * Relationship-pointer fields are detected by
 * `client.registry.getRelationshipsForSource(entityName)`. The
 * schema's `entity.fields` map drives own-field writes; unknown
 * fields in the input throw at runtime (the static type already
 * rejects them at compile time, but the runtime check protects
 * against untyped callers).
 */
function buildNamespacedCollection<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
  entityDef: EntityDef<TFields>,
): EntityCollection<TFields> {
  const instanceAccessor = (id: string): EntityHandle<TFields> => {
    return buildEntityHandle<TFields>(client, entityName, id, entityDef.fields);
  };

  const collection = Object.assign(instanceAccessor, {
    create: (input: CreateInput<TFields>) => namespaceCreate(client, entityName, entityDef, input),
    update: (id: string, patch: UpdateInput<TFields>) =>
      namespaceUpdate(client, entityName, entityDef, id, patch),
    delete: (id: string) => namespaceDelete(client, entityName, id),
    find: (): QueryBuilder<TFields> => namespaceFind(client, entityName),
  });

  return collection as EntityCollection<TFields>;
}

/**
 * Run a `create` write through the namespace. Returns the
 * materialized entity after submission (resolved from
 * `client.readLocalEntity` — the call also hydrates the sync
 * snapshot the handle uses).
 *
 * Generates the entity id locally (one call, two writes per
 * `Action`); the wire still accepts any id the server prefers to
 * assign (today: the client's id wins).
 */
async function namespaceCreate<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
  entityDef: EntityDef<TFields>,
  input: CreateInput<TFields>,
): Promise<import("@ebbjs/core").Entity> {
  const entityId = generateId(entityName);
  const updates = collectRelationshipUpdates(client, entityDef, entityId, input);
  await submitWrite(client, entityName, updates);
  // Hydrate the sync snapshot so a follow-up `client.<entity>(id)`
  // call sees the new entity without an extra network round trip.
  // When the storage adapter hasn't materialized the new id yet
  // (e.g., a stub fetch that doesn't write a corresponding Action
  // locally), `readLocalEntity` returns `null`. In that case we
  // return a placeholder `Entity` carrying just the id and type
  // so the call site doesn't crash; the next `catchUp` /
  // `readLocalEntity(id)` call will hydrate the real material.
  const material = await client.readLocalEntity(entityId);
  if (material !== null) return material;
  return {
    id: entityId,
    type: entityName,
    data: { fields: {} },
    created_hlc: "0",
    updated_hlc: "0",
    deleted_hlc: null,
    last_gsn: 0,
  } as unknown as import("@ebbjs/core").Entity;
}

/**
 * Run an `update` write through the namespace. Submits one wire
 * Action containing the modified own fields; relationship-pointer
 * changes go through `buildRelationshipWrite`.
 */
async function namespaceUpdate<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
  entityDef: EntityDef<TFields>,
  id: string,
  patch: UpdateInput<TFields>,
): Promise<void> {
  const updates = collectRelationshipUpdates(client, entityDef, id, patch);
  if (updates.length === 0) return;
  await submitWrite(client, entityName, updates);
  await client.readLocalEntity(id);
}

/**
 * Run a `delete` write through the namespace. Submits one wire
 * Action with a single `method: "delete"` Update.
 */
async function namespaceDelete(client: SyncClient, entityName: string, id: string): Promise<void> {
  const update: Update = {
    id: generateId("u"),
    subject_id: id,
    subject_type: entityName,
    method: "delete",
    data: null,
  };
  await submitWrite(client, entityName, [update]);
}

/**
 * Start a typed `find()` chain for the entity. Reads through
 * `client.storage.entities.query(entityName)` so callers can run
 * offline (against the materialized cache).
 *
 * The wrapper holds the *current* plan in a closure-scoped
 * variable so subsequent chain method calls always resume from
 * the latest builder. The terminals (`toArray` / `find`) load
 * candidates through the storage adapter on demand.
 *
 * Implementation note: `wrap(plan)` rebuilds a QueryBuilder that
 * carries `plan`'s filters / order / limit. The chain mutators
 * resume from the most-recent `current` so a sequence like
 * `eq().eq().orderBy()` accumulates all five constraints.
 */
function namespaceFind<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityName: string,
): QueryBuilder<TFields> {
  const candidatesLoader = (): Promise<readonly unknown[]> => {
    return (async () => {
      const all = await client.storage.entities.query(entityName);
      return all as readonly unknown[];
    })();
  };

  // Hold the most-recent plan so chained method calls resume
  // from it. The outer `let` is intentionally mutable; each
  // `wrap(...)` updates it for the next chained call.
  let current: QueryBuilder<TFields> | null = null;

  const wrap = (plan: QueryBuilder<TFields>): QueryBuilder<TFields> => {
    current = plan;
    const chained: QueryBuilder<TFields> = {
      ...plan,
      eq: ((field: never, value: never) => {
        const base = current ?? plan;
        return wrap(base.eq(field, value));
      }) as never,
      orderBy: ((field: never, direction: "asc" | "desc") => {
        const base = current ?? plan;
        return wrap(base.orderBy(field, direction));
      }) as never,
      limit: ((n: number) => {
        const base = current ?? plan;
        return wrap(base.limit(n));
      }) as never,
      async toArray(): Promise<readonly unknown[]> {
        const rows = await candidatesLoader();
        return applyPlan(rows, plan);
      },
      async find(): Promise<readonly unknown[]> {
        const rows = await candidatesLoader();
        return applyPlan(rows, plan);
      },
    };
    return chained;
  };
  return wrap(buildQueryBuilder<TFields>([]));
}

/**
 * Evaluate a `QueryPlan` over the given rows. Tiny helper so
 * `namespaceFind`'s terminal can reuse the chain shape without
 * re-importing the public `apply` surface (keeping this file
 * self-contained at the terminal level).
 */
function applyPlan(
  rows: readonly unknown[],
  plan: QueryBuilder<Record<string, FieldMarker>>,
): readonly unknown[] {
  let out: unknown[] = [...rows];
  for (const f of plan.filters) {
    out = out.filter((row) => {
      const rowFields = (row as { data?: { fields?: Record<string, { value: unknown }> } }).data
        ?.fields;
      return rowFields?.[f.field]?.value === f.value;
    });
  }
  if (plan.order !== null) {
    const { field, direction } = plan.order;
    out.sort((a, b) => {
      const av = (a as { data?: { fields?: Record<string, { value: unknown }> } }).data?.fields?.[
        field
      ]?.value;
      const bv = (b as { data?: { fields?: Record<string, { value: unknown }> } }).data?.fields?.[
        field
      ]?.value;
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return direction === "asc" ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return direction === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
  }
  if (plan.limitN !== null && plan.limitN >= 0) {
    out = out.slice(0, plan.limitN);
  }
  return out;
}

/**
 * Translate a `create` / `update` input into wire Updates. Splits
 * relationship-pointer fields off so they go through
 * `buildRelationshipWrite` and the rest ride the single entity
 * update. Unknown fields (not in `entityDef.fields` and not a
 * registered relationship) throw at runtime as a defense-in-depth
 * measure; the static type already catches them.
 */
function collectRelationshipUpdates<TFields extends Record<string, FieldMarker>>(
  client: SyncClient,
  entityDef: EntityDef<TFields>,
  entityId: string,
  input: CreateInput<TFields>,
): readonly Update[] {
  const entityName = entityDef.name;
  const relationships = client.registry.getRelationshipsForSource(entityName);
  const entityUpdate: Update = {
    id: generateId("u"),
    subject_id: entityId,
    subject_type: entityName,
    method: "put",
    data: { fields: {} },
  };

  const updates: Update[] = [];
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    const rel = relationships.find((r) => r.as === field);
    const isOwnField = field in entityDef.fields;
    if (rel !== undefined) {
      const target = client.registry.get(rel.target.name) ?? {
        name: rel.target.name,
        fields: {},
      };
      const { entityUpdate: cleanEntityUpdate, relationshipUpdate } = client.buildRelationshipWrite(
        {
          source: entityDef as never,
          target: target as never,
          as: field,
          entityUpdate,
          sourceCardinality: rel.sourceCardinality,
          targetId: value as never,
          targetIds: undefined,
        },
      );
      // Patch the running entityUpdate with the stripped form
      // (`buildRelationshipWrite` returns a new Update when it
      // strips a "one"-cardinality FK off the entity).
      Object.assign(entityUpdate, cleanEntityUpdate);
      const relUpdates: readonly Update[] = Array.isArray(relationshipUpdate)
        ? relationshipUpdate
        : [relationshipUpdate];
      for (const r of relUpdates) updates.push(r);
    } else if (isOwnField) {
      const fieldValue = value as FieldValueFor<TFields[keyof TFields]>;
      const fv = {
        value: fieldValue as never,
        update_id: generateId("u"),
      };
      (entityUpdate.data!.fields as Record<string, typeof fv>)[field] = fv;
    } else {
      throw new Error(
        `namespace.${entityName}: unknown field "${field}" (not declared on the schema; if this is a relationship pointer, register it via defineRelationship)`,
      );
    }
  }

  const entityUpdateCarriesFields = Object.keys(entityUpdate.data?.fields ?? {}).length > 0;
  if (entityUpdateCarriesFields || updates.length === 0) {
    updates.unshift(entityUpdate);
  }
  return updates;
}

/**
 * Wrap a list of Updates in an Action and submit via
 * `client.write`. Validation runs through the existing
 * `EntityRegistry` path; rejections throw `EntityValidationError`,
 * matching the wire-shared error model.
 */
async function submitWrite(
  client: SyncClient,
  _entityName: string,
  updates: readonly Update[],
): Promise<void> {
  if (updates.length === 0) return;
  const clock = createClock();
  // UpdateInput matches our local Update shape; the cast is the
  // minimal friction for reusing `createAction`'s id-generation
  // path.
  const { action } = createAction({
    actorId: client.actorId,
    updates: updates as never,
    clock,
  });
  await client.write([action]);
}
