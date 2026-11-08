/**
 * The text module: runs, cuts, and the one projection.
 *
 * A document is a map of immutable cells. A **run** carries text; a **cut**
 * retracts a half-open range of the run it names. Neither is ever rewritten:
 * an insert is a new run anchored at `(runId, offset)`, an extend is a new run
 * anchored at the end of an existing run, and a delete is a new cut. Because
 * runs never move, an anchor is permanent and `(offset, stamp, author, id)` is
 * a total order over inserts.
 *
 * The read path is `project(cells)`: walk runs from the root, interleave the
 * runs anchored inside each run at their offsets, and hide characters covered
 * by cuts. Cuts hide only the owning run's characters, so text inserted at a
 * retracted position survives, and cut-vs-cut / cut-vs-insert are commutative
 * and idempotent.
 *
 * This is the "model" — no knowledge of CodeMirror, React, or the network.
 *
 * @see ../../docs/prototypes/collaborative-text/README.md for the original
 *      design record; this module supersedes its run-rewriting model.
 */

import { compare as compareHlc, type HLCTimestamp } from "@ebbjs/core";

import {
  compareInsertOrder,
  normalizeCutIntervals,
  ROOT_ANCHOR,
  ROOT_ID,
  type Anchor,
  type CutInterval,
  type InsertOrder,
  type StampedCell,
} from "./position";

export { ROOT_ID, ROOT_ANCHOR };
export type { Anchor, CutInterval };

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** An immutable run of text, anchored at a point in another run (or ROOT). */
export type RunCell = StampedCell & {
  readonly kind: "run";
  readonly text: string;
  readonly anchor: Anchor;
};

/** An immutable, additive retraction of `[from, to)` characters of one run. */
export type CutCell = StampedCell & {
  readonly kind: "cut";
  readonly runId: string;
  readonly from: number;
  readonly to: number;
};

export type TextCell = RunCell | CutCell;

/**
 * One entry in a document's `content` map. The envelope's `hlc` /
 * `update_id` are the map's per-key merge inputs; the cell's own `stamp` is
 * the write that created it.
 */
export type CellFieldValue = {
  readonly value: TextCell;
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * A contiguous visible fragment of one run. `offset` is the fragment's
 * character offset within the run, so a run interrupted by an insert yields
 * two spans with the same `runId` and different `offset`s.
 */
export type RunSpan = {
  readonly runId: string;
  readonly offset: number;
  readonly length: number;
};

/** The document's visible layout: spans in document order. */
export type PositionIndex = {
  readonly spans: readonly RunSpan[];
  readonly totalLength: number;
};

/** Result of looking up a document position in the index. */
export type PositionLookup = {
  readonly runId: string;
  /** Offset within the run's own text, not the span's. */
  readonly offset: number;
  readonly spanIndex: number;
};

/** The projected document: the cell map plus everything derived from it. */
export type DocState = {
  readonly cells: ReadonlyMap<string, CellFieldValue>;
  readonly runs: ReadonlyMap<string, RunCell>;
  readonly cuts: ReadonlyMap<string, readonly CutInterval[]>;
  readonly index: PositionIndex;
  readonly text: string;
};

/** An empty document. */
export const createDocState = (): DocState => project(new Map());

/**
 * Project a cell set into the visible document. The only read path: the
 * result depends only on the cells, never on the order they arrived in.
 *
 * A run whose anchor is missing (or that sits in a cycle) is not rendered:
 * there is no placeholder parent and no fallback position. The cells are
 * still kept, so the run appears once its anchor is delivered.
 */
export const project = (cells: ReadonlyMap<string, CellFieldValue>): DocState => {
  const runs = new Map<string, RunCell>();
  const rawCuts = new Map<string, CutInterval[]>();

  for (const [id, field] of cells) {
    const cell = field.value;
    if (cell.kind === "run") {
      runs.set(id, cell);
    } else {
      const list = rawCuts.get(cell.runId);
      if (list === undefined) rawCuts.set(cell.runId, [{ from: cell.from, to: cell.to }]);
      else list.push({ from: cell.from, to: cell.to });
    }
  }

  const cuts = new Map<string, readonly CutInterval[]>();
  for (const [runId, intervals] of rawCuts) cuts.set(runId, normalizeCutIntervals(intervals));

  const children = new Map<string, RunCell[]>();
  for (const run of runs.values()) {
    if (run.anchor.runId === run.id) continue; // a self-anchored run cannot be placed
    const siblings = children.get(run.anchor.runId);
    if (siblings === undefined) children.set(run.anchor.runId, [run]);
    else siblings.push(run);
  }
  for (const siblings of children.values()) {
    siblings.sort((a: InsertOrder, b: InsertOrder) => compareInsertOrder(a, b));
  }

  const spans: RunSpan[] = [];
  const out: string[] = [];
  const visited = new Set<string>();

  const emit = (runId: string, offset: number): void => {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.runId === runId && last.offset + last.length === offset) {
      spans[spans.length - 1] = { runId, offset: last.offset, length: last.length + 1 };
    } else {
      spans.push({ runId, offset, length: 1 });
    }
  };

  const render = (run: RunCell): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);

    const anchored = children.get(run.id) ?? [];
    const runCuts = cuts.get(run.id) ?? [];
    let childIndex = 0;
    let cutIndex = 0;

    // Emit runs anchored at or before `offset`, then the character at
    // `offset` itself if no cut covers it. Cuts and inserts both apply at
    // retracted positions: inserts survive, the run's own chars do not.
    const renderAt = (offset: number): void => {
      while (childIndex < anchored.length && anchored[childIndex]!.anchor.offset <= offset) {
        render(anchored[childIndex]!);
        childIndex += 1;
      }
    };

    for (let offset = 0; offset <= run.text.length; offset += 1) {
      renderAt(offset);
      if (offset === run.text.length) break;

      while (cutIndex < runCuts.length && runCuts[cutIndex]!.to <= offset) cutIndex += 1;
      const covered =
        cutIndex < runCuts.length &&
        runCuts[cutIndex]!.from <= offset &&
        offset < runCuts[cutIndex]!.to;

      if (!covered) {
        out.push(run.text[offset]!);
        emit(run.id, offset);
      }
    }
  };

  for (const rootChild of children.get(ROOT_ID) ?? []) render(rootChild);

  return {
    cells,
    runs,
    cuts,
    index: { spans, totalLength: out.length },
    text: out.join(""),
  };
};

/** The visible document text. */
export const reconstruct = (state: DocState): string => state.text;

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

/** O(spans) lookup: which run (and run-offset) contains a document position. */
export const lookupPosition = (
  index: PositionIndex,
  position: number,
): PositionLookup | undefined => {
  if (position < 0 || position >= index.totalLength) return undefined;

  let cumulative = 0;
  for (let i = 0; i < index.spans.length; i += 1) {
    const span = index.spans[i]!;
    if (position < cumulative + span.length) {
      return {
        runId: span.runId,
        offset: span.offset + (position - cumulative),
        spanIndex: i,
      };
    }
    cumulative += span.length;
  }

  return undefined;
};

/**
 * Absolute document position of `(runId, offset)`. `offset` may equal the
 * run's visible end for a span, but only a position actually present in the
 * index resolves.
 */
export const runOffsetToPosition = (
  index: PositionIndex,
  runId: string,
  offset: number,
): number | undefined => {
  let cumulative = 0;
  for (const span of index.spans) {
    if (span.runId === runId && offset >= span.offset && offset < span.offset + span.length) {
      return cumulative + (offset - span.offset);
    }
    cumulative += span.length;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Cell ids
// ---------------------------------------------------------------------------

/** Separator between the HLC and the actor id in a run id. */
const ID_SEPARATOR = ":";

/** Suffix that distinguishes a cut id from a run id at the same stamp. */
const CUT_SUFFIX = ":cut";

/**
 * Build a run id from the write that created it. `unique` discriminates two
 * writes from the same author at the same stamp (two tabs of one actor);
 * a seeded cell that only one writer creates may omit it.
 */
export const makeRunId = (stamp: HLCTimestamp, author: string, unique?: string): string =>
  unique === undefined
    ? `${stamp}${ID_SEPARATOR}${author}`
    : `${stamp}${ID_SEPARATOR}${author}${ID_SEPARATOR}${unique}`;

/**
 * Build a cut id from the write and the range it retracts. Two cuts with the
 * same stamp, author, and range are the same logical cut, so the id is
 * stable; a different range (even from the same write's clock) is a
 * different id, so one tab can never rewrite another's cut.
 */
export const makeCutId = (
  stamp: HLCTimestamp,
  author: string,
  runId: string,
  from: number,
  to: number,
): string => `${stamp}${ID_SEPARATOR}${author}${CUT_SUFFIX}:${from}-${to}:${runId}`;

/** Parse a run or cut id back into its stamp + author. Returns null for ROOT. */
export const parseRunId = (
  id: string,
): { readonly stamp: HLCTimestamp; readonly author: string } | null => {
  if (id === ROOT_ID) return null;
  const firstColon = id.indexOf(ID_SEPARATOR);
  if (firstColon <= 0) return null;
  const stamp = id.slice(0, firstColon) as HLCTimestamp;
  let author = id.slice(firstColon + 1);
  const cutIdx = author.indexOf(`${CUT_SUFFIX}:`);
  if (cutIdx !== -1) author = author.slice(0, cutIdx);
  const runSuffixIdx = author.indexOf(`${ID_SEPARATOR}run_`);
  if (runSuffixIdx !== -1) author = author.slice(0, runSuffixIdx);
  return { stamp, author };
};

/**
 * Total order over runs. Offsets first, then newer write first. Kept as a
 * named export because callers reason about sibling order directly; the
 * projection uses the same comparator.
 */
export const compareRuns = (a: InsertOrder, b: InsertOrder): number => compareInsertOrder(a, b);

// ---------------------------------------------------------------------------
// Applying cells
// ---------------------------------------------------------------------------

/**
 * Structural equality of two cells, independent of how a peer serialized
 * their object keys. The id, author, and stamp pin the write; the remaining
 * fields pin the content.
 */
export const cellValuesEqual = (a: TextCell, b: TextCell): boolean => {
  if (a === b) return true;
  if (a.kind !== b.kind || a.id !== b.id || a.author !== b.author || a.stamp !== b.stamp) {
    return false;
  }
  if (a.kind === "run" && b.kind === "run") {
    return (
      a.text === b.text && a.anchor.runId === b.anchor.runId && a.anchor.offset === b.anchor.offset
    );
  }
  if (a.kind === "cut" && b.kind === "cut") {
    return a.runId === b.runId && a.from === b.from && a.to === b.to;
  }
  return false;
};

/** Same key, same write, same cell: a re-delivery, not a rewrite. */
const sameCell = (a: CellFieldValue, b: CellFieldValue): boolean =>
  a === b || (a.hlc === b.hlc && a.update_id === b.update_id && cellValuesEqual(a.value, b.value));

/** Pick the winning envelope for one key under the wire's leaf rule. */
const pickCell = (a: CellFieldValue, b: CellFieldValue): CellFieldValue => {
  if (sameCell(a, b)) return a;
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc > 0 ? a : b;
  return b.update_id >= a.update_id ? b : a;
};

/**
 * Merge incoming cells into a projected state. Keys are append-only, so a
 * re-delivered cell is a no-op; if a peer ever rewrites one, the wire's leaf
 * rule decides and the result is still delivery-order independent.
 */
export const applyCellFields = (
  state: DocState,
  incoming: ReadonlyMap<string, CellFieldValue>,
): DocState => {
  let merged: Map<string, CellFieldValue> | undefined;
  for (const [id, field] of incoming) {
    const previous = (merged ?? state.cells).get(id);
    const next = previous === undefined ? field : pickCell(previous, field);
    if (next === previous) continue;
    if (merged === undefined) merged = new Map(state.cells);
    merged.set(id, next);
  }
  return merged === undefined ? state : project(merged);
};
