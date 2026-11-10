/**
 * Content backfill for membership rows naming entities the client does
 * not hold (#475).
 *
 * Delivery is deltas only: an entity moved into a group has no field
 * writes in that group's history, so a member that receives the scoped
 * `entityGroup` row but not the entity ends up with a membership row it
 * cannot materialize. The client's visible set is the entity ids its
 * `entityGroup` rows name, so any referenced entity it lacks is fetched
 * from the server.
 *
 * The store is log-derived — entities materialize by replaying
 * `storage.actions` — so the fetched base is written as a synthetic
 * snapshot stamped with the entity's own `last_gsn` and `updated_hlc`, one
 * `replace` per leaf component and one `merge` per keyed component. That
 * places the base at its true causal position in the log: an
 * already-delivered write with a lower gsn is subsumed by the base, a later
 * one merges on top by HLC, and an in-flight write the fetch predates wins.
 * Because the fetched field envelopes are the server's canonical ones,
 * replaying later Updates merges over the base by HLC without regressing it.
 * A 404 is left absent rather than resurrected: the membership row can
 * outlive the entity's delete.
 */

import {
  componentName,
  generateId,
  isFieldMap,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { LoggedAction, StorageAdapter } from "@ebbjs/storage/types";

import { liveMemberships } from "./entity-group";
import { createObservable, type ReadonlyObservable } from "./observable";
import type { EntityResponse } from "./types";

/**
 * Actor id stamped on a synthetic snapshot Action. It is not a real
 * actor; the constant keeps the synthesized base from looking like a
 * peer's write and stays stable across reloads.
 */
export const BACKFILL_ACTOR_ID = "a_backfill";

/**
 * Build the synthetic snapshot that carries a fetched entity into the log:
 * one Update per component. The base is stamped with the entity's own
 * `last_gsn` and `updated_hlc` so gsn ordering places it at its true causal
 * position: an earlier write is subsumed, a later one merges on top by HLC.
 * The field envelopes come through verbatim so later merges are by HLC, not
 * by arrival. A `replace` is a leaf-level LWW compare, and a keyed component
 * can only merge, so the snapshot never discards a sibling.
 */
export const snapshotAction = (entity: Entity): Action =>
  snapshotActionWithIds(entity, { actionId: generateId("a"), updateId: generateId("u") });

/**
 * The same synthetic base with caller-chosen ids. A group listing seed
 * derives them from `(group, entity)` so redoing a page merges into the
 * entry it already wrote instead of duplicating it (#476).
 */
export const snapshotActionWithIds = (
  entity: Entity,
  ids: {
    readonly actionId: string;
    readonly updateId: string;
    /** Defaults to {@link BACKFILL_ACTOR_ID}; the listing seed names itself. */
    readonly actorId?: string;
  },
): Action =>
  ({
    id: ids.actionId,
    actor_id: ids.actorId ?? BACKFILL_ACTOR_ID,
    hlc: entity.updated_hlc,
    gsn: entity.last_gsn,
    updates: Object.entries(entity.data.fields).map(
      ([field, value]): Update => ({
        id: `${ids.updateId}_${field}`,
        subject_id: entity.id,
        component: componentName(entity.type, field),
        method: isFieldMap(value) ? "merge" : "replace",
        data: value,
      }),
    ),
  });

const hlcToString = (hlc: number | string | null): string | null =>
  hlc === null ? null : typeof hlc === "number" ? String(hlc) : hlc;

/**
 * Normalize a wire field envelope. The entity endpoint is JSON, so HLCs
 * can arrive as numbers; the store and the merge rule speak packed
 * decimal strings, so numbers stringify. An unrecognized envelope is
 * kept as a leaf so nothing is silently dropped.
 */
const normalizeField = (field: unknown): FieldValue => {
  if (typeof field === "object" && field !== null) {
    const record = field as Record<string, unknown>;
    if (typeof record.map === "object" && record.map !== null) {
      return {
        map: Object.fromEntries(
          Object.entries(record.map as Record<string, unknown>).map(([key, value]) => [
            key,
            normalizeField(value),
          ]),
        ),
      };
    }
    if (typeof record.update_id === "string") {
      const leaf: { value: unknown; update_id: string; hlc?: string } = {
        value: record.value,
        update_id: record.update_id,
      };
      const hlc = hlcToString(
        typeof record.hlc === "number" || typeof record.hlc === "string" ? record.hlc : null,
      );
      if (hlc !== null) leaf.hlc = hlc;
      return leaf;
    }
  }
  return { value: field, update_id: "" };
};

/** Convert the wire `EntityResponse` to the runtime `Entity` shape. */
export const toRuntimeEntity = (response: EntityResponse): Entity => ({
  id: response.id,
  type: response.type,
  data: {
    fields: Object.fromEntries(
      Object.entries(response.data.fields).map(([key, value]) => [key, normalizeField(value)]),
    ),
  },
  // The entity endpoint returns a row the server holds, so its create has
  // been seen. The wire carries no existence bit; this adapter is the one
  // place the fact is derived, and only because a fetched row is a base.
  exists: true,
  created_hlc: hlcToString(response.created_hlc),
  updated_hlc: hlcToString(response.updated_hlc) ?? "",
  deleted_hlc: hlcToString(response.deleted_hlc),
  last_gsn: response.last_gsn,
});

/**
 * Entity ids referenced by a live `entityGroup` row whose base the local
 * cache does not hold, ascending. A row materialized from a later component
 * write has `exists: false` because its create has not been seen, so it is a
 * candidate too. A tombstone counts as held: the client knows the entity and
 * the delete is its current state, so it is not a candidate.
 */
export async function collectBackfillCandidates(
  storage: StorageAdapter,
): Promise<readonly string[]> {
  const rows = await storage.entities.query("entityGroup");
  const referenced = new Set(liveMemberships(rows).map((membership) => membership.entityId));

  const missing: string[] = [];
  for (const entityId of [...referenced].sort()) {
    const row = await storage.entities.get(entityId);
    if (row === null || !row.exists) missing.push(entityId);
  }
  return missing;
}

export interface BackfillOptions {
  readonly storage: StorageAdapter;
  /** Read one entity from the server; `null` when it is absent or unreadable. */
  readonly fetchEntity: (entityId: string) => Promise<EntityResponse | null>;
  /**
   * Called with the logged entry after a fetched base is appended, so the
   * caller's live replica folds the synthetic `put` in place without a log
   * replay. Optional — the store's own materialization still happens.
   */
  readonly onAppended?: (entry: LoggedAction) => void;
  /** Called when a read throws. Defaults to `console.warn`. */
  readonly onError?: (error: unknown, entityId?: string) => void;
}

export interface Backfill {
  /**
   * Entity ids currently being fetched, deduped and ascending. Read
   * synchronously so a UI can render a pending row instead of an empty
   * one while the content is in flight.
   */
  readonly pending: ReadonlyObservable<readonly string[]>;
  /**
   * Run a reconciliation pass. Concurrent callers coalesce: a call made
   * while a pass is running queues one more pass and every caller
   * resolves when the queue drains.
   */
  run(): Promise<void>;
}

export function createBackfill(opts: BackfillOptions): Backfill {
  const { storage, fetchEntity, onAppended } = opts;
  const onError =
    opts.onError ??
    ((error: unknown, entityId?: string) => {
      // eslint-disable-next-line no-console
      console.warn("[backfill] entity read failed:", entityId, error);
    });

  const pending = createObservable<readonly string[]>([]);
  const waiters: (() => void)[] = [];
  // Ids whose fetched base carried no component: the log cannot record an
  // empty row, so the placeholder stays `exists: false` and would be a
  // candidate on every pass. A later component write makes the row worth
  // fetching again, so a pass that sees one clears the guard.
  const fetchedEmpty = new Set<string>();
  let running = false;
  let queued = false;

  const publish = (ids: Iterable<string>): void => pending.set([...ids].sort());

  const readOne = async (entityId: string): Promise<Entity | null> => {
    try {
      const response = await fetchEntity(entityId);
      if (response === null) return null;
      const entity = toRuntimeEntity(response);
      if (entity.deleted_hlc !== null) return null;
      return entity;
    } catch (error) {
      onError(error, entityId);
      return null;
    }
  };

  const reconcile = async (): Promise<void> => {
    const candidates = await collectBackfillCandidates(storage);
    if (candidates.length === 0) return;

    const inFlight = new Set([...pending.get(), ...candidates]);

    for (const entityId of candidates) {
      if (fetchedEmpty.has(entityId)) {
        const row = await storage.entities.get(entityId);
        if (row === null || Object.keys(row.data.fields).length === 0) continue;
        fetchedEmpty.delete(entityId);
      }
      publish(inFlight);
      const entity = await readOne(entityId);
      // An optimistic local write can land while the read is in flight.
      // It owns the cache until its echo arrives, so it wins over the
      // fetched base rather than being overwritten by the replay.
      const current = await storage.entities.get(entityId);
      const needsBase = current === null || !current.exists;
      if (entity !== null && needsBase) {
        const snapshot = snapshotAction(entity);
        // A zero-component base carries no Update, so the log cannot record
        // it. Remember the id so this pass does not re-fetch it forever.
        if (snapshot.updates.length === 0) {
          fetchedEmpty.add(entityId);
          inFlight.delete(entityId);
          continue;
        }
        const entry = await storage.actions.append(snapshot);
        onAppended?.(entry);
        // Force materialization so subscribers observe the fetched row.
        await storage.entities.get(entityId);
      }
      inFlight.delete(entityId);
    }
    publish(inFlight);
  };

  const loop = async (): Promise<void> => {
    try {
      do {
        queued = false;
        await reconcile();
      } while (queued);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      publish([]);
      for (const resolve of waiters.splice(0)) resolve();
    }
  };

  return {
    pending,
    run(): Promise<void> {
      if (!running) {
        running = true;
        void loop();
      } else {
        queued = true;
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
