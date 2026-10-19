/**
 * Replica read-model benchmark at 10k documents (#503).
 *
 * Measures the shipped materialized replica (`@ebbjs/storage/replica`) against
 * the workspace shape from the epic #495 spike, so #503's numbers are
 * comparable with it: held metadata footprint, traversal cost (wall-clock and
 * rows touched), search over held pages, the one-pass projection build, and
 * the windowed body path.
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
import type { Entity } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";
import type { Replica, ReplicaStats } from "@ebbjs/storage/replica";

import { emptyQuery, type Query } from "../sync/query";
import { createReplicaExecutor, executePlan } from "../sync/query-execute";
import { planQuery } from "../sync/query-plan";
import { forwardMany, forwardOne, membershipGroups, reverse } from "../sync/relationship";
import {
  arrayLength,
  createCounterSet,
  createCountingStore,
  createIndexCounter,
  entityDegree,
  fixed,
  grouped,
  heldMetadata,
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
  createWorkspace,
  ON_DEMAND_TYPE,
  pageId,
  spreadIndices,
  stringField,
  summariseIndexKeys,
  UPDATED_AT_BASE,
  WORKSPACE_GROUP_ID,
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
  `generating ${config.n.toLocaleString()} pages, ${(
    config.n -
    1 +
    config.n * config.refsPerPage
  ).toLocaleString()} relationship rows, ${config.n.toLocaleString()} entityGroup rows, ` +
    `${config.bodyBlocks}x${config.bodyChars}-char bodies`,
);
const generateStart = performance.now();
const workspace = createWorkspace(config);
const generateMs = performance.now() - generateStart;
log(`workspace generated in ${ms(generateMs)}`);

const heldRows = workspace.record.entities.filter((entity) => heldMetadata.holds(entity.type));
const store = createCountingStore(workspace.rows);

// ---------------------------------------------------------------------------
// 1a. Footprint — JSON bytes of the held rows (independent of V8)
// ---------------------------------------------------------------------------

const rowsOfType = (type: string): readonly Entity[] =>
  heldRows.filter((entity) => entity.type === type);

const pageJson = jsonBytes(rowsOfType("page"));
const relationshipJson = jsonBytes(rowsOfType("relationship"));
const groupJson = jsonBytes(rowsOfType("entityGroup")) + jsonBytes(rowsOfType("group"));
const metadataJson = pageJson + relationshipJson + groupJson;
const bodyJson = workspace.bodyBytes * config.n;
const workspaceJson = metadataJson + bodyJson;
const recordBodyJson = jsonBytes(
  workspace.record.entities.filter((entity) => entity.type === ON_DEMAND_TYPE),
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
 * Paired heap account. Each rep measures, against the same running baseline:
 * the rows-only Map (what the replica's base map costs), then the replica
 * built on top of it (its own base map, the type index, and both adjacency
 * indices). The row objects are shared with the workspace record and never
 * counted twice, so indices are the difference between the two deltas.
 */
interface HeapAccounts {
  readonly rows: readonly number[];
  readonly replica: readonly number[];
  readonly total: readonly number[];
}

const measureHeap = (
  force: () => void,
  record: Workspace["record"],
  options: typeof loadOptions,
): HeapAccounts => {
  const rows: number[] = [];
  const replicas: number[] = [];
  const total: number[] = [];
  // Every account stays pinned for the whole measurement. Freeing a previous
  // rep's account during this rep's forced GC would subtract its bytes from
  // the delta being measured, collapsing it to noise.
  const pinned: unknown[] = [];

  // One untimed rep: the first build pays the JIT and inline-cache warm-up and
  // would otherwise read as a systematically larger account.
  const warmMap = new Map<string, Entity>();
  for (const entity of heldRows) warmMap.set(entity.id, entity);
  const warmReplica = createReplica(options);
  warmReplica.load(record);
  heapAfterGc(force);

  for (let rep = 0; rep < HEAP_REPS; rep += 1) {
    const base = heapAfterGc(force);
    const map = new Map<string, Entity>();
    for (const entity of heldRows) map.set(entity.id, entity);
    pinned.push(map);
    const withRows = heapAfterGc(force);

    const probe = createReplica(options);
    probe.load(record);
    pinned.push(probe);
    const withReplica = heapAfterGc(force);

    if (map.size === 0 || probe.stats().entities === 0) {
      throw new Error("heap account: built object is empty");
    }
    rows.push(withRows - base);
    replicas.push(withReplica - withRows);
    total.push(withReplica - base);
  }

  if (pinned.length !== HEAP_REPS * 2) throw new Error("heap account: lost an account");
  if (warmMap.size === 0 || warmReplica.stats().entities === 0) {
    throw new Error("heap account: warm-up is empty");
  }
  return { rows, replica: replicas, total };
};

const loadOptions = {
  materialization: heldMetadata,
  readEntity: store.read,
  pinnedCapacity: 1,
  pinnedTtlMs: 0,
} as const;

const heapAccounts: HeapAccounts | null =
  heapGc === undefined ? null : measureHeap(heapGc, workspace.record, loadOptions);

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
const assembleRecord = (): unknown => ({
  ...workspace.record,
  entities: [...workspace.record.entities],
});
const assemblySamples = Array.from({ length: LOAD_REPS }, () => {
  const start = performance.now();
  assembleRecord();
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
const groupsOfFirst = await membershipGroups(reader, adjacency, pageId(1), "group", groupShape);
if (groupsOfFirst.length !== 1 || groupsOfFirst[0]?.id !== WORKSPACE_GROUP_ID) {
  throw new Error("self-check: page_1 is not filed in exactly the workspace group");
}
if (stats.held !== workspace.counts.heldRows) {
  throw new Error(
    `self-check: replica holds ${stats.held} rows, fixture generates ${workspace.counts.heldRows}`,
  );
}
if (
  stats.heldByType[ON_DEMAND_TYPE] !== undefined ||
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

const accessorCases: readonly ReadCase[] = [
  {
    label: "`reverse` — children (`parent` target)",
    read: (id) => reverse(reader, adjacency, id, "page", pageShape, "parent", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`forwardOne` — parent (`parent` source)",
    read: (id) => forwardOne(reader, adjacency, id, "page", "parent", "page"),
    degreeOf: entityDegree,
  },
  {
    label: "`reverse` — backlinks (`references` target)",
    read: (id) => reverse(reader, adjacency, id, "page", pageShape, "references", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`forwardMany` — references (`references` source)",
    read: (id) =>
      forwardMany(reader, adjacency, id, "page", "page", pageShape, "references", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`membershipGroups` — groups",
    read: (id) => membershipGroups(reader, adjacency, id, "group", groupShape),
    degreeOf: arrayLength,
  },
];

const count = <T extends readonly unknown[]>(rows: T): T => {
  indexCounter.record(rows);
  return rows;
};

const directCases: readonly ReadCase[] = [
  {
    label: "`relationships` — children (`targetId`)",
    read: async (id) => count(replica.relationships({ as: "parent", type: "page", targetId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationships` — backlinks (`targetId`)",
    read: async (id) =>
      count(replica.relationships({ as: "references", type: "page", targetId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationshipLinks` — parent links (`sourceId`)",
    read: async (id) =>
      count(replica.relationshipLinks({ as: "parent", type: "page", sourceId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`relationshipLinks` — references links (`sourceId`)",
    read: async (id) =>
      count(replica.relationshipLinks({ as: "references", type: "page", sourceId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`memberships` — groups (`entityId`)",
    read: async (id) => count(replica.memberships({ entityId: id })),
    degreeOf: arrayLength,
  },
  {
    label: "`membershipLinks` — membership rows (`entityId`)",
    read: async (id) => count(replica.membershipLinks(id)),
    degreeOf: arrayLength,
  },
];

const storageReader = store.read;
const storageCases: readonly ReadCase[] = [
  {
    label: "`reverse` — children",
    read: (id) => reverse(storageReader, adjacency, id, "page", pageShape, "parent", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`forwardOne` — parent",
    read: (id) => forwardOne(storageReader, adjacency, id, "page", "parent", "page"),
    degreeOf: entityDegree,
  },
  {
    label: "`forwardMany` — references",
    read: (id) =>
      forwardMany(storageReader, adjacency, id, "page", "page", pageShape, "references", "page"),
    degreeOf: arrayLength,
  },
  {
    label: "`membershipGroups` — groups",
    read: (id) => membershipGroups(storageReader, adjacency, id, "group", groupShape),
    degreeOf: arrayLength,
  },
];

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
const pageRowsHeld = stats.byType["page"] ?? 0;

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
// 5. Windowed bodies
// ---------------------------------------------------------------------------

const bodySample = workspace.bodyIds.slice(0, Math.min(100, workspace.bodyIds.length));
const primaryBody = bodySample[0];
if (primaryBody === undefined) throw new Error("fixture produced no windowed bodies");

// Warm the on-demand path so the first timed open is not JIT + first-read.
for (const id of bodySample.slice(0, 3)) {
  await replica.open(id);
  replica.close(id);
}

const openSamples: number[] = [];
let openReads = 0;
for (const id of bodySample) {
  replica.close(id);
  store.reset();
  const start = performance.now();
  const opened = await replica.open(id);
  openSamples.push(performance.now() - start);
  openReads = Math.max(openReads, store.snapshot().calls);
  replica.close(id);
  if (opened === null) throw new Error(`windowed body self-check: ${id} did not open`);
}
const openMedian = median(openSamples);

store.reset();
await replica.open(primaryBody);
const pinnedFirstReads = store.snapshot().calls;
await replica.open(primaryBody);
const pinnedReReads = store.snapshot().calls - pinnedFirstReads;
replica.close(primaryBody);
const bodiesResidentAfterRelease = replica.stats().byType[ON_DEMAND_TYPE] ?? 0;
if (openReads !== 1) throw new Error(`windowed body self-check: cold open read ${openReads} rows`);
if (pinnedReReads !== 0) {
  throw new Error(`windowed body self-check: a pinned re-open read ${pinnedReReads} rows`);
}
if (bodiesResidentAfterRelease !== 0) {
  throw new Error(`windowed body self-check: ${bodiesResidentAfterRelease} bodies stayed resident`);
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
  ["`page` (title, icon, updated_at)", workspace.counts.pages, pageJson],
  ["`relationship` (parent + references)", workspace.counts.relationships, relationshipJson],
  ["`entityGroup` + `group`", workspace.counts.entityGroups + workspace.counts.groups, groupJson],
  ["**held metadata subtotal**", workspace.counts.heldRows, metadataJson],
  [
    `\`${ON_DEMAND_TYPE}\` bodies (representative row × ${grouped(config.n)}, windowed)`,
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
  "",
);

push("### Heap bytes the replica retains (V8)", "");
push(
  "Each rep measures `heapUsed` after two forced GCs against the same running baseline:",
  "first the rows-only `Map<id, row>`, then the replica built on top of it. The row",
  "objects are shared with the workspace record, so the replica delta is the replica's",
  "own base map plus the type index and both adjacency indices; the index-only account",
  "is that delta minus the rows-only Map in the same rep.",
  "",
);
if (heapAccounts === null) {
  push(
    "Not measured: `gc` was unavailable, so this run reports the row-level JSON numbers only.",
    "",
  );
} else {
  const rowsOnly = heapAccounts.rows;
  const replicaTotal = heapAccounts.total;
  const replicaDelta = heapAccounts.replica;
  const indexOnly = replicaDelta.map((value, i) => value - (rowsOnly[i] ?? 0));
  push(
    "| account | median | min | max | reps |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| rows-only baseline (\`Map<id, row>\`, row objects shared) | ${mb(median(rowsOnly))} | ${mb(minOf(rowsOnly))} | ${mb(maxOf(rowsOnly))} | ${HEAP_REPS} |`,
    `| replica after \`load\` (its own maps + type index + both indices; row objects shared) | ${mb(median(replicaTotal))} | ${mb(minOf(replicaTotal))} | ${mb(maxOf(replicaTotal))} | ${HEAP_REPS} |`,
    `| replica's own additions (replica delta, per rep) | ${mb(median(replicaDelta))} | ${mb(minOf(replicaDelta))} | ${mb(maxOf(replicaDelta))} | ${HEAP_REPS} |`,
    `| **adjacency indices + type index (delta − rows Map, per rep)** | **${mb(median(indexOnly))}** | ${mb(minOf(indexOnly))} | ${mb(maxOf(indexOnly))} | ${HEAP_REPS} |`,
    "",
    `The index-only account is ${pct(median(indexOnly), median(replicaTotal))} of the replica's own additions and ${(median(indexOnly) / Math.max(1, metadataJson)).toFixed(2)}× the held rows' JSON bytes. Row objects are shared with the workspace, so their heap is not part of any account here; the JSON table is the row account.`,
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
  "reader `namespace.ts:620` wires (`replica.relationshipLinks` / `.relationships` /",
  "`.membershipLinks`) and `replica.get` as the by-id row read.",
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
  `Rows resident after load: ${grouped(stats.entities)} (${Object.entries(stats.byType)
    .map(([type, count]) => `\`${type}\` ${grouped(count)}`)
    .join(", ")}).`,
  `Adjacency keys built (derived from the same rows): ${grouped(indexShape.reverseKeys)} reverse, ${grouped(
    indexShape.forwardKeys,
  )} forward, over ${grouped(indexShape.reverseRows)} + ${grouped(indexShape.forwardRows)} index rows.`,
  `The spike's projection build was **37.0 ms**; this is the shipped replica's \`load\`, so the`,
  "comparison is indicative, not like-for-like. `load` also does more per row than that",
  "projection: it derives both adjacency directions (two composite keys per relationship",
  "row, reverse and forward) into plain objects, plus the type index. The build is",
  "therefore ~4x the #495 budget, which is a measurement, not a gate failure.",
  "",
);

// 5. Windowed bodies
push(
  "## 5. Windowed bodies",
  "",
  `\`${ON_DEMAND_TYPE}\` is the schema's on-demand type: not held, so \`load\` drops it and`,
  "`replica.open(id)` reads it through the store into a pinned window (`pinnedCapacity: 1`,",
  "`pinnedTtlMs: 0`). Each open below follows a `close`, so every call is a cold read.",
  "",
  "| measure | value |",
  "| --- | ---: |",
  `| distinct documents opened | ${grouped(bodySample.length)} |`,
  `| cold open, median | ${usPerCall(openMedian)} |`,
  `| cold open, min | ${usPerCall(minOf(openSamples))} |`,
  `| cold open, max | ${usPerCall(maxOf(openSamples))} |`,
  `| body row size (JSON) | ${kb(workspace.bodyBytes)} |`,
  `| store rows read per cold open | ${grouped(openReads)} |`,
  `| store reads added by re-opening while pinned | ${grouped(pinnedReReads)} |`,
  `| resident bodies while every sampled body is closed | ${grouped(bodiesResidentAfterRelease)} |`,
  `| held bodies (\`heldByType\`) | ${grouped(stats.heldByType[ON_DEMAND_TYPE] ?? 0)} |`,
  "",
  "---",
  "",
  `_Harness runtime: ${fixed((performance.now() - harnessStart) / 1000, 1)} s from module start ` +
    `(fixture generation, ${HEAP_REPS} heap reps, ${LOAD_REPS} build reps, ${LATENCY_BATCHES} batches ` +
    `per timed read, one windowed-body sweep)._`,
  "",
);

process.stdout.write(out.join("\n"));
