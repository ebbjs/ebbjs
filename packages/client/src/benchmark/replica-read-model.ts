/**
 * Replica read-model benchmark at 10k documents (#503).
 *
 * Measures the shipped materialized replica (`@ebbjs/storage/replica`) against
 * the workspace shape from the epic #495 spike, so #503's numbers are
 * comparable with it: held metadata footprint, traversal cost (wall-clock and
 * rows touched), search over held pages, the one-pass projection build, and
 * the on-demand body path.
 *
 * The replica is seeded directly: one `ReplicaRecord` is built in memory and
 * handed to `replica.load(record)`. Seeding through the memory adapter's
 * `set` is O(n²) (the spike measured 507.7 s for 39,999 inserts) and would
 * measure the adapter's write path, not the replica's read path.
 *
 * Run from the repo root: `pnpm client:benchmark`
 * Env: N (documents, default 10000), SAMPLE (sampled ids, default 25),
 *      BODY_BLOCKS (default 120), BODY_CHARS (default 200),
 *      BRANCH (default 10), REFS_PER_PAGE (default 2).
 *
 * Markdown goes to stdout and nothing else; progress and diagnostics to
 * stderr, so the output can be pasted into an issue verbatim.
 */

import { arch, cpus, platform, release } from "node:os";
import { Type } from "@sinclair/typebox";
import { carriesComponent, EBB_MODEL_NAME, type Entity } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";
import type { Replica, ReplicaStats } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

import { fieldComponent, makeHlc } from "@ebbjs/core";
import { emptyQuery, type Query } from "../sync/query";
import { createQueryCache, type QuerySource } from "../sync/query-cache";
import { createReplicaExecutor, executePlan, patchResultRows } from "../sync/query-execute";
import { planQuery } from "../sync/query-plan";
import { forwardMany, forwardOne, membershipGroups, reverse } from "../sync/relationship";
import { createSubscriptionRegistry } from "../sync/subscriptions";
import { recordResultRows, traversalCounter } from "../sync/traversal-counter";
import {
  arrayLength,
  createCounterSet,
  createCountingStore,
  createIndexCounter,
  entityDegree,
  heldMetadata,
  holdsRow,
  maxOf,
  median,
  minOf,
  replicaAdjacency,
  replicaRowReader,
  sampleLatency,
  type CounterSnapshot,
  type LatencySample,
} from "./harness";
import {
  configFromEnv,
  createHeldRows,
  createWorkspace,
  ON_DEMAND_TYPE,
  pageId,
  spreadIndices,
  stringField,
  summariseIndexKeys,
  UPDATED_AT_BASE,
  WORKSPACE_GROUP_ID,
  type BenchConfig,
  type Workspace,
} from "./workspace";

// ---------------------------------------------------------------------------
// Config and helpers
// ---------------------------------------------------------------------------

const harnessStart = performance.now();

const config = configFromEnv(process.env);
const log = (message: string): void => {
  process.stderr.write(`[replica-bench] ${message}\n`);
};

const pageShape = Type.Object({ title: Type.String() });
const groupShape = Type.Object({ name: Type.String() });

const HEAP_REPS = 5;
const LOAD_REPS = 5;
const LATENCY_BATCHES = 5;
const TRAVERSAL_CALLS_PER_BATCH = 2_000;
const SEARCH_CALLS_PER_BATCH = 10;
/** The #495 spike's one-pass projection build at the same 10k shape. */
const SPIKE_PROJECTION_BUILD_MS = 37.0;

/** Stable Markdown number formatting: no locale-dependent grouping. */
const grouped = (value: number): string =>
  Number.isInteger(value)
    ? value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : value.toFixed(0);

const fixed = (value: number, digits: number): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "n/a";

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
const usPerCall = (ms: number): string => `${fixed(ms * 1000, 2)} µs`;
const ms = (value: number): string => `${fixed(value, 1)} ms`;
const bytes = (value: number): string => grouped(Math.round(value));

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

log(
  `generating ${config.n.toLocaleString()} pages carrying ${(
    config.n -
    1 +
    config.n * config.refsPerPage
  ).toLocaleString()} edge keys, ${config.n.toLocaleString()} membership rows, ` +
    `${config.bodyBlocks}x${config.bodyChars}-char bodies`,
);
const generateStart = performance.now();
const workspace = createWorkspace(config);
const generateMs = performance.now() - generateStart;
log(`workspace generated in ${ms(generateMs)}`);

const heldRows = workspace.record.entities.filter(holdsRow);
const store = createCountingStore(workspace.rows);

// ---------------------------------------------------------------------------
// 1a. Footprint — JSON bytes of the held rows (independent of V8)
// ---------------------------------------------------------------------------

const rowsOfModel = (type: string): readonly Entity[] =>
  heldRows.filter((entity) => entity.model === type);

const pageJson = jsonBytes(rowsOfModel("page"));
// Every platform row is an `ebb` row, so the component is what splits them out.
// A link is not one of them: it is a key of its source page.
const platformRows = heldRows.filter((entity) => entity.model === EBB_MODEL_NAME);
const groupJson = jsonBytes(
  platformRows.filter(
    (entity) => carriesComponent(entity, "membership") || carriesComponent(entity, "group"),
  ),
);
const metadataJson = pageJson + groupJson;
const bodyJson = workspace.bodyBytes * config.n;
const workspaceJson = metadataJson + bodyJson;
const recordBodyJson = jsonBytes(
  workspace.record.entities.filter((entity) => entity.model === ON_DEMAND_TYPE),
);

// ---------------------------------------------------------------------------
// 1b. Footprint — heap bytes the replica actually retains
// ---------------------------------------------------------------------------

/** V8's `gc` is a global only under `--expose-gc`; `typeof` is safe either way. */
const heapGc: (() => void) | undefined = typeof gc === "function" ? gc : undefined;

const heapAfterGc = (force: () => void): number => {
  force();
  force();
  return process.memoryUsage().heapUsed;
};

/**
 * Paired heap accounts, every rep inside one measurement window: the held rows
 * are allocated fresh so the account owns their objects, one `Map<id, row>` is
 * built over exactly those rows as the reference cost of a base map, and then
 * a replica is `load`ed over the same rows so its own structures land on top.
 *
 * The earlier rows-only `Map` baseline reused the workspace's row objects, so
 * it never counted them and the replica figure read as a metadata total when
 * it was indices only.
 */
interface HeapAccounts {
  readonly rows: readonly number[];
  readonly baseMap: readonly number[];
  readonly replica: readonly number[];
  readonly indices: readonly number[];
  readonly total: readonly number[];
}

const measureHeap = (
  force: () => void,
  config: BenchConfig,
  seed: Workspace["record"],
  options: typeof loadOptions,
): HeapAccounts => {
  // The record's on-demand rows ride along with every rep so `load` is still
  // seen dropping a held type, exactly as on the workspace record.
  const bodyRows = seed.entities.filter((entity) => !holdsRow(entity));
  const recordFor = (rows: readonly Entity[]): Workspace["record"] => ({
    ...seed,
    entities: [...rows, ...bodyRows],
  });
  const mapOf = (rows: readonly Entity[]): ReadonlyMap<string, Entity> =>
    new Map(rows.map((entity) => [entity.id, entity]));

  const rowsAccount: number[] = [];
  const baseMapAccount: number[] = [];
  const replicaAccount: number[] = [];
  const indicesAccount: number[] = [];
  const totals: number[] = [];
  // Every account stays pinned for the whole measurement. Freeing a previous
  // rep's account during this rep's forced GC would subtract its bytes from
  // the delta being measured, collapsing it to noise.
  const pinned: unknown[] = [];

  // One untimed rep: the first build pays the JIT and inline-cache warm-up and
  // would otherwise read as a systematically larger account.
  const warmRows = createHeldRows(config);
  const warmRecord = recordFor(warmRows);
  const warmBaseMap = mapOf(warmRows);
  const warmReplica = createReplica(options);
  warmReplica.load(warmRecord);
  heapAfterGc(force);

  for (let rep = 0; rep < HEAP_REPS; rep += 1) {
    const base = heapAfterGc(force);
    const rows = createHeldRows(config);
    const record = recordFor(rows);
    pinned.push(rows, record);
    const withRows = heapAfterGc(force);

    const baseMap = mapOf(rows);
    pinned.push(baseMap);
    const withBaseMap = heapAfterGc(force);

    const probe = createReplica(options);
    probe.load(record);
    pinned.push(probe);
    const withReplica = heapAfterGc(force);

    if (
      rows.length === 0 ||
      rows.length >= seed.entities.length ||
      baseMap.size !== rows.length ||
      probe.stats().entities !== rows.length
    ) {
      throw new Error("heap account: built object is not the held row set");
    }
    const rowsBytes = withRows - base;
    const baseMapBytes = withBaseMap - withRows;
    const replicaBytes = withReplica - withBaseMap;
    rowsAccount.push(rowsBytes);
    baseMapAccount.push(baseMapBytes);
    replicaAccount.push(replicaBytes);
    indicesAccount.push(replicaBytes - baseMapBytes);
    totals.push(rowsBytes + replicaBytes);
  }

  if (pinned.length !== HEAP_REPS * 4) throw new Error("heap account: lost an account");
  if (
    warmRows.length === 0 ||
    warmBaseMap.size !== warmRows.length ||
    warmReplica.stats().entities !== warmRows.length
  ) {
    throw new Error("heap account: warm-up is not the held row set");
  }
  return {
    rows: rowsAccount,
    baseMap: baseMapAccount,
    replica: replicaAccount,
    indices: indicesAccount,
    total: totals,
  };
};

const loadOptions = {
  materialization: heldMetadata,
  readComponent: store.read,
  // Disabled so a read stays warm for the whole sweep: every document below is
  // read once, and a second read must not go back to the store.
  residencyTtlMs: 0,
} as const;

const heapAccounts: HeapAccounts | null =
  heapGc === undefined ? null : measureHeap(heapGc, config, workspace.record, loadOptions);

if (heapGc === undefined) {
  process.stderr.write(
    "[replica-bench] gc unavailable (run with NODE_OPTIONS=--expose-gc): " +
      "reporting JSON footprint only, no heap account\n",
  );
}

// ---------------------------------------------------------------------------
// 4. One-pass projection build (measured before the reads below so the
//    replica under test is untouched by the throwaway heap probes)
// ---------------------------------------------------------------------------

const replica: Replica = createReplica(loadOptions);
const copyRecord = (): ReplicaRecord => ({
  ...workspace.record,
  entities: [...workspace.record.entities],
});
const assemblySamples = Array.from({ length: LOAD_REPS }, () => {
  const start = performance.now();
  copyRecord();
  return performance.now() - start;
});

// Settle the throwaway heap accounts so their collection is not charged to the
// build timing (only possible when this process has `gc`).
if (heapGc !== undefined) heapAfterGc(heapGc);

// The first load is the app-startup path. Repeated loads are kept separate:
// each one also tears down the previous base, so they are not a cold build.
const firstLoadStart = performance.now();
replica.load(workspace.record);
const firstLoadMs = performance.now() - firstLoadStart;
const loadSamples = Array.from({ length: LOAD_REPS }, () => {
  const start = performance.now();
  replica.load(workspace.record);
  return performance.now() - start;
});
const loadMedian = median(loadSamples);
const stats: ReplicaStats = replica.stats();
const indexShape = summariseIndexKeys(heldRows);

// ---------------------------------------------------------------------------
// Self-checks: fail loudly rather than measure a fixture that is not the
// documented shape.
// ---------------------------------------------------------------------------

const indexCounter = createIndexCounter();
const counters = createCounterSet(store, indexCounter);
const reader = replicaRowReader(replica);
const adjacency = indexCounter.adjacency(replicaAdjacency(replica));

const rootChildren = await reverse(
  reader,
  adjacency,
  pageId(0),
  "page",
  pageShape,
  "parent",
  "page",
);
const expectedRootChildren = Math.min(config.branch, config.n - 1);
if (rootChildren.length !== expectedRootChildren) {
  throw new Error(
    `self-check: root has ${rootChildren.length} children, expected ${expectedRootChildren}`,
  );
}
const rootOfFirst = await forwardOne(reader, adjacency, pageId(1), "page", "parent", "page");
if (rootOfFirst?.id !== pageId(0)) {
  throw new Error(`self-check: parent of page_1 is ${rootOfFirst?.id}, expected page_0`);
}
const groupsOfFirst = await membershipGroups(
  reader,
  adjacency,
  pageId(1),
  EBB_MODEL_NAME,
  groupShape,
);
if (groupsOfFirst.length !== 1 || groupsOfFirst[0]?.id !== WORKSPACE_GROUP_ID) {
  throw new Error("self-check: page_1 is not filed in exactly the workspace group");
}
if (stats.held !== workspace.counts.heldRows) {
  throw new Error(
    `self-check: replica holds ${stats.held} rows, fixture generates ${workspace.counts.heldRows}`,
  );
}
if (
  stats.heldByModel[ON_DEMAND_TYPE] !== undefined ||
  replica.get(workspace.bodyIds[0]) !== undefined
) {
  throw new Error("self-check: an on-demand body is resident after load");
}
counters.reset();
await forwardOne(reader, adjacency, pageId(1), "page", "parent", "page");
const probeCounters = counters.snapshot();
if (probeCounters.storeReads !== 0) {
  throw new Error(
    `self-check: forwardOne read ${probeCounters.storeReads} store rows; the replica should own them`,
  );
}

// ---------------------------------------------------------------------------
// 2. Traversal cost
// ---------------------------------------------------------------------------

interface ReadCase {
  readonly label: string;
  /** Returns the query builder's thenable directly; the sampler awaits it. */
  readonly read: (id: string) => unknown;
  readonly degreeOf: (value: unknown) => number;
}

const sampleIds = spreadIndices(config.n, config.sample).map(pageId);

type RowReader = (id: string) => Promise<Entity | null>;

/**
 * The four accessor cases the store-backed table mirrors. Both tables build
 * from here, so swapping the by-id reader cannot drift a reader from the cases
 * it mirrors.
 */
const casesWithReader = (readRow: RowReader): readonly [ReadCase, ReadCase, ReadCase, ReadCase] => [
  {
    label: "`reverse` — children (`parent` target)",
    read: (id) => reverse(readRow, adjacency, id, "page", pageShape, "parent", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`forwardOne` — parent (`parent` source)",
    read: (id) => forwardOne(readRow, adjacency, id, "page", "parent", "page"),
    degreeOf: entityDegree,
  },
  {
    label: "`forwardMany` — references (`references` source)",
    read: (id) =>
      forwardMany(readRow, adjacency, id, "page", "page", pageShape, "references", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`membershipGroups` — groups",
    read: (id) => membershipGroups(readRow, adjacency, id, EBB_MODEL_NAME, groupShape),
    degreeOf: arrayLength,
  },
];

const [childrenCase, parentCase, referencesCase, groupsCase] = casesWithReader(reader);

const accessorCases: readonly ReadCase[] = [
  childrenCase,
  parentCase,
  {
    label: "`reverse` — backlinks (`references` target)",
    read: (id) => reverse(reader, adjacency, id, "page", pageShape, "references", "page"),
    degreeOf: arrayLength,
  },
  referencesCase,
  groupsCase,
];

const countIndexRows = <T extends readonly unknown[]>(rows: T): T => {
  indexCounter.record(rows);
  return rows;
};

const directCases: readonly ReadCase[] = [
  {
    label: "`relationships` — children (`targetId`)",
    read: async (id) =>
      countIndexRows(replica.relationships({ as: "parent", type: "page", targetId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationships` — backlinks (`targetId`)",
    read: async (id) =>
      countIndexRows(replica.relationships({ as: "references", type: "page", targetId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationships` — parent targets (`sourceId`, the row's link component)",
    read: async (id) =>
      countIndexRows(replica.relationships({ as: "parent", type: "page", sourceId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationships` — reference targets (`sourceId`, the row's link component)",
    read: async (id) =>
      countIndexRows(replica.relationships({ as: "references", type: "page", sourceId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`memberships` — groups (`entityId`)",
    read: async (id) => countIndexRows(replica.memberships({ entityId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`membershipLinks` — membership rows (`entityId`)",
    read: async (id) => countIndexRows(replica.membershipLinks(id)),
    degreeOf: arrayLength,
  },
];

const storageCases = casesWithReader(store.read);

const measureReads = async (cases: readonly ReadCase[]): Promise<readonly LatencySample[]> => {
  const samples: LatencySample[] = [];
  for (const readCase of cases) {
    samples.push(
      await sampleLatency(readCase.read, {
        ids: sampleIds,
        batches: LATENCY_BATCHES,
        callsPerBatch: TRAVERSAL_CALLS_PER_BATCH,
        counters,
        degreeOf: readCase.degreeOf,
      }),
    );
  }
  return samples;
};

log(`timing ${accessorCases.length + directCases.length + storageCases.length} traversal reads`);
const accessorSamples = await measureReads(accessorCases);
const directSamples = await measureReads(directCases);
const storageSamples = await measureReads(storageCases);

// ---------------------------------------------------------------------------
// 3. Search over held pages
// ---------------------------------------------------------------------------

const needle = "Document 4";
const equalityQuery: Query = {
  source: "page",
  groups: [
    [{ kind: "field", field: "updated_at", value: UPDATED_AT_BASE + Math.floor(config.n / 2) }],
  ],
  order: null,
  limit: null,
  joins: [],
};
const executor = createReplicaExecutor(replica);
const titleOf = (entity: Entity): string => stringField(entity, "title") ?? "";
const pageRowsHeld = stats.byModel["page"] ?? 0;

const searchCases: readonly ReadCase[] = [
  {
    label: `title substring scan — \`replica.iterate("page")\` + \`includes("${needle}")\``,
    read: async () => replica.iterate("page").filter((row) => titleOf(row).includes(needle)),
    degreeOf: arrayLength,
  },
  {
    label: "`executePlan` — field equality (`updated_at`)",
    read: async () => executePlan(planQuery(equalityQuery), executor),
    degreeOf: arrayLength,
  },
  {
    label: "`executePlan` — whole-type scan (no predicate)",
    read: async () => executePlan(planQuery(emptyQuery("page")), executor),
    degreeOf: arrayLength,
  },
];

log("timing search over held pages");
const searchSamples: LatencySample[] = [];
for (const searchCase of searchCases) {
  searchSamples.push(
    await sampleLatency(searchCase.read, {
      ids: ["page"],
      batches: LATENCY_BATCHES,
      callsPerBatch: SEARCH_CALLS_PER_BATCH,
      counters,
      degreeOf: searchCase.degreeOf,
    }),
  );
}

// ---------------------------------------------------------------------------
// 5. Leased bodies
// ---------------------------------------------------------------------------

const bodySample = workspace.bodyIds.slice(0, Math.min(100, workspace.bodyIds.length));
const primaryBody = bodySample[0];
if (primaryBody === undefined) throw new Error("fixture produced no on-demand bodies");
const bodyComponents = [`${ON_DEMAND_TYPE}/content`];

// Warm the read path so the first timed read is not JIT + first-read.
for (const id of bodySample.slice(0, 3)) await replica.read(id, bodyComponents);

const readSamples: number[] = [];
let coldReads = 0;
for (const id of bodySample) {
  store.reset();
  const start = performance.now();
  const loaded = await replica.read(id, bodyComponents);
  readSamples.push(performance.now() - start);
  coldReads = Math.max(coldReads, store.snapshot().calls);
  if (loaded === null) throw new Error(`on-demand body self-check: ${id} did not read`);
}
const readMedian = median(readSamples);

// The warm path: a read inside the grace period installs nothing and reads
// nothing, which is what a remount costs.
store.reset();
await replica.read(primaryBody, bodyComponents);
const warmReads = store.snapshot().calls;
const bodiesResident = replica.stats().byModel[ON_DEMAND_TYPE] ?? 0;
const bodyLeases = replica.stats().leases;
if (coldReads !== 1) {
  throw new Error(`on-demand body self-check: cold read touched ${coldReads} store rows`);
}
if (warmReads !== 0) {
  throw new Error(`on-demand body self-check: a warm read touched ${warmReads} store rows`);
}
if (bodiesResident < bodySample.length) {
  throw new Error(
    `on-demand body self-check: ${bodiesResident} of ${bodySample.length} bodies stayed resident`,
  );
}
if (bodyLeases.leased !== 0) {
  throw new Error(`on-demand body self-check: ${bodyLeases.leased} leases outlived their read`);
}

// ---------------------------------------------------------------------------
// 6. Patched result changes (#942)
// ---------------------------------------------------------------------------

/**
 * One change workload, measured through the shipped query cache (#942).
 *
 * "Rows examined" is `traversalCounter.resultRowsRead`: the shipped counter the
 * replica executor records into, so a re-run adds every row its plan scan
 * materialized and a patch adds the rows it re-read by id. A row subscription's
 * consumer re-reads its one row per change, which is counted the same way.
 * "Re-runs" and "patches" are this benchmark's own count of the source calls
 * the cache made, one per change at most.
 */
interface ChangeWorkload {
  readonly label: string;
  readonly changes: number;
  readonly runs: number;
  readonly patches: number;
  readonly rowsExamined: number;
  /**
   * Median time inside the source call a change caused: the plan run
   * (scan + order + project) or the one-row re-projection. The replica's
   * write path is measured once and quoted separately, because it costs the
   * same whether or not a result is watching.
   */
  readonly medianReadMs: number;
}

interface PageResultRow {
  readonly id: string;
  readonly title: string;
}

/** The projection a run and a patch share, so the two cannot drift. */
const pageResult = (entity: Entity): PageResultRow => ({
  id: entity.id,
  title: stringField(entity, "title") ?? "",
});

/**
 * A cached rows query over the benchmark replica: the shipped plan and the
 * shipped executor, so a re-run really does scan the source type and a patch
 * really does read the changed rows by id. The cache above it is the shipped
 * patch dispatcher; only the source is local because the benchmark has no
 * client schema to lower a builder chain through.
 */
const countedSource = (query: Query, withPatch = true) => {
  const plan = planQuery(query);
  const runs: number[] = [];
  const patches: number[] = [];
  const source: QuerySource<PageResultRow> = {
    ready: (): void => {},
    isReady: (): boolean => true,
    execute: (): readonly PageResultRow[] => {
      const start = performance.now();
      const rows = executePlan(plan, createReplicaExecutor(replica)).map(pageResult);
      runs.push(performance.now() - start);
      return rows;
    },
  };
  // Without the hook the cache re-runs every relevant change: the behaviour a
  // source that cannot patch keeps, and the "before" this change is measured
  // against.
  if (withPatch) {
    source.patch = (ids: readonly string[]): readonly PageResultRow[] | null => {
      const start = performance.now();
      const executor = createReplicaExecutor(replica);
      const rows = ids.flatMap((id) => {
        const found = executor.get(id);
        return found === undefined ? [] : [found];
      });
      const projected = rows.length === ids.length ? rows.map(pageResult) : null;
      patches.push(performance.now() - start);
      return projected;
    };
  }
  return { source, runs, patches };
};

/**
 * Changes are delivered straight into the replica, which is what the sync
 * stream does: the revision journal is the only thing a cached result reads.
 */
let benchPosition = 0;

const deliverPageTitle = (pageIndex: number): void => {
  benchPosition += 1;
  replica.ingest(
    {
      id: `a_bench_${benchPosition}`,
      actor_id: "bench",
      hlc: makeHlc(benchPosition),
      gsn: benchPosition,
      updates: [],
    },
    [
      {
        id: `u_bench_${benchPosition}`,
        subject_id: pageId(pageIndex),
        component: "page/title",
        method: "replace",
        data: {
          value: `Renamed ${benchPosition}`,
          update_id: `u_bench_${benchPosition}`,
          hlc: makeHlc(benchPosition),
        },
      },
    ],
    benchPosition,
  );
};

const deliverPageUpdatedAt = (pageIndex: number): void => {
  benchPosition += 1;
  replica.ingest(
    {
      id: `a_bench_${benchPosition}`,
      actor_id: "bench",
      hlc: makeHlc(benchPosition),
      gsn: benchPosition,
      updates: [],
    },
    [
      {
        id: `u_bench_${benchPosition}`,
        subject_id: pageId(pageIndex),
        component: "page/updated_at",
        method: "replace",
        data: {
          value: UPDATED_AT_BASE + config.n + benchPosition,
          update_id: `u_bench_${benchPosition}`,
          hlc: makeHlc(benchPosition),
        },
      },
    ],
    benchPosition,
  );
};

/** A page row entering the model: a membership change, which always re-runs. */
const deliverNewPage = (pageIndex: number): void => {
  benchPosition += 1;
  const id = `page_bench_${pageIndex}`;
  replica.ingest(
    {
      id: `a_bench_${benchPosition}`,
      actor_id: "bench",
      hlc: makeHlc(benchPosition),
      gsn: benchPosition,
      updates: [],
    },
    [
      {
        id: `u_bench_${benchPosition}_create`,
        subject_id: id,
        model: "page",
        method: "create",
        data: null,
        hlc: makeHlc(benchPosition),
      },
      {
        id: `u_bench_${benchPosition}_title`,
        subject_id: id,
        component: "page/title",
        method: "replace",
        data: {
          value: `New ${benchPosition}`,
          update_id: `u_bench_${benchPosition}`,
          hlc: makeHlc(benchPosition),
        },
      },
    ],
    benchPosition,
  );
};

/**
 * Prime one cached result, then time one change at a time and count what the
 * cache did with it. The priming run is excluded from every counter and from
 * the timing, so each row is a per-change cost.
 */
const measureChanges = (
  label: string,
  query: Query,
  change: (index: number) => void,
  changes: number,
  options: { readonly patch?: boolean } = {},
): ChangeWorkload => {
  const registry = createSubscriptionRegistry(replica);
  const cache = createQueryCache(replica, registry);
  const { source, runs, patches } = countedSource(query, options.patch ?? true);
  const store = cache.watch("rows", query, source);
  const detach = store.subscribe(() => {
    /* the result is read back through the snapshot */
  });
  const primed = store.getSnapshot();
  if (primed.status !== "current" || primed.data === undefined) {
    throw new Error(`${label}: the priming run did not settle`);
  }
  // The priming run is not a change: it is excluded from every counter and
  // from the timing, so each row is a per-change cost.
  runs.length = 0;
  patches.length = 0;

  traversalCounter.reset();
  for (let index = 0; index < changes; index += 1) change(index);
  const examined = traversalCounter.resultRowsRead;
  const settled = store.getSnapshot();
  if (settled.status !== "current") throw new Error(`${label}: a change left the result stale`);

  detach();
  registry.close();
  return {
    label,
    changes,
    runs: runs.length,
    patches: patches.length,
    rowsExamined: examined / changes,
    medianReadMs: median([...runs, ...patches]),
  };
};

/**
 * A row subscription (#942): the consumer re-reads its one row per change, the
 * same read `namespace.ts`'s `subscribeToEntity` performs.
 */
const measureRowSubscription = (changes: number): ChangeWorkload => {
  const registry = createSubscriptionRegistry(replica);
  const rowId = pageId(Math.floor(config.n / 2));
  const subscription = registry.open({ kind: "row", row: rowId });
  let reads = 0;
  const readSamples: number[] = [];
  subscription.onChange(() => {
    const start = performance.now();
    const row = replica.get(rowId);
    readSamples.push(performance.now() - start);
    if (row === undefined) return;
    reads += 1;
    recordResultRows(1);
  });

  traversalCounter.reset();
  for (let index = 0; index < changes; index += 1) {
    deliverPageTitle(Math.floor(config.n / 2));
  }
  const examined = traversalCounter.resultRowsRead;
  subscription.release();
  registry.close();
  return {
    label: "row subscription — projected `title` edit on the subscribed row",
    changes,
    runs: 0,
    patches: reads,
    rowsExamined: examined / changes,
    medianReadMs: median(readSamples),
  };
};

const CHANGE_ITERATIONS = 200;
const RE_RUN_ITERATIONS = 20;
const middlePage = Math.floor(config.n / 2);

log("timing patched and re-run result changes");
const changeWorkloads: readonly ChangeWorkload[] = [
  measureChanges(
    "rows query — projected `title` edit, before #942 (every change re-runs)",
    emptyQuery("page"),
    (index) => deliverPageTitle(spreadIndices(config.n, RE_RUN_ITERATIONS)[index] ?? middlePage),
    RE_RUN_ITERATIONS,
    { patch: false },
  ),
  measureChanges(
    "rows query — projected `title` edit (patch)",
    emptyQuery("page"),
    (index) => deliverPageTitle(spreadIndices(config.n, CHANGE_ITERATIONS)[index] ?? middlePage),
    CHANGE_ITERATIONS,
  ),
  measureChanges(
    "rows query — a page row enters (membership, re-run)",
    emptyQuery("page"),
    deliverNewPage,
    RE_RUN_ITERATIONS,
  ),
  measureChanges(
    "rows query — predicate `updated_at` edit (re-run)",
    {
      ...emptyQuery("page"),
      groups: [[{ kind: "field", field: "updated_at", value: UPDATED_AT_BASE }]],
    },
    deliverPageUpdatedAt,
    RE_RUN_ITERATIONS,
  ),
  measureChanges(
    "ordered rows query — projected `title` edit (re-run)",
    { ...emptyQuery("page"), order: { field: "updated_at", direction: "asc" } },
    (index) => deliverPageTitle(spreadIndices(config.n, RE_RUN_ITERATIONS)[index] ?? middlePage),
    RE_RUN_ITERATIONS,
  ),
  measureRowSubscription(CHANGE_ITERATIONS),
];

/**
 * The replica's write path on this fixture: what ingesting one action costs
 * whether or not a result is watching. It is quoted once because it is not part
 * of a re-run's or a patch's read cost, but it dominates a change's wall clock.
 */
const writePathMs = (() => {
  const samples: number[] = [];
  for (let index = 0; index < RE_RUN_ITERATIONS; index += 1) {
    const start = performance.now();
    deliverPageTitle(Math.floor(config.n / 2));
    samples.push(performance.now() - start);
  }
  return median(samples);
})();

/**
 * What splicing one row into a cached result costs beyond reading it: the
 * patch keeps the array order by rebuilding the result, which is O(result).
 */
const spliceMs = (() => {
  const registry = createSubscriptionRegistry(replica);
  const cache = createQueryCache(replica, registry);
  const { source } = countedSource(emptyQuery("page"));
  const store = cache.watch("rows", emptyQuery("page"), source);
  const detach = store.subscribe(() => {});
  const data = store.getSnapshot().data ?? [];
  const first = data[0];
  if (first === undefined) throw new Error("splice measurement: no primed result");
  const samples: number[] = [];
  for (let index = 0; index < CHANGE_ITERATIONS; index += 1) {
    const start = performance.now();
    patchResultRows(data, [{ ...first, title: `spliced ${index}` }]);
    samples.push(performance.now() - start);
  }
  detach();
  registry.close();
  return median(samples);
})();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const out: string[] = [];
const push = (...lines: string[]): void => {
  out.push(...lines);
};

const cpu = cpus()[0]?.model ?? "unknown";

push(
  `# Replica read model — ${grouped(config.n)} documents`,
  "",
  "`pnpm client:benchmark` — the shipped `@ebbjs/storage/replica` loaded directly from one",
  "in-memory `ReplicaRecord` (`replica.load(record)`), never seeded through the memory",
  "adapter's O(n²) `set`. Workspace shape mirrors the epic #495 spike.",
  "",
  "| knob | value |",
  "| --- | --- |",
  `| documents (\`N\`) | ${grouped(config.n)} |`,
  `| sampled ids (\`SAMPLE\`) | ${grouped(config.sample)} |`,
  `| branch (\`BRANCH\`) | ${grouped(config.branch)} |`,
  `| references per page (\`REFS_PER_PAGE\`) | ${grouped(config.refsPerPage)} |`,
  `| body blocks (\`BODY_BLOCKS\`) | ${grouped(config.bodyBlocks)} |`,
  `| body chars (\`BODY_CHARS\`) | ${grouped(config.bodyChars)} |`,
  `| node | ${process.version} (${platform()} ${arch()}, ${release()}) |`,
  `| cpu | ${cpu} |`,
  `| heap account | ${heapGc === undefined ? "unavailable (no `--expose-gc`), JSON footprint only" : `\`--expose-gc\`, median of ${HEAP_REPS} reps`} |`,
  "",
);

// 1. Footprint
const footprintRows: readonly (readonly [string, number, number])[] = [
  ["`page` (title, icon, updated_at, `ebb/link` edge keys)", workspace.counts.pages, pageJson],
  ["`membership` + `group`", workspace.counts.memberships + workspace.counts.groups, groupJson],
  ["**held metadata subtotal**", workspace.counts.heldRows, metadataJson],
  [
    `\`${ON_DEMAND_TYPE}\` bodies (representative row × ${grouped(config.n)}, on demand)`,
    config.n,
    bodyJson,
  ],
  ["**full workspace (hypothetical)**", workspace.counts.heldRows + config.n, workspaceJson],
];

push("## 1. Held metadata footprint", "", "### JSON bytes (uncompressed)", "");
push(
  "| bucket | rows | JSON bytes | size | % of workspace |",
  "| --- | ---: | ---: | ---: | ---: |",
);
for (const [label, rows, size] of footprintRows) {
  push(
    `| ${label} | ${grouped(rows)} | ${bytes(size)} | ${mb(size)} | ${pct(size, workspaceJson)} |`,
  );
}
push(
  "",
  `One representative body row is ${kb(workspace.bodyBytes)}; the store materializes ${grouped(
    workspace.counts.bodyRows,
  )} of them, not all ${grouped(config.n)}.`,
  `The record also carries ${grouped(workspace.counts.recordBodyRows)} \`${ON_DEMAND_TYPE}\` rows (${kb(
    recordBodyJson,
  )}) to prove \`load\` drops a non-held type.`,
  "The totals run ~14% above the #495 spike's 15.1 MB for the same 50,000 rows because every",
  "field here carries a per-field `update_id` of realistic length (`u_page_1234_title`, ~20–22",
  "chars, close to a 21-char nanoid) where the spike used short `u_${n}` placeholders, so the",
  "row bytes are not a like-for-like comparison with the spike.",
  "",
);

// Per-component attribution of the held bytes (#802): the replica now keeps a
// row's held components and leaves the lazy ones to the store, so the footprint
// has to be readable per component rather than per row.
const componentBytes = new Map<string, { rows: number; bytes: number }>();
for (const row of heldRows) {
  for (const [field, value] of Object.entries(row.data.fields)) {
    const component = fieldComponent(row.model, field);
    if (!heldMetadata.holds(component)) continue;
    const bucket = componentBytes.get(component) ?? { rows: 0, bytes: 0 };
    bucket.rows += 1;
    bucket.bytes += jsonBytes(value);
    componentBytes.set(component, bucket);
  }
}
const componentRows = [...componentBytes.entries()].sort(([, a], [, b]) => b.bytes - a.bytes);
const componentSubtotal = componentRows.reduce((sum, [, bucket]) => sum + bucket.bytes, 0);

push("### Resident bytes by component", "");
push(
  "Every held component of every held row, attributed by its value bytes. This is the #802",
  "residency view: the row-level buckets above are models, these are the units the replica keeps",
  "or leaves to the store.",
  "",
  "| component | rows carrying | JSON bytes | size | % of held components |",
  "| --- | ---: | ---: | ---: | ---: |",
);
for (const [component, bucket] of componentRows) {
  push(
    `| \`${component}\` | ${grouped(bucket.rows)} | ${bytes(bucket.bytes)} | ${mb(bucket.bytes)} | ${pct(bucket.bytes, componentSubtotal)} |`,
  );
}
push(
  `| **held components subtotal** | — | ${bytes(componentSubtotal)} | ${mb(componentSubtotal)} | 100.0% |`,
  "",
);

push("### Heap bytes the replica retains (V8)", "");
push(
  "Each rep runs in one measurement window, sampling `heapUsed` after two forced GCs at every",
  "step: the held rows allocated fresh (their own row objects, not the workspace's), then one",
  "`Map<id, row>` over exactly those rows, then a replica `load`ed over the same rows — so",
  "**adjacency indices + model index = replica structures − base map** and **resident metadata",
  "total = held rows + replica structures**, with the base map kept as the subtraction baseline",
  "and not added to the total. Every rep's rows, record, map, and replica stay pinned, so a",
  "later forced GC cannot reclaim an earlier rep's account.",
  "",
);
if (heapAccounts === null) {
  push(
    "Not measured: `gc` was unavailable, so this run reports the row-level JSON numbers only.",
    "",
  );
} else {
  const rowsAccount = heapAccounts.rows;
  const baseMapAccount = heapAccounts.baseMap;
  const replicaAccount = heapAccounts.replica;
  const indicesAccount = heapAccounts.indices;
  const totals = heapAccounts.total;
  const fullWorkspaceShare = pct(median(totals), workspaceJson);
  const indicesShare = pct(median(indicesAccount), median(totals));
  const baseMapShare = pct(median(baseMapAccount), median(totals));
  push(
    "| account | median | min | max | reps | % of hypothetical full workspace |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    `| held rows (fresh row objects + the record's reference array) | ${mb(median(rowsAccount))} | ${mb(minOf(rowsAccount))} | ${mb(maxOf(rowsAccount))} | ${HEAP_REPS} | — |`,
    `| base map (\`Map<id, row>\` over the same rows — reference cost, not in the total) | ${mb(median(baseMapAccount))} | ${mb(minOf(baseMapAccount))} | ${mb(maxOf(baseMapAccount))} | ${HEAP_REPS} | — |`,
    `| replica structures (its own base map + model index + both adjacency indices) | ${mb(median(replicaAccount))} | ${mb(minOf(replicaAccount))} | ${mb(maxOf(replicaAccount))} | ${HEAP_REPS} | — |`,
    `| **adjacency indices + model index (replica structures − base map)** | **${mb(median(indicesAccount))}** | ${mb(minOf(indicesAccount))} | ${mb(maxOf(indicesAccount))} | ${HEAP_REPS} | — |`,
    `| **resident metadata total (held rows + replica structures)** | **${mb(median(totals))}** | ${mb(minOf(totals))} | ${mb(maxOf(totals))} | ${HEAP_REPS} | **${fullWorkspaceShare}** |`,
    "",
    `The indices are ${indicesShare} of that total; the replica's own base map is about ${baseMapShare} (the reference map above), and the freshly allocated rows are the rest.`,
    "The JSON row number above and this heap total are different units and must not be added",
    "to each other: JSON bytes are the serialized rows, heap bytes are what V8 retains for the",
    "rows plus the indices built over them.",
    "",
  );
}

// 2. Traversal
const degreeCell = (sample: LatencySample): string =>
  sample.degrees.length === 0
    ? "n/a"
    : `${fixed(median(sample.degrees), 1)} (${grouped(minOf(sample.degrees))}–${grouped(
        maxOf(sample.degrees),
      )})`;

const counterCells = (sample: LatencySample): string => {
  const c: CounterSnapshot = sample.counters;
  return `${fixed(c.storeReads, 1)} | ${fixed(c.storeRows, 1)} | ${fixed(c.indexRows, 2)} | ${fixed(
    c.rowsExamined,
    2,
  )}`;
};

const readRows = (
  cases: readonly ReadCase[],
  samples: readonly LatencySample[],
): readonly string[] =>
  cases.map((readCase, i) => {
    const sample = samples[i];
    if (sample === undefined) throw new Error(`no sample for ${readCase.label}`);
    return `| ${readCase.label} | ${usPerCall(sample.medianMs)} | ${degreeCell(sample)} | ${counterCells(
      sample,
    )} |`;
  });

push(
  "## 2. Traversal cost",
  "",
  `Median per call over ${LATENCY_BATCHES} timed batches of ${grouped(
    TRAVERSAL_CALLS_PER_BATCH,
  )} calls each, ids spread evenly over \`page_0\`…\`page_${grouped(
    config.n - 1,
  )}\` so leaves, interior pages, and the root are all sampled. "Store reads" is \`get\``,
  'calls on the wrapped store; "rows examined" is the shipped `traversalCounter`.',
  "",
  "### Shipped accessors, rows read from the resident replica",
  "",
  "`reverse` / `forwardOne` / `forwardMany` / `membershipGroups` from",
  "`packages/client/src/sync/relationship.ts`, with the `replicaAdjacency`-shaped async",
  "reader `namespace.ts` wires (`replica.relationships` for both the source row's link",
  "component and the reverse index, `.membershipLinks`) and `replica.get` as the by-id",
  "row read.",
  "",
  "| read | µs/call (median) | degree median (min–max) | store reads/call | store rows/call | index rows/call | rows examined/call |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...readRows(accessorCases, accessorSamples),
  "",
  "The replica's index read is a fraction of a microsecond (next table). The accessor rows",
  "cost 7–11 µs at degree 0–2 because they run the shipped wrapper: an async adjacency",
  "read, `executePlan`, and the TypeBox projection plus an id-ordered sort. `forwardOne`",
  "skips the query builder, which is why it lands next to the direct read. Rows examined",
  "stay at the row's degree either way.",
  "",
  "### Direct replica index reads",
  "",
  "| read | µs/call (median) | degree median (min–max) | store reads/call | store rows/call | index rows/call | rows examined/call |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...readRows(directCases, directSamples),
  "",
  "### Same accessors, by-id rows read from the store (how `namespace.ts` wires `readLocalEntity` today)",
  "",
  "The adjacency already comes from the replica here; only the source/target row loads still",
  'round-trip through the store. This is the delta between "indices are resident" and',
  '"rows are resident".',
  "",
  "| read | µs/call (median) | degree median (min–max) | store reads/call | store rows/call | index rows/call | rows examined/call |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...readRows(storageCases, storageSamples),
  "",
);

// 3. Search
push(
  "## 3. Search over held pages",
  "",
  "No search surface ships yet. The substring scan is the shape a search would ride on today",
  '(`replica.iterate("page")` plus a title filter), not a shipped feature. The two',
  "`executePlan` rows are the shipped query path with a filter and as a whole-type scan; the",
  "whole-type scan also orders by id, which is an O(n log n) `localeCompare` sort.",
  "",
  `Each visits all ${grouped(pageRowsHeld)} held \`page\` rows. Median per call over ${LATENCY_BATCHES} batches of ${SEARCH_CALLS_PER_BATCH} calls.`,
  "",
  "| path | µs/call (median) | rows visited/call | rows matched (median) | store reads/call |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...searchCases.map((searchCase, i) => {
    const sample = searchSamples[i];
    if (sample === undefined) throw new Error(`no sample for ${searchCase.label}`);
    return `| ${searchCase.label} | ${usPerCall(sample.medianMs)} | ${grouped(
      pageRowsHeld,
    )} | ${grouped(median(sample.degrees))} | ${fixed(sample.counters.storeReads, 1)} |`;
  }),
  "",
);

// 4. Projection build
push(
  "## 4. One-pass projection build",
  "",
  "| step | median | min | max | reps |",
  "| --- | ---: | ---: | ---: | ---: |",
  `| fixture row generation (one-time, excluded from the build) | ${ms(generateMs)} | — | — | 1 |`,
  `| record assembly (copy of ${grouped(workspace.record.entities.length)} row references) | ${usPerCall(median(assemblySamples))} | ${usPerCall(minOf(assemblySamples))} | ${usPerCall(maxOf(assemblySamples))} | ${LOAD_REPS} |`,
  `| \`replica.load(record)\` — first load in this process | **${ms(firstLoadMs)}** | — | — | 1 |`,
  `| \`replica.load(record)\` — repeat loads (each also drops the previous base) | ${ms(loadMedian)} | ${ms(minOf(loadSamples))} | ${ms(maxOf(loadSamples))} | ${LOAD_REPS} |`,
  "",
  `Rows resident after load: ${grouped(stats.entities)} (${Object.entries(stats.byModel)
    .map(([type, count]) => `\`${type}\` ${grouped(count)}`)
    .join(", ")}).`,
  `Adjacency keys built (derived from the same rows): ${grouped(indexShape.reverseKeys)} reverse, ${grouped(
    indexShape.forwardKeys,
  )} forward, over ${grouped(indexShape.reverseRows)} + ${grouped(indexShape.forwardRows)} index rows.`,
  `The spike's projection build was **${fixed(SPIKE_PROJECTION_BUILD_MS, 1)} ms**; this is the shipped replica's \`load\` on a`,
  `different machine, so the two are not like-for-like. \`load\` is ~${fixed(
    loadMedian / SPIKE_PROJECTION_BUILD_MS,
    1,
  )}× that`,
  "narrower projection because it derives both adjacency directions for `relationship`",
  "and `membership` rows into plain objects, plus the model index. Measured:",
  `${usPerCall(loadMedian / Math.max(1, stats.held))} per held row and ${fixed(
    (loadMedian / Math.max(1, indexShape.reverseRows + indexShape.forwardRows)) * 1000,
    3,
  )} µs per index entry — the repeat-load median divided by the`,
  `${grouped(stats.held)} held rows and by the ${grouped(
    indexShape.reverseRows + indexShape.forwardRows,
  )} reverse+forward index rows above.`,
  "The build is a measurement, not a gate.",
  "",
);

// 5. Leased bodies
push(
  "## 5. Leased bodies",
  "",
  `\`${ON_DEMAND_TYPE}\` is the schema's on-demand type: not held, so \`load\` drops it and`,
  "`replica.read(id, components)` reads it through the store under a lease",
  "(`residencyTtlMs: 0` here, so a read stays warm for the whole sweep). Each document",
  "below is read once, so every timed read is cold; a second read inside the grace",
  "period is what a remount costs.",
  "",
  "| measure | value |",
  "| --- | ---: |",
  `| distinct documents read | ${grouped(bodySample.length)} |`,
  `| cold read, median | ${usPerCall(readMedian)} |`,
  `| cold read, min | ${usPerCall(minOf(readSamples))} |`,
  `| cold read, max | ${usPerCall(maxOf(readSamples))} |`,
  `| body row size (JSON) | ${kb(workspace.bodyBytes)} |`,
  `| store rows read per cold read | ${grouped(coldReads)} |`,
  `| store rows read by a warm re-read | ${grouped(warmReads)} |`,
  `| resident bodies after the sweep | ${grouped(bodiesResident)} |`,
  `| leases held by the sweep | ${grouped(bodyLeases.leased)} |`,
  `| inactive bodies waiting out their grace period | ${grouped(bodyLeases.inactive)} |`,
  `| held bodies (\`heldByModel\`) | ${grouped(stats.heldByModel[ON_DEMAND_TYPE] ?? 0)} |`,
  "",
);

// 6. Patched result changes
const rowsPerChange = (workload: ChangeWorkload): string =>
  Number.isInteger(workload.rowsExamined)
    ? grouped(workload.rowsExamined)
    : fixed(workload.rowsExamined, 1);
const beforeRows = rowsPerChange(changeWorkloads[0]!);
push(
  "## 6. Patched result changes (#942)",
  "",
  "A cached rows query over the same replica, driven through the shipped",
  "`createQueryCache` + `createSubscriptionRegistry`: a change that can only rewrite a",
  "projected value of a resident row is patched into the cached result, and everything",
  "else re-runs the plan. The source is local only because this benchmark has no client",
  "schema to lower a builder chain through; its `execute` is the shipped `executePlan`",
  "over the shipped replica executor, and its `patch` re-reads only the named rows.",
  "",
  "**Rows examined** is `traversalCounter.resultRowsRead`, the shipped counter the replica",
  "executor records into: a re-run adds every row its plan scan materialized, a patch adds",
  "the rows it re-read by id, and a row subscription adds the one row its consumer re-reads",
  "(the read `namespace.ts` performs on a change). **Re-runs** and **patches** count the",
  "source calls the cache made for each change. **Result work** is the median time inside that",
  "call — the plan's scan, order, and projection for a re-run, the one-row re-projection for a",
  `patch — over ${grouped(CHANGE_ITERATIONS)} single-row edits or ${grouped(RE_RUN_ITERATIONS)} re-running changes.`,
  "The replica's own write path is excluded: it costs",
  `${usPerCall(writePathMs)} per ingested action with or without a result watching.`,
  "",
  "| change | re-runs / change | patches / change | rows examined / change | result work (median) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...changeWorkloads.map(
    (workload) =>
      `| ${workload.label} | ${fixed(workload.runs / workload.changes, 2)} | ${fixed(
        workload.patches / workload.changes,
        2,
      )} | ${rowsPerChange(workload)} | ${usPerCall(workload.medianReadMs)} |`,
  ),
  "",
  `The same ${grouped(config.n)}-row result answers one projected-value edit two ways: ${beforeRows}`,
  "rows examined before #942, 1 after it. A membership change, a predicate field, an ordered",
  "result, and a row subscription all keep their one answer — re-run where the row's place can",
  "move, patch where it cannot — and the last row shows a row subscription is a one-row read,",
  "not a query.",
  "",
  "The membership workload's result grows by one row per change, so its row count is an average",
  `over ${grouped(RE_RUN_ITERATIONS)} changes, and the later rows scan the rows it added. The predicate`,
  `re-run reads the same ${grouped(config.n)}-row type but projects one matching row, so its result`,
  "work is smaller: the scan is the floor, not the projection.",
  "",
  `Splicing the patched row back into the ${grouped(config.n)}-row result adds ${usPerCall(spliceMs)}: a`,
  "patch keeps the id set and its order, so it rebuilds the result array rather than carrying a",
  "mutable one. That O(result) copy is the price of the fast path at this size, and it is still",
  `well under the read it replaces.`,
  "",
  "---",
  "",
  `_Harness runtime: ${fixed((performance.now() - harnessStart) / 1000, 1)} s from module start ` +
    `(fixture generation, ${HEAP_REPS} heap reps, ${LOAD_REPS} build reps, ${LATENCY_BATCHES} batches ` +
    `per timed read, one on-demand body sweep, ${changeWorkloads.length} change workloads)._`,
  "",
);

process.stdout.write(out.join("\n"));
