/**
 * SPIKE S3 (#779): prove the dependency index is equivalent to today's scan
 * and measure the work it saves.
 *
 * Not for merge.
 */

import { describe, expect, it } from "vitest";
import type { ReplicaChange } from "@ebbjs/storage/replica";

import { createDependencyIndex, matchesDependencies, type Dependencies } from "./dispatch";

interface Sub {
  readonly id: number;
  readonly deps: Dependencies;
}

const sub = (id: number, deps: Dependencies): Sub => ({ id, deps });

const change = (id: string, components: readonly string[], revision = 1): ReplicaChange => ({
  revision,
  id,
  deleted: false,
  components,
});

/** A deterministic pseudo-random generator so runs are comparable. */
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("S3: dependency-indexed dispatch", () => {
  it("touches exactly the subscriptions the scan touches", () => {
    const index = createDependencyIndex<Sub>();
    const subs = [
      sub(1, { components: ["note/title"] }),
      sub(2, { models: ["note"] }),
      sub(3, { components: ["note/content"], rows: ["n_7"] }),
      sub(4, { rows: ["n_1"] }),
      sub(5, { components: ["ebb/link"] }),
    ];
    for (const item of subs) index.add(item, item.deps);

    const batches: readonly (readonly ReplicaChange[])[] = [
      [change("n_1", ["note/title"])],
      [change("n_7", ["note/content"])],
      [change("n_9", ["ebb/grant"])],
      [change("n_1", [])],
      [change("n_2", ["note/title"]), change("n_7", ["note/content"]), change("n_1", [])],
    ];
    for (const batch of batches) {
      const indexed = index.dispatch(batch);
      const scanned = index.scan(batch, (item, next) => matchesDependencies(item.deps, next));
      expect([...indexed.touched].map((item) => item.id).sort()).toEqual(
        [...scanned.touched].map((item) => item.id).sort(),
      );
    }
  });

  it("dispatch work is the touched set, not entries × changes", () => {
    const index = createDependencyIndex<Sub>();
    const ENTRIES = 5_000;
    const ROWS = 2_000;
    const rng = mulberry32(42);
    for (let i = 0; i < ENTRIES; i += 1) {
      const kind = i % 4;
      const row = `n_${Math.floor(rng() * ROWS)}`;
      const deps: Dependencies =
        kind === 0
          ? { models: ["note"] }
          : kind === 1
            ? { components: ["note/title", "note/status"] }
            : kind === 2
              ? { components: ["note/content"], rows: [row] }
              : { rows: [row] };
      index.add(sub(i, deps), deps);
    }

    const batch = Array.from({ length: 100 }, (_, i) =>
      change(`n_${i}`, i % 5 === 0 ? [] : ["note/title"], i + 1),
    );
    const indexed = index.dispatch(batch);
    const scanned = index.scan(batch, (item, next) => matchesDependencies(item.deps, next));

    expect([...indexed.touched].map((item) => item.id).sort()).toEqual(
      [...scanned.touched].map((item) => item.id).sort(),
    );
    console.log("S3 5000 entries / 100 changes", {
      ...indexed.stats,
    });
    expect(indexed.stats.touched).toBeGreaterThan(0);
    expect(indexed.stats.touched).toBeLessThan(indexed.stats.scanWork);
  });

  it("a single change over 5,000 subscriptions", () => {
    const index = createDependencyIndex<Sub>();
    for (let i = 0; i < 5_000; i += 1) {
      const deps: Dependencies =
        i % 2 === 0
          ? { components: [`note/field_${i % 50}`] }
          : { components: [`other/field_${i % 50}`] };
      index.add(sub(i, deps), deps);
    }
    const indexed = index.dispatch([change("n_1", ["note/field_0"])]);
    console.log("S3 single change", indexed.stats);
    expect(indexed.stats.touched).toBe(100);
    expect(indexed.stats.scanWork).toBe(5_000);
  });
});
