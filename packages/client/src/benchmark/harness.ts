/**
 * Measurement harness for the replica read-model benchmark (#503).
 *
 * Shared by the benchmark entry point and its invariant test so both exercise
 * the same wiring: a counted store, the replica-shaped `AdjacencyReader` the
 * namespace hands the shipped traversal helpers, and a batched latency
 * sampler.
 *
 * The counters are the gate metric. Wall-clock varies with the machine; the
 * number of store reads and rows a read touches is a property of the shape and
 * is what must stay at zero (or at the row's degree).
 */

import type { Entity } from "@ebbjs/core";
import type { MaterializationPolicy, Replica } from "@ebbjs/storage/replica";

import type { AdjacencyReader } from "../sync/relationship";
import { traversalCounter } from "../sync/traversal-counter";
import { ON_DEMAND_TYPE } from "./workspace";

/** The client's shipped residency: everything held except the on-demand type. */
export const heldMetadata: MaterializationPolicy = {
  holds: (type) => type !== ON_DEMAND_TYPE,
};

// ---------------------------------------------------------------------------
// Counted store
// ---------------------------------------------------------------------------

export interface StoreSnapshot {
  /** `get` calls. */
  readonly calls: number;
  /** Calls that returned a row. */
  readonly rows: number;
}

export interface CountingStore {
  /** Stands in for `storage.entities.get`. */
  readonly read: (id: string) => Promise<Entity | null>;
  readonly snapshot: () => StoreSnapshot;
  readonly reset: () => void;
}

export const createCountingStore = (rows: ReadonlyMap<string, Entity>): CountingStore => {
  let calls = 0;
  let returned = 0;
  return {
    read: async (id) => {
      calls += 1;
      const row = rows.get(id) ?? null;
      if (row !== null) returned += 1;
      return row;
    },
    snapshot: () => ({ calls, rows: returned }),
    reset: () => {
      calls = 0;
      returned = 0;
    },
  };
};

// ---------------------------------------------------------------------------
// Row and adjacency readers
// ---------------------------------------------------------------------------

/**
 * Row reads straight off the replica's resident map: the materialized read
 * path, where a metadata row is a map hit rather than a store round trip.
 */
export const replicaRowReader =
  (replica: Replica) =>
  (id: string): Promise<Entity | null> =>
    Promise.resolve(replica.get(id) ?? null);

/**
 * The async reader `namespace.ts` builds for the shipped row accessors
 * (`replicaAdjacency`): the replica's indices behind the async seam, so the
 * accessor helpers stay unchanged.
 */
export const replicaAdjacency = (replica: Replica): AdjacencyReader => ({
  forwardLinks: async (query) => replica.relationshipLinks(query),
  reverseSourceIds: async (query) =>
    replica.relationships({ as: query.as, type: query.type, targetId: query.targetId }),
  membershipsOf: async (entityId) => replica.membershipLinks(entityId),
});

export interface IndexCounter {
  /** Wrap an adjacency reader so the rows its index reads yield are counted. */
  readonly adjacency: (inner: AdjacencyReader) => AdjacencyReader;
  /** Count rows an unwrapped index read yielded. */
  readonly record: (rows: readonly unknown[]) => void;
  readonly snapshot: () => number;
  readonly reset: () => void;
}

export const createIndexCounter = (): IndexCounter => {
  let rows = 0;
  return {
    adjacency: (inner) => ({
      forwardLinks: async (query) => {
        const links = await inner.forwardLinks(query);
        rows += links.length;
        return links;
      },
      reverseSourceIds: async (query) => {
        const ids = await inner.reverseSourceIds(query);
        rows += ids.length;
        return ids;
      },
      membershipsOf: async (entityId) => {
        const memberships = await inner.membershipsOf(entityId);
        rows += memberships.length;
        return memberships;
      },
    }),
    record: (returned) => {
      rows += returned.length;
    },
    snapshot: () => rows,
    reset: () => {
      rows = 0;
    },
  };
};

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface CounterSnapshot {
  /** Storage `get` calls per read. */
  readonly storeReads: number;
  /** Storage rows returned per read. */
  readonly storeRows: number;
  /** Rows the adjacency indices yielded per read — the degree. */
  readonly indexRows: number;
  /** Rows the traversal helpers recorded examining (index rows + by-id loads). */
  readonly rowsExamined: number;
}

export const zeroCounters = (): CounterSnapshot => ({
  storeReads: 0,
  storeRows: 0,
  indexRows: 0,
  rowsExamined: 0,
});

/** The shared process-wide traversal counter plus a store and index counter. */
export interface CounterSet {
  readonly reset: () => void;
  readonly snapshot: () => CounterSnapshot;
}

export const createCounterSet = (store: CountingStore, index: IndexCounter): CounterSet => ({
  reset: () => {
    store.reset();
    index.reset();
    traversalCounter.reset();
  },
  snapshot: () => {
    const stored = store.snapshot();
    return {
      storeReads: stored.calls,
      storeRows: stored.rows,
      indexRows: index.snapshot(),
      rowsExamined: traversalCounter.rowsExamined,
    };
  },
});

const perCall = (counters: CounterSnapshot, calls: number): CounterSnapshot => ({
  storeReads: counters.storeReads / calls,
  storeRows: counters.storeRows / calls,
  indexRows: counters.indexRows / calls,
  rowsExamined: counters.rowsExamined / calls,
});

// ---------------------------------------------------------------------------
// Latency sampling
// ---------------------------------------------------------------------------

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const minOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.min(...values);
export const maxOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

export const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
export const entityDegree = (value: unknown): number =>
  value === null || value === undefined ? 0 : 1;

export interface SampleOptions {
  readonly ids: readonly string[];
  readonly batches: number;
  /** Minimum calls per timed batch, so one call is never in timer resolution. */
  readonly callsPerBatch: number;
  readonly counters: CounterSet;
  /** Rows a read yields, probed once per sampled id. */
  readonly degreeOf: (value: unknown) => number;
}

export interface LatencySample {
  /** Median of the per-batch per-call times. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly counters: CounterSnapshot;
  readonly degrees: readonly number[];
}

/**
 * Time `read` in batches over `ids` after a warmup pass. Each batch is
 * reported per call, and the median of the batch medians is the headline
 * number; counters are read from one batch (every batch does the same work).
 */
export const sampleLatency = async (
  read: (id: string) => unknown,
  options: SampleOptions,
): Promise<LatencySample> => {
  const idCount = Math.max(1, options.ids.length);
  const repsPerBatch = Math.max(1, Math.ceil(options.callsPerBatch / idCount));
  const callsPerBatch = repsPerBatch * idCount;

  for (const id of options.ids) await read(id);

  const batches: number[] = [];
  let counters = zeroCounters();
  for (let batch = 0; batch < options.batches; batch += 1) {
    options.counters.reset();
    const start = performance.now();
    for (let rep = 0; rep < repsPerBatch; rep += 1) {
      for (const id of options.ids) await read(id);
    }
    batches.push((performance.now() - start) / callsPerBatch);
    counters = options.counters.snapshot();
  }

  const degrees = await Promise.all(
    options.ids.map(async (id) => options.degreeOf(await read(id))),
  );

  return {
    medianMs: median(batches),
    minMs: minOf(batches),
    maxMs: maxOf(batches),
    counters: perCall(counters, callsPerBatch),
    degrees,
  };
};
