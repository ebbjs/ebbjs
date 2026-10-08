import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { EntityRow, EntitySnapshot, EntityWithAccessors, TSchema } from "@ebbjs/client";

/**
 * The value {@link useEntity} exposes: the row `client.<entity>.get(id)`
 * materializes — projected fields plus relationship accessors — without
 * the internal `subscribe` handle, which the hook owns.
 *
 * The hook is `null` when `load` resolves `null`, and it flips to `null`
 * when a soft delete is observed while mounted. It cannot see a delete
 * that already happened before mount: the client's `get` deliberately
 * returns tombstones for per-row inspection, and the row carries no
 * `deleted_hlc`.
 */
export type UseEntityResult<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = Record<never, never>,
> = EntityWithAccessors<TFields, TAccessors>;

/** Reactive cell {@link useEntity} reads through `useSyncExternalStore`. */
interface EntityStore<TFields extends Record<string, TSchema>, TAccessors extends object> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UseEntityResult<TFields, TAccessors> | null;
}

/**
 * The projected fields of a subscribe snapshot. `EntitySnapshot` mixes
 * the wire escape hatches (`id`, `entity`) in with the shape's fields;
 * drop them so field equality can drive the no-op check.
 */
const projectedFields = (
  snapshot: EntitySnapshot<Record<string, TSchema>>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "id" || key === "entity") continue;
    out[key] = value;
  }
  return out;
};

/** Field-wise equality. Every field the `e.*` helpers produce is a primitive. */
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

/**
 * One reactive cell per `load` thunk. Holds the latest row, subscribes
 * to its `EntityRow.subscribe`, and — on a live change — re-runs `load`
 * rather than merging the snapshot's fields over the old row.
 *
 * Re-loading is deliberate: relationship accessors and same-named
 * fields collide on a row (`get` spreads accessors last), and the raw
 * snapshot carries the field, not the accessor. Re-running `get` is the
 * only way to preserve the accessor-wins precedence.
 *
 * `deleted_hlc` on the snapshot is the delete signal — `get` happily
 * returns a tombstone, so the row itself can't tell us it's gone.
 */
function createEntityStore<TFields extends Record<string, TSchema>, TAccessors extends object>(
  load: () => Promise<EntityRow<TFields, TAccessors> | null>,
): EntityStore<TFields, TAccessors> {
  let state: UseEntityResult<TFields, TAccessors> | null = null;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;
  // Fields of the most recently applied snapshot, for no-op suppression.
  let lastFields: Record<string, unknown> | null = null;
  // Invalidates an in-flight load when the subscription is torn down or
  // a newer change supersedes it.
  let loadToken = 0;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const withoutSubscribe = (
    row: EntityRow<TFields, TAccessors>,
  ): UseEntityResult<TFields, TAccessors> => {
    const { subscribe: _subscribe, ...data } = row;
    // `EntityRow` is `EntityWithAccessors & { subscribe }`; TS can't prove
    // the rest-pattern drops exactly the intersection member.
    return data as UseEntityResult<TFields, TAccessors>;
  };

  const reload = async (token: number): Promise<void> => {
    let row: EntityRow<TFields, TAccessors> | null;
    try {
      row = await load();
    } catch {
      // No error surface is specified for this hook; failing the read
      // must not become an unhandled rejection. Keep the last good value.
      return;
    }
    if (token !== loadToken) return;
    if (row === null) {
      lastFields = null;
      state = null;
      notify();
      return;
    }
    state = withoutSubscribe(row);
    notify();
  };

  const handleSnapshot = (snapshot: EntitySnapshot<TFields>): void => {
    if (snapshot.entity.deleted_hlc !== null) {
      if (state === null && lastFields === null) return;
      // Invalidate any reload started by a live change that preceded this
      // delete, so it can't land a row after we've gone to `null`.
      loadToken += 1;
      lastFields = null;
      state = null;
      notify();
      return;
    }
    const fields = projectedFields(snapshot);
    if (lastFields !== null && sameFields(fields, lastFields)) return;
    lastFields = fields;
    loadToken += 1;
    void reload(loadToken);
  };

  const bootstrap = async (): Promise<void> => {
    const token = ++loadToken;
    let row: EntityRow<TFields, TAccessors> | null;
    try {
      row = await load();
    } catch {
      // Same as `reload`: no error surface, so swallow rather than throw
      // an unhandled rejection. The cell stays `null`.
      return;
    }
    if (token !== loadToken) return;
    if (row === null) {
      state = null;
      notify();
      return;
    }
    state = withoutSubscribe(row);
    detach = row.subscribe(handleSnapshot);
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void bootstrap();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = null;
          // A load that resolves after teardown must not resurrect state;
          // drop the comparison baseline so a later remount re-reads fresh.
          loadToken += 1;
          lastFields = null;
        }
      };
    },
    getSnapshot: () => state,
  };
}

/**
 * Subscribe a component to a single entity row.
 *
 * `load` is the caller's read (`() => client.<entity>.get(id)`). It runs
 * on mount, again on each `deps` change — keep `deps` a stable-length
 * list — and again on every live change so the row is re-derived with
 * its relationship accessors intact.
 *
 * Returns the row's projected fields and relationship accessors, or
 * `null` when `load` finds no row, and `null` again after a soft delete
 * observed while mounted. A row deleted before mount reads as its
 * tombstone (`get` returns tombstones); a row created after an absent
 * read is not observed, because `EntityRow.subscribe` only exists once a
 * row does.
 */
export function useEntity<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = Record<never, never>,
>(
  load: () => Promise<EntityRow<TFields, TAccessors> | null>,
  deps: readonly unknown[] = [],
): UseEntityResult<TFields, TAccessors> | null {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the store is created once per `deps` change; `load` is intentionally not itself a dependency.
  const store = useMemo(() => createEntityStore(load), deps);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
