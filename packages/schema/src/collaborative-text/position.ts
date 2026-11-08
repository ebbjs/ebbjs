/**
 * Position primitives — the generic half of a cell document.
 *
 * A cell document is a total order over immutable cells: every cell has an
 * identity and a stamp, inserts are anchored to a `(runId, offset)` point,
 * and retractions are additive intervals. Nothing here knows what a run's
 * text means; the text module supplies the layout and interprets the cells.
 *
 * Deliberately not exported from the package entry point. The text module is
 * the only consumer until the block tree (#504) needs the same primitives.
 */

import { compare as compareHlc, type HLCTimestamp } from "@ebbjs/core";

/** The identity of one cell in a document's cell map. */
export type CellId = string;

/** A point in a run: `offset` characters in, or `0` for the root. */
export type Anchor = {
  readonly runId: CellId;
  readonly offset: number;
};

/** Sentinel run id. Every document has exactly one root. */
export const ROOT_ID = "ROOT";

/** The anchor every top-level insert shares. */
export const ROOT_ANCHOR: Anchor = { runId: ROOT_ID, offset: 0 };

/** What every cell must carry to be ordered and attributed. */
export type StampedCell = {
  readonly id: CellId;
  readonly author: string;
  readonly stamp: HLCTimestamp;
};

/** An insert's full ordering input: where, then which write. */
export type InsertOrder = StampedCell & {
  readonly anchor: Anchor;
};

/** A half-open retracted range `[from, to)`. */
export type CutInterval = {
  readonly from: number;
  readonly to: number;
};

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareNumber = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The identity order: stamp, then author, then id. Never 0 for two distinct
 * cells, because the id is the last component and ids are unique.
 */
export const compareStamped = (a: StampedCell, b: StampedCell): number =>
  compareHlc(a.stamp, b.stamp) || compareString(a.author, b.author) || compareString(a.id, b.id);

/**
 * Where two anchors sit relative to one another. This is a canonical order
 * over anchors, not document order: a projection resolves `runId` to a
 * position. Used for grouping and for stable diagnostics.
 */
export const compareAnchors = (a: Anchor, b: Anchor): number =>
  compareString(a.runId, b.runId) || compareNumber(a.offset, b.offset);

/**
 * The sibling order at one anchor: offset ascending, then **newer write
 * first**. Newer-first preserves the typing order users expect — inserting
 * twice at the same point leaves the second insertion before the first.
 *
 * The comparator is total: distinct cells always differ in stamp, author,
 * or id, so it never returns 0 for them.
 */
export const compareInsertOrder = (a: InsertOrder, b: InsertOrder): number => {
  const byOffset = compareNumber(a.anchor.offset, b.anchor.offset);
  if (byOffset !== 0) return byOffset;
  const byStamp = compareStamped(a, b);
  return byStamp === 0 ? 0 : -byStamp;
};

/**
 * Normalize an additive retraction set: sort by start, then merge overlaps
 * and touching intervals. This is what makes cuts idempotent and
 * commutative — two writes may each add a cut, and the projection sees one
 * union.
 */
export const normalizeCutIntervals = (cuts: readonly CutInterval[]): readonly CutInterval[] => {
  if (cuts.length === 0) return [];
  const sorted = [...cuts].sort(
    (a, b) => compareNumber(a.from, b.from) || compareNumber(a.to, b.to),
  );
  const out: CutInterval[] = [{ from: sorted[0]!.from, to: sorted[0]!.to }];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]!;
    const last = out[out.length - 1]!;
    if (next.from <= last.to) {
      if (next.to > last.to) out[out.length - 1] = { from: last.from, to: next.to };
    } else {
      out.push({ from: next.from, to: next.to });
    }
  }
  return out;
};

/** True when `offset` falls inside any normalized interval. */
export const isCovered = (cuts: readonly CutInterval[], offset: number): boolean => {
  for (const cut of cuts) {
    if (offset < cut.from) return false;
    if (offset < cut.to) return true;
  }
  return false;
};
