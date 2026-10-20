/**
 * Map-read benchmark — the evidence for caching projections and derived state
 * per content version.
 *
 * Measures repeated reads of an unchanged `content` map against reads of a new
 * version with the same runs:
 *   - `parseContentField` (run-id → field parse)
 *   - `projectFieldValue` (application-facing map projection)
 *   - `TextDocument.hydrate` (parse + apply into the causal tree)
 *
 * Run from the repo root: `pnpm --filter @ebbjs/client benchmark:map-read`
 * Markdown goes to stdout; diagnostics to stderr.
 */

import { format, pack, type FieldValue, type HLCTimestamp } from "@ebbjs/core";

import { TextDocument } from "../fields/collaborative-text/text-document";
import { parseContentField } from "../fields/collaborative-text/wire";
import type { RunNode } from "../fields/collaborative-text/tree";
import { projectFieldValue } from "../sync/query-builder";

const SIZES = [500, 1000, 5000, 10000] as const;
const COLD_VERSIONS = 20;

const hlcOf = (ms: number): HLCTimestamp => format(pack(BigInt(ms), 0n));

/** N runs in one parent chain, shaped like a typed document. */
const runs = (n: number): FieldValue => {
  const map: Record<string, FieldValue> = {};
  for (let index = 0; index < n; index += 1) {
    const hlc = hlcOf(index + 1);
    const id = `${hlc}:actor_1`;
    const node: RunNode = {
      id,
      hlc,
      actorId: "actor_1",
      text: "x",
      parentId: index === 0 ? "ROOT" : `${hlcOf(index)}:actor_1`,
      deleted: false,
    };
    map[id] = { value: node, update_id: `u_${index}`, hlc };
  }
  return { map };
};

let sink = 0;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Microseconds per call, best-of-7 medians; `warm` runs the same closure. */
const micros = (fn: () => void, iterations: number): number => {
  for (let warm = 0; warm < Math.min(iterations, 20); warm += 1) fn();
  const samples: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) fn();
    samples.push(((performance.now() - start) * 1000) / iterations);
  }
  return median(samples);
};

const main = (): void => {
  const rows: string[] = [];
  const parseCold: string[] = [];
  const parseWarm: string[] = [];
  const projectCold: string[] = [];
  const projectWarm: string[] = [];
  const hydrateCold: string[] = [];
  const hydrateWarm: string[] = [];

  /** Per-call cost of reading distinct, never-before-seen versions. */
  const coldMicros = (n: number, read: (field: FieldValue) => void): number => {
    const samples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const versions = Array.from({ length: COLD_VERSIONS }, () => runs(n));
      const start = performance.now();
      for (const version of versions) read(version);
      samples.push(((performance.now() - start) * 1000) / COLD_VERSIONS);
    }
    return median(samples);
  };

  for (const n of SIZES) {
    const first = runs(n);
    // Read one stable key: observing the whole projection would add an O(N)
    // walk of its own and hide the cache hit.
    const probeKey = Object.keys(projectFieldValue(first) as object)[0]!;
    const probe = (field: FieldValue): void => {
      sink += (projectFieldValue(field) as Record<string, unknown>)[probeKey] === undefined ? 0 : 1;
    };

    const parseColdUs = coldMicros(n, (field) => {
      sink += parseContentField(field).size;
    });
    const parseWarmUs = micros(
      () => {
        sink += parseContentField(first).size;
      },
      n >= 5000 ? 200 : 1000,
    );

    const projectColdUs = coldMicros(n, probe);
    const projectWarmUs = micros(() => probe(first), n >= 5000 ? 200 : 1000);

    const hydrateColdSamples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const doc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
      // Build the tree first: this measures a new version arriving at an
      // already-open document, not a from-scratch document build.
      doc.hydrate(runs(n));
      const versions = Array.from({ length: COLD_VERSIONS }, () => runs(n));
      const start = performance.now();
      for (const version of versions) {
        doc.hydrate(version);
        sink += doc.docState.nodes.size;
      }
      hydrateColdSamples.push(((performance.now() - start) * 1000) / COLD_VERSIONS);
    }
    const hydrateColdUs = median(hydrateColdSamples);

    const warmDoc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
    warmDoc.hydrate(first);
    const hydrateWarmUs = micros(
      () => {
        warmDoc.hydrate(first);
        sink += warmDoc.docState.nodes.size;
      },
      n >= 5000 ? 200 : 1000,
    );

    parseCold.push(parseColdUs.toFixed(1));
    parseWarm.push(parseWarmUs.toFixed(1));
    projectCold.push(projectColdUs.toFixed(1));
    projectWarm.push(projectWarmUs.toFixed(1));
    hydrateCold.push(hydrateColdUs.toFixed(1));
    hydrateWarm.push(hydrateWarmUs.toFixed(1));
    process.stderr.write(`[map-read-bench] N=${n} done\n`);
  }

  rows.push("| read | " + SIZES.map((n) => `N=${n}`).join(" | ") + " |");
  rows.push("| --- | " + SIZES.map(() => "---:").join(" | ") + " |");
  rows.push("| `parseContentField`, new version (µs) | " + parseCold.join(" | ") + " |");
  rows.push("| `parseContentField`, same version (µs) | " + parseWarm.join(" | ") + " |");
  rows.push("| `projectFieldValue`, new version (µs) | " + projectCold.join(" | ") + " |");
  rows.push("| `projectFieldValue`, same version (µs) | " + projectWarm.join(" | ") + " |");
  rows.push("| `TextDocument.hydrate`, new version (µs) | " + hydrateCold.join(" | ") + " |");
  rows.push("| `TextDocument.hydrate`, same version (µs) | " + hydrateWarm.join(" | ") + " |");

  process.stdout.write(`\n${rows.join("\n")}\n\nsink=${sink}\n`);
};
main();
