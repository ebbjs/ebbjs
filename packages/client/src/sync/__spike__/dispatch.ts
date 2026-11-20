/**
 * SPIKE S3 (#779): dependency-indexed dispatch.
 *
 * Today the query cache walks every entry on every replica change
 * (`for (const entry of entries.values()) reconcile(...)`), and the row
 * watcher builds a subject set from every change. This models the target:
 * inverted indices over the components, models, and row ids a subscription
 * declared, so a batch touches only the subscriptions whose dependencies
 * intersect it.
 *
 * Throwaway. Not imported by production code.
 */

import type { ReplicaChange } from "@ebbjs/storage/replica";

export interface Dependencies {
  /** Exact component names (`note/content`). */
  readonly components?: readonly string[];
  /** Models read whole (`note` stands for every `note/*` component). */
  readonly models?: readonly string[];
  /** Row ids a row subscription watches. */
  readonly rows?: readonly string[];
}

export interface DispatchStats {
  /** Change × subscription pairs examined (today's cost). */
  readonly scanWork: number;
  /** Distinct subscriptions touched by the batch. */
  readonly touched: number;
  /** Index lookups performed (one per change × dependency kind). */
  readonly lookups: number;
}

export interface DependencyIndex<T> {
  add(item: T, deps: Dependencies): void;
  remove(item: T): void;
  /** Indexed dispatch; a subscription appears once however many changes hit it. */
  dispatch(changes: readonly ReplicaChange[]): {
    readonly touched: ReadonlySet<T>;
    readonly stats: DispatchStats;
  };
  /** Today's algorithm, for equivalence checks and the work comparison. */
  scan(
    changes: readonly ReplicaChange[],
    matches: (item: T, change: ReplicaChange) => boolean,
  ): {
    readonly touched: ReadonlySet<T>;
    readonly work: number;
  };
  size(): number;
}

const addTo = <T>(map: Map<string, Set<T>>, key: string, item: T): void => {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, new Set([item]));
  else bucket.add(item);
};

const removeFrom = <T>(map: Map<string, Set<T>>, key: string, item: T): void => {
  const bucket = map.get(key);
  if (bucket === undefined) return;
  bucket.delete(item);
  if (bucket.size === 0) map.delete(key);
};

export const createDependencyIndex = <T>(): DependencyIndex<T> => {
  const items = new Map<T, Dependencies>();
  const byComponent = new Map<string, Set<T>>();
  const byModel = new Map<string, Set<T>>();
  const byRow = new Map<string, Set<T>>();
  // A change that names no component (a tombstone or eviction of a row that
  // carried none) is observable only to a whole-model reader, exactly as
  // today's `matchesReads` says.
  const modelReaders = new Set<T>();

  return {
    add(item, deps) {
      if (items.has(item)) this.remove(item);
      items.set(item, deps);
      for (const component of deps.components ?? []) addTo(byComponent, component, item);
      for (const model of deps.models ?? []) addTo(byModel, model, item);
      for (const row of deps.rows ?? []) addTo(byRow, row, item);
      if ((deps.models?.length ?? 0) > 0) modelReaders.add(item);
    },
    remove(item) {
      const deps = items.get(item);
      if (deps === undefined) return;
      items.delete(item);
      for (const component of deps.components ?? []) removeFrom(byComponent, component, item);
      for (const model of deps.models ?? []) removeFrom(byModel, model, item);
      for (const row of deps.rows ?? []) removeFrom(byRow, row, item);
      modelReaders.delete(item);
    },
    dispatch(changes) {
      const touched = new Set<T>();
      let lookups = 0;
      for (const change of changes) {
        lookups += 1;
        const rows = byRow.get(change.id);
        if (rows !== undefined) for (const item of rows) touched.add(item);
        if (change.components.length === 0) {
          lookups += 1;
          for (const item of modelReaders) touched.add(item);
          continue;
        }
        lookups += 1;
        for (const component of change.components) {
          const exact = byComponent.get(component);
          if (exact !== undefined) for (const item of exact) touched.add(item);
          // `note/content` also hits a reader of `note/*`.
          const slash = component.indexOf("/");
          const model = slash === -1 ? component : component.slice(0, slash);
          lookups += 1;
          const whole = byModel.get(model);
          if (whole !== undefined) for (const item of whole) touched.add(item);
        }
      }
      const stats: DispatchStats = {
        scanWork: changes.length * items.size,
        touched: touched.size,
        lookups,
      };
      return { touched, stats };
    },
    scan(changes, matches) {
      const touched = new Set<T>();
      let work = 0;
      for (const [item] of items) {
        for (const change of changes) {
          work += 1;
          if (matches(item, change)) touched.add(item);
        }
      }
      return { touched, work };
    },
    size: () => items.size,
  };
};

/** Flatten a compiled read set into the array form the matcher takes. */
export const depsOf = (compiled: {
  readonly components: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}): Dependencies => ({
  components: [...compiled.components],
  models: [...compiled.models],
});

/** Today's `matchesReads` plus the row-id arm a row subscription needs. */
export const matchesDependencies = (deps: Dependencies, change: ReplicaChange): boolean => {
  if (deps.rows?.includes(change.id) === true) return true;
  const exact = new Set(deps.components ?? []);
  const models = new Set(deps.models ?? []);
  for (const component of change.components) {
    if (exact.has(component)) return true;
    const slash = component.indexOf("/");
    if (models.has(slash === -1 ? component : component.slice(0, slash))) return true;
  }
  return change.components.length === 0 && models.size > 0;
};
