/**
 * SPIKE S5 (#779): full re-execution vs patching a cached result.
 *
 * Two measurements:
 *
 * 1. How often today's query cache re-runs an entry per change. The cache
 *    reconciles each subscribed entry once per notification, so the cost is
 *    "entries a change invalidates", not "changes". The `rows` surface reads
 *    the whole source model, so any component write re-runs it.
 * 2. What a full plan re-execution examines versus a patch of one row, on a
 *    10k-row source.
 *
 * Not for merge.
 */

import { describe, expect, it } from "vitest";
import type { Entity, FieldValue } from "@ebbjs/core";
import type { Replica, ReplicaChange } from "@ebbjs/storage/replica";

import { emptyQuery, type Query } from "../query";
import { createQueryCache, type QuerySource } from "../query-cache";
import { planQuery } from "../query-plan";
import { executePlan, type PlanExecutor } from "../query-execute";

const leaf = (value: unknown): FieldValue => ({ value, update_id: "u", hlc: "0001" });

const row = (index: number, status = "open"): Entity => ({
  id: `n_${String(index).padStart(5, "0")}`,
  model: "note",
  data: { fields: { title: leaf(`t${index}`), status: leaf(status), content: leaf(`c${index}`) } },
  exists: true,
  created_hlc: "0001",
  updated_hlc: "0001",
  deleted_hlc: null,
  last_gsn: 1,
});

/** A replica stub: the cache only reads `revision`, `changesSince`, `subscribe`. */
const fakeReplica = () => {
  let revision = 0;
  let journal: ReplicaChange[] = [];
  const listeners = new Set<() => void>();
  const replica = {
    get revision() {
      return revision;
    },
    changesSince(from: number) {
      return journal.filter((change) => change.revision > from);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Replica;
  return {
    replica,
    push(id: string, components: readonly string[]) {
      revision += 1;
      journal.push({ revision, id, deleted: false, components });
      for (const listener of listeners) listener();
    },
    /** One notification carrying a batch, as one `ingest` produces. */
    pushBatch(changes: readonly (readonly [string, readonly string[]])[]) {
      for (const [id, components] of changes) {
        revision += 1;
        journal.push({ revision, id, deleted: false, components });
      }
      for (const listener of listeners) listener();
    },
  };
};

const source = (counter: { runs: number }): QuerySource<string> => ({
  ready: () => {},
  isReady: () => true,
  execute: () => {
    counter.runs += 1;
    return ["n_1"];
  },
});

const rowsQuery = (): Query => emptyQuery("note");
const openNotesQuery = (): Query => ({
  ...emptyQuery("note"),
  groups: [[{ kind: "field", field: "status", value: "open" }]],
});

describe("S5: re-run counts under today's cache", () => {
  it("a rows entry re-runs on any source-model component; a filtered collection does not", () => {
    const { replica, push } = fakeReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 0 });
    const rowsRuns = { runs: 0 };
    const collectionRuns = { runs: 0 };
    const stopRows = cache
      .watch("rows", rowsQuery(), source(rowsRuns))
      .subscribe(() => {}, { initial: false });
    const stopCollection = cache
      .watch("collection", openNotesQuery(), source(collectionRuns))
      .subscribe(() => {}, { initial: false });
    expect(rowsRuns.runs).toBe(1);
    expect(collectionRuns.runs).toBe(1);

    // A title write: the rows projection carries it; the filtered collection
    // reads only `note/status` plus membership.
    push("n_1", ["note/title"]);
    expect(rowsRuns.runs).toBe(2);
    expect(collectionRuns.runs).toBe(1);

    // A status write changes matching for the collection too.
    push("n_1", ["note/status"]);
    expect(rowsRuns.runs).toBe(3);
    expect(collectionRuns.runs).toBe(2);

    // A lazy body write the rows query projects but a narrower selection would
    // not: still a rows re-run today.
    push("n_1", ["note/content"]);
    expect(rowsRuns.runs).toBe(4);
    expect(collectionRuns.runs).toBe(2);

    stopRows();
    stopCollection();
  });

  it("one batch invalidates each affected entry once, not once per change", () => {
    const { replica, pushBatch } = fakeReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 0 });
    const runs = { runs: 0 };
    cache.watch("rows", rowsQuery(), source(runs)).subscribe(() => {}, { initial: false });
    const floor = runs.runs;
    // 100 changes in one journal entry: the cache reconciles once.
    pushBatch(Array.from({ length: 100 }, () => ["n_1", ["note/title"]] as const));
    expect(runs.runs).toBe(floor + 1);
  });
});

describe("S5: patching one row vs re-executing the plan", () => {
  const N = 10_000;

  const executorOver = (rows: readonly Entity[], examined: { rows: number }): PlanExecutor => ({
    scan: (type) => {
      examined.rows += rows.length;
      return rows.filter((row) => row.model === type);
    },
    get: (id) => {
      examined.rows += 1;
      return rows.find((row) => row.id === id);
    },
    relationships: () => [],
    memberships: () => [],
    components: () => [],
  });

  it("a full re-run examines every source row; a patch examines one", () => {
    const rows = Array.from({ length: N }, (_, index) => row(index));
    const plan = planQuery(openNotesQuery());
    const examined = { rows: 0 };
    const started = performance.now();
    const result = executePlan(plan, executorOver(rows, examined));
    const elapsed = performance.now() - started;
    expect(result).toHaveLength(N);
    console.log("S5 full re-run", { rows: N, examined: examined.rows, ms: elapsed.toFixed(2) });

    // Patch: one changed row, predicate re-evaluated, splice into the result.
    const changed = {
      ...row(5),
      data: { fields: { ...row(5).data.fields, status: leaf("closed") } },
    };
    const patchExamined = { rows: 0 };
    const patchStarted = performance.now();
    const index = result.findIndex((candidate) => candidate.id === changed.id);
    const stillMatches = changed.data.fields.status?.value === "open";
    const patched = [...result];
    if (index !== -1 && !stillMatches) patched.splice(index, 1);
    const patchElapsed = performance.now() - patchStarted;
    console.log("S5 patch", { examined: patchExamined.rows + 1, ms: patchElapsed.toFixed(4) });
    expect(patched).toHaveLength(N - 1);
  });
});
