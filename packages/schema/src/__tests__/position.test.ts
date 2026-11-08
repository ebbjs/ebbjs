/**
 * Position primitives — identity, anchor ordering, retraction algebra.
 *
 * These are generic over any cell document and deliberately private to the
 * package: the text module is the only consumer until the block tree (#504).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { format, pack, type HLCTimestamp } from "@ebbjs/core";
import * as schema from "../index";
import {
  compareAnchors,
  compareInsertOrder,
  compareStamped,
  isCovered,
  normalizeCutIntervals,
  ROOT_ANCHOR,
  ROOT_ID,
  type Anchor,
  type StampedCell,
} from "../collaborative-text/position";

const hlc = (ts: number): HLCTimestamp => format(pack(BigInt(ts), 0n));

const cell = (id: string, stamp: HLCTimestamp, author: string): StampedCell => ({
  id,
  stamp,
  author,
});

const anchored = (id: string, stamp: HLCTimestamp, author: string, anchor: Anchor) => ({
  ...cell(id, stamp, author),
  anchor,
});

describe("compareStamped", () => {
  it("orders by stamp, then author, then id", () => {
    expect(compareStamped(cell("a", hlc(1), "z"), cell("b", hlc(2), "a"))).toBeLessThan(0);
    expect(compareStamped(cell("a", hlc(1), "a"), cell("b", hlc(1), "b"))).toBeLessThan(0);
    expect(compareStamped(cell("a", hlc(1), "a"), cell("b", hlc(1), "a"))).toBeLessThan(0);
  });

  it("returns 0 only for the same cell", () => {
    const a = cell("a", hlc(1), "a");
    expect(compareStamped(a, a)).toBe(0);
    expect(compareStamped(a, { ...a, id: "b" })).not.toBe(0);
  });
});

describe("compareAnchors", () => {
  it("orders by run id, then offset", () => {
    expect(compareAnchors({ runId: "a", offset: 9 }, { runId: "b", offset: 0 })).toBeLessThan(0);
    expect(compareAnchors({ runId: "a", offset: 1 }, { runId: "a", offset: 2 })).toBeLessThan(0);
  });

  it("has one root anchor", () => {
    expect(ROOT_ANCHOR).toEqual({ runId: ROOT_ID, offset: 0 });
  });
});

describe("compareInsertOrder", () => {
  it("orders by anchor offset first", () => {
    const a = anchored("a", hlc(2), "a", { runId: "r", offset: 1 });
    const b = anchored("b", hlc(1), "a", { runId: "r", offset: 3 });
    expect(compareInsertOrder(a, b)).toBeLessThan(0);
  });

  it("puts the newer write first at the same anchor", () => {
    const older = anchored("a", hlc(1), "a", { runId: "r", offset: 1 });
    const newer = anchored("b", hlc(2), "a", { runId: "r", offset: 1 });
    expect(compareInsertOrder(newer, older)).toBeLessThan(0);
  });

  it("never returns 0 for distinct cells", () => {
    const a = anchored("a", hlc(1), "a", { runId: "r", offset: 1 });
    expect(compareInsertOrder(a, a)).toBe(0);
    expect(compareInsertOrder(a, { ...a, id: "b" })).not.toBe(0);
    expect(compareInsertOrder(a, { ...a, anchor: { runId: "r", offset: 2 } })).not.toBe(0);
  });
});

describe("retraction algebra", () => {
  it("normalizes and unions overlapping and touching intervals", () => {
    expect(
      normalizeCutIntervals([
        { from: 4, to: 6 },
        { from: 1, to: 3 },
        { from: 3, to: 5 },
      ]),
    ).toEqual([{ from: 1, to: 6 }]);
  });

  it("keeps disjoint intervals separate", () => {
    expect(
      normalizeCutIntervals([
        { from: 5, to: 7 },
        { from: 1, to: 2 },
      ]),
    ).toEqual([
      { from: 1, to: 2 },
      { from: 5, to: 7 },
    ]);
  });

  it("is idempotent and commutative", () => {
    const cuts = [
      { from: 2, to: 5 },
      { from: 4, to: 8 },
    ];
    expect(normalizeCutIntervals([...cuts, ...cuts])).toEqual(normalizeCutIntervals(cuts));
    expect(normalizeCutIntervals([...cuts].reverse())).toEqual(normalizeCutIntervals(cuts));
  });

  it("reports coverage with a half-open end", () => {
    const cuts = normalizeCutIntervals([{ from: 2, to: 5 }]);
    expect(isCovered(cuts, 2)).toBe(true);
    expect(isCovered(cuts, 4)).toBe(true);
    expect(isCovered(cuts, 5)).toBe(false);
    expect(isCovered(cuts, 1)).toBe(false);
  });
});

describe("public surface", () => {
  it("does not export the position primitives from the package entry point", () => {
    expect("compareInsertOrder" in schema).toBe(false);
    expect("normalizeCutIntervals" in schema).toBe(false);
    expect("compareAnchors" in schema).toBe(false);
  });

  it("is imported only by the text module", () => {
    // Walk every package's source, not just the siblings: a deep import from
    // the client or bridge would also break the boundary.
    const packagesRoot = new URL("../../../", import.meta.url).pathname;
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (/collaborative-text\/position|from "\.\/position"/.test(source)) {
          importers.push(full.slice(packagesRoot.length));
        }
      }
    };
    walk(packagesRoot);

    expect(importers.sort()).toEqual([
      "schema/src/__tests__/position.test.ts",
      "schema/src/collaborative-text/tree.ts",
    ]);
  });
});
