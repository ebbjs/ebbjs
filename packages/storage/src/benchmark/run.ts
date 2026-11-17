/**
 * Adapter benchmark — materializes the cost of dirty-tracking and
 * materialization across the in-memory and IndexedDB adapters.
 *
 * Run with: `pnpm --filter @ebbjs/storage benchmark`
 *
 * Output is a Markdown table suitable for pasting into the existing
 * adapter benchmark results doc. All numbers are wall-clock ops/sec on
 * a developer machine; the goal is *relative* comparison, not absolute.
 *
 * Operations benchmarked:
 *   1. `append` — write an action, mark dirty
 *   2. `get` — materialize a dirty entity
 *   3. `query` — materialize all dirty entities for a type
 *   4. `reset` — clear all state
 */
import "fake-indexeddb/auto";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "../memory/memory-adapter";
import { createIndexedDBAdapter } from "../indexeddb/indexeddb-adapter";
import type { StorageAdapter } from "../types/storage-adapter";

interface AdapterFactory {
  name: string;
  create: () => Promise<StorageAdapter>;
  reset?: (adapter: StorageAdapter) => Promise<void>;
}

const factories: readonly AdapterFactory[] = [
  {
    name: "Memory",
    create: async () => createMemoryAdapter(),
  },
  {
    name: "IndexedDB",
    create: async () => createIndexedDBAdapter({ dbName: `ebb-bench-${Date.now()}` }),
  },
];

const ACTIONS = 1000;
const ENTITIES_PER_MODEL = 100;

/** The first pass over the entities opens each row; later passes write on it. */
const opensRow = (id: number): boolean => id < ENTITIES_PER_MODEL;

const buildAction = (id: number, entityId: string, gsn: number): Action => {
  const hlc = makeHlc(1_700_000_000_000 + id);
  const updates: Update[] = [];

  // A row exists because its create was folded; the component write alone
  // materializes a placeholder, which is not the wire that ships.
  if (opensRow(id)) {
    updates.push({
      id: `u_${id}_create`,
      subject_id: entityId,
      model: "todo",
      method: "create",
      hlc,
      data: null,
    });
  }

  updates.push({
    id: `u_${id}`,
    subject_id: entityId,
    component: "todo/title",
    method: "replace",
    data: { value: `Entity ${id}`, update_id: `u_${id}`, hlc },
  });

  return { id: `a_${id}`, actor_id: "a_user1", hlc, gsn, updates };
};

interface TimedResult {
  ms: number;
}

const time = async (label: string, fn: () => Promise<unknown>): Promise<TimedResult> => {
  void label;
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  return { ms };
};

interface BenchResult {
  name: string;
  appendMs: number;
  getMs: number;
  queryMs: number;
  resetMs: number;
}

const benchAdapter = async (factory: AdapterFactory): Promise<BenchResult> => {
  const adapter = await factory.create();

  // append: write ACTIONS actions across ENTITIES_PER_MODEL entities
  const appendResult = await time("append", async () => {
    for (let i = 0; i < ACTIONS; i++) {
      const entityId = `todo_${i % ENTITIES_PER_MODEL}`;
      const action = buildAction(i, entityId, i + 1);
      await adapter.actions.append(action);
    }
  });

  // get: materialize one entity
  const getResult = await time("get", async () => {
    for (let i = 0; i < ENTITIES_PER_MODEL; i++) {
      await adapter.entities.get(`todo_${i}`);
    }
  });

  // query: materialize all of one type
  const queryResult = await time("query", async () => {
    // re-mark all dirty so query has work to do
    for (let i = 0; i < ENTITIES_PER_MODEL; i++) {
      await adapter.dirtyTracker.mark(`todo_${i}`, "todo");
    }
    await adapter.entities.query("todo");
  });

  // reset
  const resetResult = await time("reset", async () => {
    await adapter.reset();
  });

  return {
    name: factory.name,
    appendMs: appendResult.ms,
    getMs: getResult.ms,
    queryMs: queryResult.ms,
    resetMs: resetResult.ms,
  };
};

const formatRow = (r: BenchResult): string =>
  `| ${r.name} | ${(ACTIONS / (r.appendMs / 1000)).toFixed(0)} | ${(
    ENTITIES_PER_MODEL /
    (r.getMs / 1000)
  ).toFixed(
    0,
  )} | ${(ENTITIES_PER_MODEL / (r.queryMs / 1000)).toFixed(0)} | ${r.resetMs.toFixed(2)} |`;

const formatHeader = (): string =>
  "| Adapter | append (ops/sec) | get (ops/sec) | query (ops/sec) | reset (ms) |\n| --- | ---: | ---: | ---: | ---: |";

export const runBenchmarks = async (): Promise<string> => {
  const results: BenchResult[] = [];
  for (const factory of factories) {
    // warm-up
    const warmup = await factory.create();
    await warmup.reset();
    results.push(await benchAdapter(factory));
  }

  const lines = [
    "# Storage adapter benchmark",
    "",
    `Workload: ${ACTIONS} actions × ${ENTITIES_PER_MODEL} entities of model "todo", each row opened by its create.`,
    "Each `get` materializes one entity; each `query` materializes the full type.",
    "",
    formatHeader(),
    ...results.map(formatRow),
  ];
  return lines.join("\n") + "\n";
};

// CLI entrypoint
const isMain = typeof process !== "undefined" && process.argv[1]?.endsWith("run.ts");
if (isMain) {
  runBenchmarks().then((output) => {
    // eslint-disable-next-line no-console
    console.log(output);
  });
}
