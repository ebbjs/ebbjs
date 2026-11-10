/**
 * Convergence property — N actors, a legal random operation sequence, every
 * delivery order.
 *
 * The generator is seeded, so a failure is reproducible. "Legal" means every
 * operation is one the public API accepts against the actor's own replica:
 * an insert at a visible position, a delete of a real run range, or an extend
 * at a run's end. The assertion is on the projected text and the cell ids, not
 * on replica equality — replicas can agree on text nobody wrote.
 */

import { describe, expect, it } from "vitest";
import {
  componentField,
  format,
  mergeFieldValue,
  pack,
  type Action,
  type FieldValue,
  type HLCTimestamp,
} from "@ebbjs/core";
import { DOC_CONTENT_FIELD, lookupPosition, TextDocument, type RunCell } from "@ebbjs/schema";

const hlc = (ts: number): HLCTimestamp => format(pack(BigInt(ts), 0n));

/** Deterministic mulberry32. */
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: () => number, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)]!;

const contentOf = (action: Action): FieldValue | undefined => {
  const update = action.updates.find(
    (candidate) =>
      candidate.method !== "delete" && componentField(candidate.component) === DOC_CONTENT_FIELD,
  );
  if (update === undefined || update.method === "drop" || update.method === "delete") {
    return undefined;
  }
  return update.data;
};

const mergedContent = (actions: readonly Action[], base: FieldValue): FieldValue => {
  let merged = base;
  for (const action of actions) {
    for (const update of action.updates) {
      if (update.method === "drop" || update.method === "delete") continue;
      if (componentField(update.component) !== DOC_CONTENT_FIELD) continue;
      merged = mergeFieldValue(merged, update.data);
    }
  }
  return merged;
};

const seed = (): { doc: TextDocument; content: FieldValue } => {
  const doc = new TextDocument({ docId: "doc_prop", actorId: "actor_seed" });
  doc.localInsert("the quick brown fox", { hlc: hlc(1) });
  doc.localInsert(" jumps", { hlc: hlc(2) });
  doc.localInsert(" over the lazy dog", { hlc: hlc(3) });
  return { doc, content: mergedContent(doc.pendingActions(), { map: {} }) };
};

/** One legal operation against `doc`'s current projection. */
const applyRandomOp = (doc: TextDocument, rng: () => number): void => {
  const runs = [...doc.docState.runs.values()];
  if (runs.length === 0) {
    doc.localInsert("x");
    return;
  }

  const kind = rng();
  if (kind < 0.4) {
    const position = Math.floor(rng() * (doc.text.length + 1));
    const target =
      doc.text.length === 0
        ? undefined
        : lookupPosition(doc.docState.index, Math.min(position, doc.text.length - 1));
    if (target === undefined) {
      doc.localInsert("x");
      return;
    }
    doc.localInsert(pick(rng, ["a", "bb", " c", "!"]), {
      afterRun: target.runId,
      splitParentAt: target.offset + (position < doc.text.length ? 1 : 0),
    });
    return;
  }

  if (kind < 0.7) {
    const run = pick(rng, runs);
    if (run.text.length === 0) return;
    const offset = Math.floor(rng() * run.text.length);
    const count = 1 + Math.floor(rng() * (run.text.length - offset));
    doc.localDelete({ runId: run.id, offset, count });
    return;
  }

  const run = pick(rng, runs) as RunCell;
  doc.localExtend({ runId: run.id, appendText: pick(rng, ["z", "++", " tail"]) });
};

const permutations = <T>(values: readonly T[]): T[][] => {
  if (values.length <= 1) return [[...values]];
  const out: T[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([value, ...tail]);
  });
  return out;
};

describe("convergence property", () => {
  it("three actors, random legal edits, every delivery order projects the same view", () => {
    const rng = prng(764);
    const base = seed();
    const actors = ["actor_a", "actor_b", "actor_c"];
    const replicas = actors.map((actorId) => {
      const doc = new TextDocument({ docId: "doc_prop", actorId });
      doc.hydrate(base.content);
      return doc;
    });

    const batches = replicas.map((doc) => {
      for (let op = 0; op < 6; op += 1) applyRandomOp(doc, rng);
      return doc.pendingActions();
    });

    const all = batches.flat();
    const baseIds = Object.keys((base.content as { map: object }).map);
    const newIds = all.flatMap((action) => Object.keys((contentOf(action) as { map: object }).map));
    const expectedIds = [...new Set([...baseIds, ...newIds])].sort();

    // Every delivery order, from a fresh replica hydrated at the shared start.
    for (const order of permutations([0, 1, 2])) {
      const doc = new TextDocument({ docId: "doc_prop", actorId: "observer" });
      doc.hydrate(base.content);
      for (const index of order) doc.applyActions(batches[index]!);
      expect([...doc.docState.cells.keys()].sort()).toEqual(expectedIds);

      // Local-then-remote for the observer: applying the same batches again
      // is a no-op, and the projection does not change.
      const text = doc.text;
      doc.applyActions(batches[order[0]!]!);
      expect(doc.text).toBe(text);
    }

    // The merged cell map projects the same view in either merge order.
    const forward = mergedContent(all, base.content);
    const reverse = mergedContent([...all].reverse(), base.content);
    const a = new TextDocument({ docId: "doc_prop", actorId: "a" });
    const b = new TextDocument({ docId: "doc_prop", actorId: "b" });
    a.hydrate(forward);
    b.hydrate(reverse);
    expect(a.text).toBe(b.text);

    // Local-then-remote on each actor's own replica.
    for (let i = 0; i < replicas.length; i += 1) {
      const doc = replicas[i]!;
      for (let j = 0; j < batches.length; j += 1) {
        if (j !== i) doc.applyActions(batches[j]!);
      }
      expect(doc.text).toBe(a.text);
    }
  });
});
