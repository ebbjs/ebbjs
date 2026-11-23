/**
 * Replica read-model benchmark at 10k documents (#503).
 *
 * Measures the shipped materialized replica (`@ebbjs/storage/replica`) against
 * the workspace shape from the epic #495 spike, so #503's numbers are
 * comparable with it: resident metadata footprint, traversal cost (wall-clock and
 * rows touched), search over resident pages, the one-pass projection build, the
 * store-backed body path, patched versus re-run changes, change dispatch, the
 * residency counters a remount and a batch expose, and the replica's retained
 * bytes split by memory category (#966).
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
import { createReplica, DEFAULT_JOURNAL_CAPACITY, jsonBytes } from "@ebbjs/storage/replica";
import type { Replica, ReplicaStats } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

import { fieldComponent, makeHlc } from "@ebbjs/core";
import { emptyQuery, type Query } from "../sync/query";
import { createChangeDispatcher } from "../sync/dependency-index";
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
  maxOf,
  median,
  minOf,
  measureInactiveResult,
  replicaAdjacency,
  replicaRowReader,
  sampleLatency,
  type CounterSnapshot,
  type LatencySample,
} from "./harness";
import {
  configFromEnv,
  createResidentRows,
  createWorkspace,
  BODY_TYPE,
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
/** How many warm re-reads one remount measurement averages over. */
const MOUNT_REMOUNTS = 100;
/** Dispatch fixture: subscriptions indexed, and the size of the batch they see. */
const DISPATCH_ROW_SUBSCRIPTIONS = 4_000;
const DISPATCH_QUERY_SUBSCRIPTIONS = 1_000;
const DISPATCH_CHANGES = 100;
/** The #495 spike's one-pass projection build at the same 10k shape. */
const SPIKE_PROJECTION_BUILD_MS = 37.0;

/** Stable Markdown number formatting: no locale-dependent grouping. */
const grouped = (value: number): string =>
  Number.isInteger(value)
    ? value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : value.toFixed(0);

const fixed = (value: number, digits: number): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "n/a";

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

const residentRows = workspace.record.entities;
const store = createCountingStore(workspace.rows);

// ---------------------------------------------------------------------------
// 1a. Footprint — JSON bytes of the resident rows (independent of V8)
// ---------------------------------------------------------------------------

const rowsOfModel = (type: string): readonly Entity[] =>
  residentRows.filter((entity) => entity.model === type);

const pageJson = jsonBytes(rowsOfModel("page"));
// Every platform row is an `ebb` row, so the component is what splits them out.
// A link is not one of them: it is a key of its source page.
const platformRows = residentRows.filter((entity) => entity.model === EBB_MODEL_NAME);
const groupJson = jsonBytes(
  platformRows.filter(
    (entity) => carriesComponent(entity, "membership") || carriesComponent(entity, "group"),
  ),
);
const metadataJson = pageJson + groupJson;
const bodyJson = workspace.bodyBytes * config.n;
const workspaceJson = metadataJson + bodyJson;

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
 * Paired heap accounts, every rep inside one measurement window: the resident rows
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
  // The workspace record carries the metadata rows only: since #943 a body is
  // the fixture's store's to serve, so a body read is observable as a store
  // read. `rows` is built from the same `residentRowSet` as the record's
  // metadata, so the guard below is one-directional (`>`): a row builder that
  // grows past the record's set is drift, while the record carrying extra rows
  // is not.
  const recordFor = (rows: readonly Entity[]): Workspace["record"] => ({
    ...seed,
    entities: rows,
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
  const warmRows = createResidentRows(config);
  const warmRecord = recordFor(warmRows);
  const warmBaseMap = mapOf(warmRows);
  const warmReplica = createReplica(options);
  warmReplica.load(warmRecord);
  heapAfterGc(force);

  for (let rep = 0; rep < HEAP_REPS; rep += 1) {
    const base = heapAfterGc(force);
    const rows = createResidentRows(config);
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
      rows.length > seed.entities.length ||
      baseMap.size !== rows.length ||
      probe.stats().entities !== rows.length
    ) {
      throw new Error("heap account: built object is not the resident row set");
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
    throw new Error("heap account: warm-up is not the resident row set");
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
const indexShape = summariseIndexKeys(residentRows);

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
if (stats.entities !== workspace.counts.residentRows) {
  throw new Error(
    `self-check: replica holds ${stats.entities} rows, fixture generates ${workspace.counts.residentRows}`,
  );
}
if (stats.byModel[BODY_TYPE] !== undefined || replica.get(workspace.bodyIds[0]) !== undefined) {
  throw new Error("self-check: a store-backed body is resident after load");
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
// 3. Search over resident pages
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

log("timing search over resident pages");
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
if (primaryBody === undefined) throw new Error("fixture produced no store-backed bodies");
const bodyComponents = [`${BODY_TYPE}/content`];

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
  if (loaded === null) throw new Error(`store-backed body self-check: ${id} did not read`);
}
const readMedian = median(readSamples);

// The warm path: a read inside the grace period installs nothing and reads
// nothing, which is what a remount costs.
store.reset();
await replica.read(primaryBody, bodyComponents);
const warmReads = store.snapshot().calls;

// A remount is the same read again after the projection released its claim;
// the inactive lease is what makes it free. Count the store reads over several
// remounts rather than reading one sample as a rate.
store.reset();
for (let remount = 0; remount < MOUNT_REMOUNTS; remount += 1) {
  const loaded = await replica.read(primaryBody, bodyComponents);
  if (loaded === null) throw new Error("remount self-check: the warm body did not read");
}
const remountReads = store.snapshot().calls / MOUNT_REMOUNTS;

// A mounted row subscription holds the same value under a live lease. The
// registry is the shipped one; the test is whether a live claim is visible.
const mounted = createSubscriptionRegistry(replica);
const mountedBody = mounted.open({ kind: "row", row: primaryBody, components: bodyComponents });
const mountedLeases = replica.stats().leases;
mountedBody.release();
mounted.close();

// Let the released claims age a little so the oldest-inactive counter has a
// non-zero age to report.
await new Promise((resolve) => setTimeout(resolve, 20));
const bodiesResident = replica.stats().byModel[BODY_TYPE] ?? 0;
const bodyLeases = replica.stats().leases;
if (coldReads !== 1) {
  throw new Error(`store-backed body self-check: cold read touched ${coldReads} store rows`);
}
if (warmReads !== 0) {
  throw new Error(`store-backed body self-check: a warm read touched ${warmReads} store rows`);
}
if (bodiesResident < bodySample.length) {
  throw new Error(
    `store-backed body self-check: ${bodiesResident} of ${bodySample.length} bodies stayed resident`,
  );
}
if (bodyLeases.leased !== 0) {
  throw new Error(`store-backed body self-check: ${bodyLeases.leased} leases outlived their read`);
}
if (remountReads !== 0) {
  throw new Error(`store-backed body self-check: a remount read ${remountReads} store rows`);
}
if (mountedLeases.leased < 1) {
  throw new Error("store-backed body self-check: a mounted subscription held no lease");
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
 * the cache made, one per change at most. A row subscription has no patch path:
 * its one row read per change is counted as a re-read, not a patch.
 */
interface ChangeWorkload {
  readonly label: string;
  readonly changes: number;
  readonly runs: number;
  readonly patches: number;
  /** Row re-reads for a workload that has no patch path, such as a row subscription. */
  readonly reReads: number;
  /** How the per-change read is labelled: a patch, or a re-read of the one row. */
  readonly perChange: "patch" | "re-read";
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
    reReads: 0,
    perChange: "patch",
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
    label:
      "row subscription — projected `title` edit on the subscribed row (one row re-read, no patch)",
    changes,
    runs: 0,
    patches: 0,
    reReads: reads,
    perChange: "re-read",
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
// 1c. Production shape: a folded body is resident and lease-free (#943, #957)
// ---------------------------------------------------------------------------

/**
 * The fixture keeps bodies in the store so sections 2 and 5 can measure the
 * store-backed read. A synced body does not stay there: the log folds it whole
 * and nothing reclaims it. Load the fixture's own body rows into a throwaway
 * replica and measure the retention, so the footprint above is not read as
 * production memory.
 */
const measureFoldedBodies = (): { readonly rows: number; readonly bytes: number } => {
  const bodyRows = [...workspace.rows.values()].filter((entity) => entity.model === BODY_TYPE);
  if (bodyRows.length === 0) throw new Error("folded-body measurement: no body rows");
  const folded = createReplica(loadOptions);
  folded.load({ ...workspace.record, entities: [...workspace.record.entities, ...bodyRows] });
  const stats = folded.stats();
  const rows = stats.byModel[BODY_TYPE] ?? 0;
  if (rows !== bodyRows.length) {
    throw new Error(
      `folded-body measurement: ${rows} of ${bodyRows.length} bodies stayed resident`,
    );
  }
  if (stats.leases.leased !== 0 || stats.leases.inactive !== 0) {
    throw new Error("folded-body measurement: a folded row was lease-owned");
  }
  return { rows, bytes: jsonBytes(bodyRows) };
};

const foldedBodies = measureFoldedBodies();

// ---------------------------------------------------------------------------
// 7. Change dispatch (#938)
// ---------------------------------------------------------------------------

/**
 * The shipped dispatcher over the benchmark replica, with subscriptions
 * registered the way the registry registers them: row watchers on distinct
 * rows, and query readers on one component. One Action delivers a batch of
 * changes; the dispatcher's own counters say what finding the touched entries
 * cost, and the scan work those indices replace.
 */
const measureDispatch = (): {
  readonly subscriptions: number;
  readonly changes: number;
  readonly touched: number;
  readonly lookups: number;
  readonly scanWork: number;
} => {
  const rowSubscriptions = Math.min(DISPATCH_ROW_SUBSCRIPTIONS, config.n);
  const changes = Math.min(DISPATCH_CHANGES, config.n);
  const dispatcher = createChangeDispatcher<{ readonly id: number }>({
    journal: replica,
    indices: {},
    onChange: () => {},
  });
  for (let index = 0; index < rowSubscriptions; index += 1) {
    dispatcher.add({ id: index }, { rows: [pageId(index)] });
  }
  for (let index = 0; index < DISPATCH_QUERY_SUBSCRIPTIONS; index += 1) {
    dispatcher.add(
      { id: rowSubscriptions + index },
      { components: ["page/title"], sources: ["page"] },
    );
  }
  const updates = Array.from({ length: changes }, (_, index) => {
    benchPosition += 1;
    const updateId = `u_dispatch_${benchPosition}`;
    return {
      id: updateId,
      subject_id: pageId(index),
      component: "page/title" as const,
      method: "replace" as const,
      data: { value: `Dispatch ${index}`, update_id: updateId, hlc: makeHlc(benchPosition) },
    };
  });
  benchPosition += 1;
  replica.ingest(
    {
      id: `a_dispatch_${benchPosition}`,
      actor_id: "bench",
      hlc: makeHlc(benchPosition),
      gsn: benchPosition,
      updates: [],
    },
    updates,
    benchPosition,
  );
  const stats = dispatcher.stats();
  const subscriptions = dispatcher.size();
  dispatcher.close();
  return {
    subscriptions,
    changes,
    touched: stats.touched,
    lookups: stats.lookups,
    scanWork: stats.scanWork,
  };
};

const dispatch = measureDispatch();

// ---------------------------------------------------------------------------
// 8. Memory by category (#966)
// ---------------------------------------------------------------------------

/** Unconfirmed writes the overlay scenario holds: one title edit per page. */
const BYTES_OPTIMISTIC_ACTIONS = 100;

interface MemoryCategories {
  /** The loaded replica, before any write. */
  readonly loaded: { readonly rows: number; readonly values: number; readonly index: number };
  /** The journal at its retained capacity, after the ingest and overlay batches. */
  readonly journal: number;
  readonly journalChanges: number;
  /** Overlay writes, their composed views, and orphans after the optimistic batch. */
  readonly unconfirmedWrites: number;
  readonly unconfirmedActions: number;
  /** A released rows result, still inside its residency period. */
  readonly inactiveResults: number;
  readonly inactiveEntries: number;
  readonly inactiveRows: number;
  /** The full-row `ReplicaRecord` `toRecord()` serializes. */
  readonly snapshot: number;
}

/**
 * The replica's account covers the state it owns; an inactive result and the
 * snapshot it can write belong to the client around it, so they are measured
 * here. One scratch replica keeps all seven figures on the same loaded
 * workspace and leaves the timed replica untouched.
 */
const measureMemoryCategories = (): MemoryCategories => {
  const scratch = createReplica(loadOptions);
  scratch.load(workspace.record);

  const founded = scratch.bytes();
  const loaded = { rows: founded.rows, values: founded.values, index: founded.index };
  if (founded.journal !== 0 || founded.unconfirmedWrites !== 0) {
    throw new Error("memory categories: a loaded replica already retained writes");
  }
  const snapshot = jsonBytes(scratch.toRecord());

  // Fill the default journal window with real changes: one title edit per
  // Action. This is what makes the journal category non-zero.
  let position = 0;
  for (let index = 0; index < DEFAULT_JOURNAL_CAPACITY; index += 1) {
    position += 1;
    const id = pageId(index % Math.max(1, config.n));
    scratch.ingest(
      {
        id: `a_memory_${position}`,
        actor_id: "bench",
        hlc: makeHlc(position),
        gsn: position,
        updates: [],
      },
      [
        {
          id: `u_memory_${position}`,
          subject_id: id,
          component: "page/title",
          method: "replace",
          data: {
            value: `Memory ${position}`,
            update_id: `u_memory_${position}`,
            hlc: makeHlc(position),
          },
        },
      ],
      position,
    );
  }
  const afterIngests = scratch.bytes();
  if (afterIngests.journal === 0) {
    throw new Error("memory categories: the journal retained nothing");
  }

  // One unconfirmed write per page; each also caches a composed view.
  for (let index = 0; index < BYTES_OPTIMISTIC_ACTIONS; index += 1) {
    position += 1;
    scratch.optimistic({
      id: `a_local_${position}`,
      actor_id: "bench",
      hlc: makeHlc(position),
      gsn: position,
      updates: [
        {
          id: `u_local_${position}`,
          subject_id: pageId(index % Math.max(1, config.n)),
          component: "page/title",
          method: "replace",
          data: {
            value: `Local ${position}`,
            update_id: `u_local_${position}`,
            hlc: makeHlc(position),
          },
        },
      ],
    });
  }
  const afterOverlay = scratch.bytes();
  if (afterOverlay.unconfirmedWrites === 0) {
    throw new Error("memory categories: the optimistic batch retained nothing");
  }
  const journalChanges = scratch.stats().changes;
  if (journalChanges === 0 || journalChanges > DEFAULT_JOURNAL_CAPACITY) {
    throw new Error(`memory categories: ${journalChanges} journal changes retained`);
  }

  const pagePlan = planQuery(emptyQuery("page"));
  const measuredPages = scratch.stats().byModel["page"] ?? 0;
  const inactive = measureInactiveResult(scratch, emptyQuery("page"), () =>
    executePlan(pagePlan, createReplicaExecutor(scratch)).map(pageResult),
  );
  if (inactive.entries !== 1) {
    throw new Error(`memory categories: ${inactive.entries} inactive results, expected 1`);
  }
  if (inactive.rows !== measuredPages) {
    throw new Error(
      `memory categories: the inactive result held ${inactive.rows} of ${measuredPages} rows`,
    );
  }

  return {
    loaded,
    // The optimistic batch trims the oldest journal entries, so the reported
    // window is the final state's, not the pre-overlay one.
    journal: afterOverlay.journal,
    journalChanges,
    unconfirmedWrites: afterOverlay.unconfirmedWrites,
    unconfirmedActions: BYTES_OPTIMISTIC_ACTIONS,
    inactiveResults: inactive.bytes,
    inactiveEntries: inactive.entries,
    inactiveRows: inactive.rows,
    snapshot,
  };
};

log("measuring memory by category");
const memory = measureMemoryCategories();
const loadedBytes = memory.loaded.rows + memory.loaded.values + memory.loaded.index;
const steadyBytes =
  loadedBytes + memory.journal + memory.unconfirmedWrites + memory.inactiveResults;
// The two base categories partition each loaded row's JSON apart from the
// 8-byte `,"data":` separator they share. Recount per row: section 1a's totals
// serialize arrays, whose commas and brackets a row sum does not carry.
const splitJson = memory.loaded.rows + memory.loaded.values;
const expectedSplit =
  residentRows.reduce((sum, row) => sum + jsonBytes(row), 0) - 8 * residentRows.length;
if (splitJson !== expectedSplit) {
  throw new Error(
    `memory categories: rows + values is ${splitJson} bytes, expected ${expectedSplit}`,
  );
}

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
  ["**resident metadata subtotal**", workspace.counts.residentRows, metadataJson],
  [
    `\`${BODY_TYPE}\` bodies (representative row × ${grouped(config.n)}, store-backed)`,
    config.n,
    bodyJson,
  ],
  ["**full workspace (hypothetical)**", workspace.counts.residentRows + config.n, workspaceJson],
];

push("## 1. Resident metadata footprint", "", "### JSON bytes (uncompressed)", "");
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
  `The record carries the metadata rows only: a \`${BODY_TYPE}\` row is the store's, and`,
  "`replica.read` installs it under a lease. That split is this fixture's, not the shape",
  "production produces: a synced body folds whole and is resident (#943), and no claim owns it,",
  "so nothing reclaims it today (#957). Loading the fixture's own body rows into a fresh replica",
  `leaves **${grouped(foldedBodies.rows)} body rows resident (${mb(foldedBodies.bytes)} JSON)**`,
  `with **0 leases and 0 inactive claims**; the metadata totals above therefore understate a`,
  "real client's memory. #957 measured 500 bodies × 64 KiB ≈ 63.4 MiB retained with every",
  "subscription ended.",
  "The totals run ~14% above the #495 spike's 15.1 MB for the same 50,000 rows because every",
  "field here carries a per-field `update_id` of realistic length (`u_page_1234_title`, ~20–22",
  "chars, close to a 21-char nanoid) where the spike used short `u_${n}` placeholders, so the",
  "row bytes are not a like-for-like comparison with the spike.",
  "",
);

// Per-component attribution of the resident bytes: a row's value bytes are
// readable per component rather than only per row.
const componentBytes = new Map<string, { rows: number; bytes: number }>();
for (const row of residentRows) {
  for (const [field, value] of Object.entries(row.data.fields)) {
    const component = fieldComponent(row.model, field);
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
  "Every component of every resident row, attributed by its value bytes. This",
  "residency view: the row-level buckets above are models, these are the units the replica keeps",
  "or leaves to the store.",
  "",
  "| component | rows carrying | JSON bytes | size | % of resident components |",
  "| --- | ---: | ---: | ---: | ---: |",
);
for (const [component, bucket] of componentRows) {
  push(
    `| \`${component}\` | ${grouped(bucket.rows)} | ${bytes(bucket.bytes)} | ${mb(bucket.bytes)} | ${pct(bucket.bytes, componentSubtotal)} |`,
  );
}
push(
  `| **resident components subtotal** | — | ${bytes(componentSubtotal)} | ${mb(componentSubtotal)} | 100.0% |`,
  "",
);

push("### Heap bytes the replica retains (V8)", "");
push(
  "Each rep runs in one measurement window, sampling `heapUsed` after two forced GCs at every",
  "step: the resident rows allocated fresh (their own row objects, not the workspace's), then one",
  "`Map<id, row>` over exactly those rows, then a replica `load`ed over the same rows — so",
  "**adjacency indices + model index = replica structures − base map** and **resident metadata",
  "total = resident rows + replica structures**, with the base map kept as the subtraction baseline",
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
    `| resident rows (fresh row objects + the record's reference array) | ${mb(median(rowsAccount))} | ${mb(minOf(rowsAccount))} | ${mb(maxOf(rowsAccount))} | ${HEAP_REPS} | — |`,
    `| base map (\`Map<id, row>\` over the same rows — reference cost, not in the total) | ${mb(median(baseMapAccount))} | ${mb(minOf(baseMapAccount))} | ${mb(maxOf(baseMapAccount))} | ${HEAP_REPS} | — |`,
    `| replica structures (its own base map + model index + both adjacency indices) | ${mb(median(replicaAccount))} | ${mb(minOf(replicaAccount))} | ${mb(maxOf(replicaAccount))} | ${HEAP_REPS} | — |`,
    `| **adjacency indices + model index (replica structures − base map)** | **${mb(median(indicesAccount))}** | ${mb(minOf(indicesAccount))} | ${mb(maxOf(indicesAccount))} | ${HEAP_REPS} | — |`,
    `| **resident metadata total (resident rows + replica structures)** | **${mb(median(totals))}** | ${mb(minOf(totals))} | ${mb(maxOf(totals))} | ${HEAP_REPS} | **${fullWorkspaceShare}** |`,
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
  "## 3. Search over resident pages",
  "",
  "No search surface ships yet. The substring scan is the shape a search would ride on today",
  '(`replica.iterate("page")` plus a title filter), not a shipped feature. The two',
  "`executePlan` rows are the shipped query path with a filter and as a whole-type scan; the",
  "whole-type scan also orders by id, which is an O(n log n) `localeCompare` sort.",
  "",
  `Each visits all ${grouped(pageRowsHeld)} resident \`page\` rows. Median per call over ${LATENCY_BATCHES} batches of ${SEARCH_CALLS_PER_BATCH} calls.`,
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
  `${usPerCall(loadMedian / Math.max(1, stats.entities))} per resident row and ${fixed(
    (loadMedian / Math.max(1, indexShape.reverseRows + indexShape.forwardRows)) * 1000,
    3,
  )} µs per index entry — the repeat-load median divided by the`,
  `${grouped(stats.entities)} resident rows and by the ${grouped(
    indexShape.reverseRows + indexShape.forwardRows,
  )} reverse+forward index rows above.`,
  "The build is a measurement, not a gate.",
  "",
);

// 5. Leased bodies
push(
  "## 5. Leased bodies",
  "",
  `\`${BODY_TYPE}\` is the store-backed type: the record does not carry it, so`,
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
  `| store rows read per remount (mean over ${MOUNT_REMOUNTS}) | ${fixed(remountReads, 2)} |`,
  `| resident bodies after the sweep | ${grouped(bodiesResident)} |`,
  `| lease count after the sweep (leased + inactive) | ${grouped(bodyLeases.leased + bodyLeases.inactive)} |`,
  `| leases held by a mounted row subscription | ${grouped(mountedLeases.leased)} |`,
  `| claims waiting out their grace period | ${grouped(bodyLeases.inactive)} |`,
  `| oldest inactive age | ${ms(bodyLeases.oldestInactiveMs)} |`,
  "",
);

// 6. Patched result changes
const rowsPerChange = (workload: ChangeWorkload): string =>
  Number.isInteger(workload.rowsExamined)
    ? grouped(workload.rowsExamined)
    : fixed(workload.rowsExamined, 1);
/** A patch or re-read count, labelled so a row subscription does not read as a patch. */
const readCell = (workload: ChangeWorkload): string =>
  workload.perChange === "re-read"
    ? `${fixed(workload.reReads / workload.changes, 2)} re-reads`
    : fixed(workload.patches / workload.changes, 2);

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
  'source calls the cache made for each change; the row subscription\'s "re-reads" are its',
  "consumer's one-row `get`, which is not a patch. **Result work** is the median time inside that",
  "call — the plan's scan, order, and projection for a re-run, the one-row re-projection for a",
  `patch — over ${grouped(CHANGE_ITERATIONS)} single-row edits or ${grouped(RE_RUN_ITERATIONS)} re-running changes.`,
  "The replica's own write path is excluded: it costs",
  `${usPerCall(writePathMs)} per ingested action with or without a result watching.`,
  "",
  "| change | re-runs / change | patches / change | rows examined / change | result work (median) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...changeWorkloads.map(
    (workload) =>
      `| ${workload.label} | ${fixed(workload.runs / workload.changes, 2)} | ${readCell(
        workload,
      )} | ${rowsPerChange(workload)} | ${usPerCall(workload.medianReadMs)} |`,
  ),
  "",
  `The same ${grouped(config.n)}-row result answers one projected-value edit two ways: ${beforeRows}`,
  "rows examined before #942, 1 after it. A membership change, a predicate field, an ordered",
  "result, and a row subscription all keep their one answer — re-run where the row's place can",
  "move, patch where it cannot — and the last row shows a row subscription is a one-row read,",
  "not a query: its `1.00 re-reads` is the pre-existing one-row `get`, not a new fast path.",
  "",
  "The `patches / change` of the patch rows is the cache dispatcher's rate for a source whose",
  "projection is always resident. It is not unconditional for the shipped chain: an unselected",
  "`client.<model>.query()` read expands `<model>/*` to every registered component and the",
  "patch declines a row it cannot prove holds one of them, so a projected component the row",
  "does not carry turns each projected write on that row into a re-run. `patch-rate.test.ts`",
  "measures the shipped path at 200 pages: 40/40 projected writes patch when every projected",
  "component is resident, 4/40 at 10% optional-component presence, and 0/40 when the component",
  "is absent. The rate tracks that component's presence; read the patch rows above as the best",
  "case, not the typical one.",
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
);

// 7. Change dispatch
push(
  "## 7. Change dispatch (#938)",
  "",
  "The shipped `createChangeDispatcher` over the benchmark replica, with the dependencies the",
  "registry declares: row subscriptions watching one row each, and query subscriptions reading",
  "`page/title` over the `page` row set. One Action delivers the whole batch, so the counters are",
  "per batch, not per notification. **Subscriptions touched** is the entries any work happens",
  "for; **index lookups** counts only the dependency lookups; **scan work** is the",
  "changes × subscriptions pairs a scan of every entry would have examined.",
  "",
  "| measure | value |",
  "| --- | ---: |",
  `| subscriptions indexed | ${grouped(dispatch.subscriptions)} (${grouped(dispatch.subscriptions - DISPATCH_QUERY_SUBSCRIPTIONS)} row, ${grouped(DISPATCH_QUERY_SUBSCRIPTIONS)} query) |`,
  `| changes in the batch | ${grouped(dispatch.changes)} |`,
  `| subscriptions touched / batch | ${grouped(dispatch.touched)} |`,
  `| subscriptions touched / change | ${fixed(dispatch.touched / dispatch.changes, 2)} |`,
  `| index lookups / batch | ${grouped(dispatch.lookups)} |`,
  `| scan work avoided (changes × subscriptions) | ${grouped(dispatch.scanWork)} |`,
  "",
);

// 8. Memory by category
const memoryRows: readonly (readonly [string, number, string])[] = [
  [
    "rows — row envelopes (id, model, existence, timestamps, `last_gsn`)",
    memory.loaded.rows,
    `${grouped(workspace.counts.residentRows)} loaded rows`,
  ],
  [
    "in-memory values — every component value with its `update_id`/`hlc` envelope",
    memory.loaded.values,
    "the same rows",
  ],
  [
    "index — model, component, and adjacency indices, plus version stamps",
    memory.loaded.index,
    "built by the load",
  ],
  [
    "journal — retained change entries",
    memory.journal,
    `${grouped(memory.journalChanges)} retained at the default capacity, after ${grouped(
      DEFAULT_JOURNAL_CAPACITY + BYTES_OPTIMISTIC_ACTIONS,
    )} changes`,
  ],
  [
    "unconfirmed writes — overlay, its composed views, and orphans",
    memory.unconfirmedWrites,
    `${grouped(memory.unconfirmedActions)} optimistic Actions the server has not echoed`,
  ],
  [
    "inactive results — a released result's projected rows",
    memory.inactiveResults,
    `${grouped(memory.inactiveEntries)} entry holding ${grouped(memory.inactiveRows)} projected rows`,
  ],
  [
    "snapshot — the full-row `ReplicaRecord` `toRecord()` serializes",
    memory.snapshot,
    "the loaded base, versions included",
  ],
];

push(
  "## 8. Memory by category (#966)",
  "",
  "The replica's account covers what it owns; an inactive query result and the snapshot it can",
  "write belong to the client around it, so all seven are measured here. UTF-8 bytes of JSON,",
  "one throwaway replica loaded from the fixture's record, so every figure describes the same",
  "workspace. This is a category account, not a heap measurement (section 1b is the heap",
  "account): the units compare with section 1a's row JSON and with each other, not with the V8",
  "total.",
  "",
  "| category | bytes | size | measured on |",
  "| --- | ---: | ---: | --- |",
  ...memoryRows.map(
    ([label, value, scope]) => `| ${label} | ${bytes(value)} | ${mb(value)} | ${scope} |`,
  ),
  "",
  "| total | bytes | size |",
  "| --- | ---: | ---: |",
  `| **loaded replica** (rows + in-memory values + index) | **${bytes(loadedBytes)}** | **${mb(loadedBytes)}** |`,
  `| **steady state** (loaded replica + journal + unconfirmed writes + inactive result) | **${bytes(steadyBytes)}** | **${mb(steadyBytes)}** |`,
  `| snapshot written on top (not resident unless persisting) | ${bytes(memory.snapshot)} | ${mb(memory.snapshot)} |`,
  "",
  '`rows + values` partitions each resident row\'s JSON apart from the 8-byte `,"data":`',
  "separator the two share; section 1a's model buckets serialize arrays, whose punctuation a",
  "per-row sum does not carry. The split attributes row identity separately from values; the",
  "heap total in 1b is a different unit, not their sum. The index figure is the derived",
  "structures only — the model,",
  "component, and adjacency maps and the version stamps — which section 1b sees as heap bytes",
  "on top of its base map. The journal is one array at its default capacity; the overlay holds",
  "the composed view of every row an optimistic write touched, which is the cost the",
  "unconfirmed-writes line adds to the base. The snapshot is the whole base written out again",
  "for persistence (#977 replaces it with a row list), so it is the one line that must not be",
  "added to a resident total.",
  "",
  "---",
  "",
  `_Harness runtime: ${fixed((performance.now() - harnessStart) / 1000, 1)} s from module start ` +
    `(fixture generation, ${HEAP_REPS} heap reps, ${LOAD_REPS} build reps, ${LATENCY_BATCHES} batches ` +
    `per timed read, one store-backed body sweep, ${changeWorkloads.length} change workloads, ` +
    `one memory-category replica)._`,
  "",
);

process.stdout.write(out.join("\n"));
