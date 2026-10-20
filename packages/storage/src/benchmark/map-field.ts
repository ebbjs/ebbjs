/**
 * Map-field container benchmark — the evidence behind
 * {@link MAP_FIELD_FLIP_POINT}.
 *
 * Measures the winning one-key patch on the replica's resident map field:
 * the plain-object merge (`mergeFieldValue`) against the sharded container
 * (`mergeResidentFieldValue`) across the run counts in the #496 research note.
 * Also measures adoption (`mapFieldFromWire`) and the record boundary
 * (`mapFieldToWire`), which are per-install / per-snapshot costs rather than
 * per-keystroke costs.
 *
 * Run from the repo root: `pnpm --filter @ebbjs/storage benchmark:map-field`
 * Markdown goes to stdout; diagnostics to stderr so the output can be pasted
 * into an issue verbatim.
 *
 * The result is observed on every iteration. A pure map-copy benchmark that
 * ignores its result can be optimised away by V8; the #496 note measured 7 µs
 * for a 1000-key copy that was elided versus ~200 µs for the real path.
 */

import { isDeepStrictEqual } from "node:util";
import { isFieldMap, makeHlc, mergeFieldValue, type FieldValue } from "@ebbjs/core";

import {
  MAP_FIELD_FLIP_POINT,
  MAP_FIELD_SHARD_COUNT,
  mapFieldFromWire,
  mapFieldGet,
  mapFieldToWire,
  mergeResidentFieldValue,
} from "../internal/map-field";

const SIZES = [100, 200, 300, 500, 1000, 2000, 5000, 10000] as const;

const leaf = (value: unknown, ms: number, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

/** An N-run content map, 120 B/run shaped like a real run leaf. */
const content = (n: number): Record<string, FieldValue> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `run_${i}`,
      leaf({ id: `run_${i}`, text: "x".repeat(48), parentId: null }, 1, `u_${i}`),
    ]),
  );

const patch = (key: string): FieldValue => ({
  map: { [key]: leaf({ id: key, text: "edited", parentId: null }, 2, "u_edit") },
});

/** Keep the observed value alive so V8 cannot elide the copy. */
let sink = 0;

const observe = (field: FieldValue): void => {
  if (!isFieldMap(field)) return;
  // The patched key and a sibling: reading only one key can be elided.
  sink += mapFieldGet(field, "run_0") === undefined ? 0 : 1;
  sink += mapFieldGet(field, "run_1") === undefined ? 0 : 1;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

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
  process.stderr.write(
    `[map-field-bench] shards=${MAP_FIELD_SHARD_COUNT} flipPoint=${MAP_FIELD_FLIP_POINT}\n`,
  );

  const rows: string[] = [];
  rows.push("| rep | " + SIZES.map((n) => `N=${n}`).join(" | ") + " |");
  rows.push("| --- | " + SIZES.map(() => "---:").join(" | ") + " |");

  const plainRow: string[] = [];
  const shardedRow: string[] = [];
  const mergeReadRow: string[] = [];
  const adoptionRow: string[] = [];
  const wireRow: string[] = [];

  for (const n of SIZES) {
    const wire = content(n);
    const container = mapFieldFromWire(wire);
    const incoming = patch("run_0");

    const expected = mergeFieldValue({ map: wire }, incoming);
    const actual = mergeResidentFieldValue(container, incoming);
    const actualWire = mapFieldToWire(actual as { map: Record<string, FieldValue> });
    if (!isDeepStrictEqual(actualWire, (expected as { map: unknown }).map)) {
      throw new Error(`parity failed at N=${n}`);
    }

    const iterations = n >= 5000 ? 60 : n >= 1000 ? 150 : 400;
    const plain = micros(() => observe(mergeFieldValue({ map: wire }, incoming)), iterations);
    const sharded = micros(() => observe(mergeResidentFieldValue(container, incoming)), iterations);
    const mergeRead = micros(() => {
      const merged = mergeResidentFieldValue(container, incoming) as {
        map: Record<string, FieldValue>;
      };
      sink += mapFieldToWire(merged).run_0 === undefined ? 0 : 1;
    }, iterations);
    const adoption = micros(
      () => {
        sink += Object.keys(mapFieldFromWire(wire).map).length;
      },
      Math.max(20, Math.floor(iterations / 4)),
    );
    const toWire = micros(
      () => {
        sink += Object.keys(mapFieldToWire(container)).length;
      },
      Math.max(20, Math.floor(iterations / 4)),
    );

    plainRow.push(plain.toFixed(1));
    shardedRow.push(sharded.toFixed(1));
    mergeReadRow.push(mergeRead.toFixed(1));
    adoptionRow.push(adoption.toFixed(1));
    wireRow.push(toWire.toFixed(1));
    process.stderr.write(`[map-field-bench] N=${n} done\n`);
  }

  rows.push("| plain object (µs/op) | " + plainRow.join(" | ") + " |");
  rows.push("| sharded container (µs/op) | " + shardedRow.join(" | ") + " |");
  rows.push("| sharded merge + first read (µs/op) | " + mergeReadRow.join(" | ") + " |");
  rows.push("| adopt from wire (µs) | " + adoptionRow.join(" | ") + " |");
  rows.push("| toWire at the record boundary (µs) | " + wireRow.join(" | ") + " |");

  process.stdout.write(`\n${rows.join("\n")}\n\nsink=${sink}\n`);
};

main();
