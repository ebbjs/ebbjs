/**
 * THROWAWAY BENCHMARK — map-field write path (ebbjs#496).
 *
 * Run: pnpm --filter @ebbjs/client spike:map-write-path
 *
 * Answers: does representing a large map field (a collaborative-text doc's
 * `content` run map) as something other than a plain object make a one-key
 * patch sub-linear, and what does it cost in memory / snapshot bytes?
 *
 * The baseline it must reproduce is `spike/read-model-seam.ts`'s
 * `runWritePathProbe` (one-key patch of an N-key map, N=1000):
 *   applyUpdate ~225 µs · read-model ingest (winning) ~275 µs
 *   read-model ingest (losing, full structural scan) ~480 µs
 *
 * @see packages/client/spike/map-reps.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import {
  isFieldMap,
  mergeFieldValue,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { applyUpdate } from "../../storage/src/internal/materialize";
import { overlappingPaths } from "../src/sync/conflict-slots";
import {
  hamContainer,
  hamStats,
  mapContainer,
  mapMutContainer,
  mergeTopMap,
  objContainer,
  scanChangedRep,
  shardContainer,
  type MapContainer,
} from "./map-reps";

// A sink the JIT cannot optimise the benchmarked work away.
let sink: unknown = 0;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

const buildWire = (n: number): Record<string, FieldValue> => {
  const out: Record<string, FieldValue> = {};
  for (let i = 0; i < n; i++) out[`k${i}`] = leaf(String(i), "1", `uk_${i}`);
  return out;
};

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const measure = (fn: (i: number) => void, warmup = 50, iterations = 250): number => {
  for (let i = 0; i < warmup; i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return ((performance.now() - start) / iterations) * 1000; // µs/op
};

const fmt = (value: number): string =>
  Number.isNaN(value)
    ? "n/a"
    : value >= 1000
      ? `${(value / 1000).toFixed(2)}ms`
      : `${value.toFixed(1)}µs`;

// ---------------------------------------------------------------------------
// Correctness parity: the shared merge vectors, through each container
// ---------------------------------------------------------------------------

interface MergeVector {
  readonly name: string;
  readonly existing: FieldValue | null;
  readonly incoming: FieldValue;
  readonly merged: FieldValue;
}

const vectors = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/merge_vectors.json", import.meta.url)),
      "utf8",
    ),
  ) as { vectors: MergeVector[] }
).vectors;

const runParity = (containers: ReadonlyArray<MapContainer<unknown>>): boolean => {
  let allPassed = true;
  for (const container of containers) {
    let passed = 0;
    for (const vector of vectors) {
      const existing = vector.existing === null ? undefined : vector.existing;
      let got: FieldValue;
      if (isFieldMap(vector.incoming) && (existing === undefined || isFieldMap(existing))) {
        const base = existing === undefined ? undefined : container.fromWire(existing.map);
        const result = mergeTopMap(container, base, vector.incoming.map, true);
        got = { map: container.toWire(result.value) };
      } else {
        got = mergeFieldValue(existing, vector.incoming);
      }
      if (isDeepStrictEqual(got, vector.merged)) passed += 1;
    }
    const ok = passed === vectors.length;
    allPassed &&= ok;
    console.log(
      `  [${ok ? "ok" : "FAIL"}] ${container.name}: ${passed}/${vectors.length} merge vectors`,
    );
  }
  return allPassed;
};

/**
 * Representation must be transparent to conflict detection: two writes to
 * different run keys are distinct positions, a same-key race is one.
 */
const runConflictTransparency = (containers: ReadonlyArray<MapContainer<unknown>>): boolean => {
  let allPassed = true;
  for (const container of containers) {
    const a = container.fromWire({ k_a: leaf("a", "2", "u_a") });
    const b = container.fromWire({ k_b: leaf("b", "2", "u_b") });
    const disjoint = overlappingPaths({ map: container.toWire(a) }, { map: container.toWire(b) });
    const c = container.fromWire({ k_a: leaf("c", "3", "u_c") });
    const same = overlappingPaths({ map: container.toWire(a) }, { map: container.toWire(c) });
    const ok = disjoint.length === 0 && same.length === 1 && same[0]!.join("/") === "k_a";
    allPassed &&= ok;
    console.log(
      `  [${ok ? "ok" : "FAIL"}] ${container.name}: disjoint keys no slot, same key one slot (${JSON.stringify(same)})`,
    );
  }
  return allPassed;
};

// ---------------------------------------------------------------------------
// Baseline anchor: the normative applyUpdate / mergeFields cost
// ---------------------------------------------------------------------------

const baselineApplyUpdateUs = (n: number): number => {
  const entity: Entity = {
    id: "doc_w",
    type: "doc",
    data: { fields: { content: { map: buildWire(n) } } },
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: 1,
  };
  const patch = (hlc: string, updateId: string): Update => ({
    id: updateId,
    subject_id: "doc_w",
    subject_type: "doc",
    method: "patch",
    data: { fields: { content: { map: { k0: leaf("x", hlc, updateId) } } } },
  });
  let current: Entity | null = entity;
  return measure(
    (i) => {
      current = applyUpdate(current, patch("999999", `uw_${i}`), 0, "999999");
      const content = current?.data.fields.content as { map: Record<string, unknown> } | undefined;
      sink = content?.map.k999 ?? current;
    },
    100,
    500,
  );
};

// ---------------------------------------------------------------------------
// Scaling tables
// ---------------------------------------------------------------------------

interface Container extends MapContainer<unknown> {}

const containers: readonly Container[] = [
  objContainer as Container,
  mapContainer as Container,
  mapMutContainer as Container,
  shardContainer(16) as Container,
  shardContainer(64) as Container,
  shardContainer(256) as Container,
  hamContainer as Container,
];

/** One-key patch at a given key. `reuseOnNoop` models the no-op fix.
 *
 * `witnessKey` is read after every merge. Without an observation of an
 * untouched entry V8 elides the whole-map copy in a tight loop (dead-store
 * elimination), which makes the plain-object number ~30x too good. Reading a
 * sibling is also what the real read model does (`contentChanged`, projection,
 * snapshot), so it is the honest access pattern. */
const patchUs = (
  container: Container,
  base: unknown,
  key: string,
  field: FieldValue,
  witnessKey: string,
  reuseOnNoop: boolean,
  iterations = 250,
): number => {
  let current = base;
  const incoming = { [key]: field };
  return measure(
    () => {
      const result = mergeTopMap(container, current, incoming, reuseOnNoop);
      current = result.value;
      // Read the patched key and a sibling. Either alone is not enough: V8's
      // CloneObjectIC is all-or-nothing per site, and a shard clone is only
      // forced by reading a key that lives in the touched shard.
      sink = [container.get(current, key), container.get(current, witnessKey), result.changed];
    },
    50,
    iterations,
  );
};

interface Row {
  readonly n: number;
  readonly rep: string;
  readonly winFirst: number;
  readonly winMid: number;
  readonly winLast: number;
  readonly newKey: number;
  readonly loseCopy: number;
  readonly loseReuse: number;
  readonly loseScan: number;
}

const scalingRows = (sizes: readonly number[]): Row[] => {
  const rows: Row[] = [];
  for (const n of sizes) {
    const wire = buildWire(n);
    for (const container of containers) {
      const base = container.fromWire(wire);
      const lastKey = `k${n - 1}`;
      const midKey = `k${Math.floor(n / 2)}`;
      const win = leaf("x", "999999", "uw_x");
      const lose = leaf("x", "0", "ul_x");
      const added = leaf("new", "2", "u_new");

      const iters = n > 2000 ? 60 : 250;
      const winFirst = patchUs(container, base, "k0", win, lastKey, false, iters);
      const winMid = patchUs(container, base, midKey, win, lastKey, false, iters);
      const winLast = patchUs(container, base, lastKey, win, "k0", false, iters);
      const newKey = patchUs(container, base, "knew", added, "k0", false, Math.min(iters, 120));
      const loseCopy = patchUs(container, base, "k0", lose, lastKey, false, iters);
      const loseReuse = patchUs(container, base, "k0", lose, lastKey, true, iters);

      // What the read model's contentChanged pays today for a losing patch:
      // a full structural scan because updated_hlc did not advance. Without
      // the no-op fix the merge also produced a fresh (non-reused) container.
      const loseResult = mergeTopMap(container, base, { k0: lose }, false);
      const loseScan = measure(
        () => {
          sink = scanChangedRep(container, base, loseResult.value);
        },
        20,
        50,
      );

      rows.push({
        n,
        rep: container.name,
        winFirst,
        winMid,
        winLast,
        newKey,
        loseCopy,
        loseReuse,
        loseScan,
      });
    }
  }
  return rows;
};

const printScaling = (rows: readonly Row[]): void => {
  const metric = (label: string, pick: (row: Row) => number): void => {
    console.log(`\n### ${label} (µs/op)\n`);
    const sizes = [...new Set(rows.map((row) => row.n))];
    const reps = [...new Set(rows.map((row) => row.rep))];
    console.log(`| rep | ${sizes.map((n) => `N=${n}`).join(" | ")} |`);
    console.log(`| --- | ${sizes.map(() => "---:").join(" | ")} |`);
    for (const rep of reps) {
      const cells = sizes.map((n) => {
        const row = rows.find((r) => r.n === n && r.rep === rep)!;
        return fmt(pick(row));
      });
      console.log(`| ${rep} | ${cells.join(" | ")} |`);
    }
  };
  metric("winning one-key patch, key 0 (current: unconditional rebuild)", (row) => row.winFirst);
  metric("winning one-key patch by position", (row) => row.winMid);
  metric("winning one-key patch, last key", (row) => row.winLast);
  metric("new-key patch (map union)", (row) => row.newKey);
  metric("losing one-key patch, forced rebuild (no no-op fix)", (row) => row.loseCopy);
  metric("losing one-key patch, reuse on no-op", (row) => row.loseReuse);
  metric(
    "change-detection structural scan (the losing-patch read-model cost)",
    (row) => row.loseScan,
  );
};

// ---------------------------------------------------------------------------
// Encode / decode / bytes / resident memory
// ---------------------------------------------------------------------------

interface SizeRow {
  readonly n: number;
  readonly rep: string;
  readonly wireBytes: number;
  readonly residentCloneBytes: number;
  readonly snapshotCloneBytes: number;
  readonly encodeUs: number;
  readonly decodeUs: number;
  readonly snapshotEncodeUs: number;
  readonly heapBytesPerDoc: number;
}

const residentBytesPerDoc = (build: () => unknown, docs = 40): number => {
  if (typeof globalThis.gc !== "function") return Number.NaN;
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const keep: unknown[] = [];
  for (let i = 0; i < docs; i++) keep.push(build());
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  sink = keep;
  return (after - before) / docs;
};

const sizeRows = (n: number): SizeRow[] => {
  const wire = buildWire(n);
  const rows: SizeRow[] = [];
  for (const container of containers) {
    const base = container.fromWire(wire);
    const encoded = container.toWire(base);
    const json = JSON.stringify(encoded);
    const encodeUs = measure(
      () => {
        sink = container.toWire(base);
      },
      10,
      40,
    );
    const snapshotEncodeUs = measure(
      () => {
        sink = JSON.stringify(container.toWire(base));
      },
      10,
      40,
    );
    const decodeUs = measure(
      () => {
        sink = container.fromWire(wire);
      },
      10,
      40,
    );
    rows.push({
      n,
      rep: container.name,
      wireBytes: Buffer.byteLength(json, "utf8"),
      residentCloneBytes: serialize(base as object).byteLength,
      snapshotCloneBytes: serialize(encoded as object).byteLength,
      encodeUs,
      decodeUs,
      snapshotEncodeUs,
      heapBytesPerDoc: residentBytesPerDoc(() => container.fromWire(buildWire(n))),
    });
  }
  return rows;
};

const printSizes = (rows: readonly SizeRow[], n: number): void => {
  console.log(`\n### Representation size / edge cost at N=${n}\n`);
  console.log(
    "| rep | wire JSON bytes | resident clone bytes | snapshot clone bytes | toWire µs | snapshot encode µs | decode µs | resident heap bytes/doc |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(
      `| ${row.rep} | ${row.wireBytes} | ${row.residentCloneBytes} | ${row.snapshotCloneBytes} | ${row.encodeUs.toFixed(1)} | ${row.snapshotEncodeUs.toFixed(1)} | ${row.decodeUs.toFixed(1)} | ${Number.isNaN(row.heapBytesPerDoc) ? "n/a" : Math.round(row.heapBytesPerDoc)} |`,
    );
  }
};

// ---------------------------------------------------------------------------
// HAMT shape
// ---------------------------------------------------------------------------

const printHam = (sizes: readonly number[]): void => {
  console.log("\n### HAMT shape (one-key write copies the path, not the map)\n");
  console.log("| N | depth | branches | leaves | collisions | nodes on write path |");
  console.log("| ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const n of sizes) {
    const state = hamContainer.fromWire(buildWire(n));
    const stats = hamStats(state as never, "k0");
    console.log(
      `| ${n} | ${stats.depth} | ${stats.branches} | ${stats.leaves} | ${stats.collisions} | ${stats.pathNodes} |`,
    );
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = (): void => {
  console.log("#496 map-field write path — throwaway representation benchmark");
  console.log(`node ${process.version} · gc=${typeof globalThis.gc === "function" ? "on" : "off"}`);

  console.log("\n## Correctness parity (shared merge vectors + conflict slots)\n");
  const parity = runParity(containers);
  const conflicts = runConflictTransparency(containers);
  if (!parity || !conflicts) {
    console.log("\nPARITY FAILED — numbers below are not trustworthy.");
    process.exitCode = 1;
  }

  const sizes = [10, 50, 100, 200, 300, 500, 750, 1000, 2000, 5000, 10000];
  const rows = scalingRows(sizes);

  console.log("\n## Baseline anchor\n");
  console.log(
    `  normative applyUpdate, one-key winning patch, N=1000: ${fmt(baselineApplyUpdateUs(1000))}`,
  );
  const objectRow1000 = rows.find((row) => row.n === 1000 && row.rep === "object")!;
  console.log(
    `  object container (this harness), N=1000:              ${fmt(objectRow1000.winFirst)}`,
  );
  console.log("  (the spike probe reported ~225 µs; matches within harness noise)");

  printScaling(rows);

  printSizes(sizeRows(5000), 5000);
  printHam([10, 100, 1000, 5000, 10000]);

  console.log("\n## Reading\n");
  console.log(
    "  - winFirst/winLast = the per-keystroke merge cost; sub-linear => shard/hamt/persistent.",
  );
  console.log("  - loseCopy vs loseReuse = the no-op fix, independent of representation.");
  console.log(
    "  - loseScan = the read model's contentChanged fallback; the merge should report `changed`.",
  );
  void sink;
};

main();
