/**
 * TextDocument tests — the user-facing facade over the cell model.
 *
 * Covers hydration (merged content), local edits as batches of new cells,
 * delivery as re-projection, the pending queue, the registry, and #762's
 * four same-run reproductions (now ordinary passing fixtures).
 */

import { describe, expect, it } from "vitest";
import {
  format,
  mergeFieldValue,
  pack,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import {
  CURRENT_TEXT_VERSION,
  DOC_CONTENT_FIELD,
  DOC_VERSION_FIELD,
  DocumentVersionError,
  makeRunId,
  TextDocument,
  TextDocumentRegistry,
  versionField,
  type AppliedUpdate,
  type CutCell,
  type RunCell,
} from "@ebbjs/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOC_ID = "doc_1";
const BASE_TEXT = "I think I can";
const BASE_ACTOR = "actor_a";

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const contentOf = (update: Update): FieldValue | undefined => {
  const data = update.data;
  if (data === null || typeof data !== "object" || !("fields" in data)) return undefined;
  return data.fields[DOC_CONTENT_FIELD];
};

/** Fold a batch of Actions into one `content` map, using the wire's merge rule. */
const mergedContent = (actions: readonly Action[], base?: FieldValue): FieldValue => {
  let merged = base;
  for (const action of actions) {
    for (const update of action.updates) {
      const incoming = contentOf(update);
      if (incoming !== undefined) merged = mergeFieldValue(merged, incoming);
    }
  }
  if (merged === undefined) throw new Error("action batch carries no content field");
  return merged;
};

const cellsOf = (doc: TextDocument): readonly string[] => [...doc.docState.cells.keys()];

const runOf = (doc: TextDocument, id: string): RunCell | undefined => doc.docState.runs.get(id);

const cutsOf = (doc: TextDocument): readonly CutCell[] =>
  [...doc.docState.cells.values()]
    .map((field) => field.value)
    .filter((cell): cell is CutCell => cell.kind === "cut");

/** A replica seeded with a single root run holding BASE_TEXT. */
const seedBase = (): { readonly content: FieldValue; readonly runId: string } => {
  const doc = new TextDocument({ docId: DOC_ID, actorId: BASE_ACTOR });
  const runId = doc.localInsert(BASE_TEXT, { hlc: makeHlc(1) });
  if (runId === null) throw new Error("failed to seed the base run");
  return { content: mergedContent(doc.pendingActions()), runId };
};

const openReplica = (content: FieldValue, actorId: string): TextDocument => {
  const doc = new TextDocument({ docId: DOC_ID, actorId });
  doc.hydrate(content, versionField(makeHlc(1), "seed"));
  return doc;
};

/** Build an external Action carrying new cells. */
const actionFrom = (doc: TextDocument, updates: Update[]): Action => ({
  id: `act_${Math.random().toString(36).slice(2)}`,
  actor_id: doc.actorId,
  hlc: makeHlc(999),
  gsn: 1,
  updates,
});

const cellUpdate = (
  cells: readonly (RunCell | CutCell)[],
  opts: { docId?: string; subjectType?: string; hlc?: HLCTimestamp; version?: number } = {},
): Update => {
  const t = opts.hlc ?? makeHlc(999);
  const updateId = `u_${cells[0]?.id ?? "none"}`;
  return {
    id: updateId,
    subject_id: opts.docId ?? DOC_ID,
    subject_type: opts.subjectType ?? "text_document",
    method: "patch",
    data: {
      fields: {
        [DOC_CONTENT_FIELD]: {
          map: Object.fromEntries(
            cells.map((cell) => [cell.id, { value: cell, update_id: updateId, hlc: cell.stamp }]),
          ),
        },
        [DOC_VERSION_FIELD]: versionField(t, updateId, opts.version),
      },
    },
  };
};

const peerRun = (
  doc: TextDocument,
  text: string,
  anchor: RunCell["anchor"],
  id: string,
): RunCell => ({
  kind: "run",
  id,
  text,
  author: doc.actorId,
  stamp: makeHlc(500),
  anchor,
});

// ---------------------------------------------------------------------------
// Construction & hydration
// ---------------------------------------------------------------------------

describe("TextDocument — constructor", () => {
  it("starts empty", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    expect(doc.docId).toBe(DOC_ID);
    expect(doc.actorId).toBe("a");
    expect(doc.docType).toBe("text_document");
    expect(doc.text).toBe("");
    expect(doc.docState.cells.size).toBe(0);
    expect(doc.rootRunId).toBe("ROOT");
  });
});

describe("hydrate", () => {
  it("applies a content map to the projection", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    expect(doc.text).toBe(BASE_TEXT);
  });

  it("is a no-op for the same content version", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    const before = doc.docState;
    doc.hydrate(seed.content, versionField(makeHlc(1), "seed"));
    expect(doc.docState).toBe(before);
  });

  it("does not rewind a local edit from an older content version", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    doc.localInsert("!", { afterRun: seed.runId, splitParentAt: BASE_TEXT.length });
    expect(doc.text).toBe(`${BASE_TEXT}!`);

    doc.hydrate(seed.content, versionField(makeHlc(1), "seed"));
    expect(doc.text).toBe(`${BASE_TEXT}!`);
  });

  it("merges a newer content version", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    const peer = peerRun(doc, "X", { runId: seed.runId, offset: 7 }, "peer-run");
    doc.hydrate(
      mergeFieldValue(seed.content, {
        map: { [peer.id]: { value: peer, update_id: "u_peer", hlc: peer.stamp } },
      }),
      versionField(makeHlc(2), "u_peer"),
    );
    expect(doc.text).toBe("I thinkX I can");
  });

  it("fails loudly for an unknown version", () => {
    const seed = seedBase();
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    expect(() => doc.hydrate(seed.content, versionField(makeHlc(1), "u", 999))).toThrow(
      DocumentVersionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Local edits
// ---------------------------------------------------------------------------

describe("TextDocument.localInsert", () => {
  it("applies locally and queues one action", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const runId = doc.localInsert("hello", { hlc: makeHlc(2) });

    expect(runId?.startsWith(`${makeRunId(makeHlc(2), "a")}:run_`)).toBe(true);
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toHaveLength(1);
    expect(contentOf(doc.pendingActions()[0]!.updates[0]!)).toBeDefined();
  });

  it("anchors a default insert at ROOT", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const runId = doc.localInsert("hello", { hlc: makeHlc(2) })!;
    expect(runOf(doc, runId)?.anchor).toEqual({ runId: "ROOT", offset: 0 });
  });

  it("anchors a mid-run insert without rewriting the parent", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    const before = runOf(doc, seed.runId);

    const runId = doc.localInsert("X", {
      afterRun: seed.runId,
      splitParentAt: 7,
      hlc: makeHlc(3),
    })!;

    expect(doc.text).toBe("I thinkX I can");
    expect(runOf(doc, seed.runId)).toEqual(before);
    expect(runOf(doc, runId)?.anchor).toEqual({ runId: seed.runId, offset: 7 });
    expect(cellsOf(doc)).toHaveLength(2);
  });

  it("rejects an offset outside the parent run", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    expect(doc.localInsert("X", { afterRun: seed.runId, splitParentAt: -1 })).toBeNull();
    expect(
      doc.localInsert("X", { afterRun: seed.runId, splitParentAt: BASE_TEXT.length + 1 }),
    ).toBeNull();
  });

  it("rejects an unknown parent run", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    expect(doc.localInsert("X", { afterRun: "missing" })).toBeNull();
  });

  it("fires onUpdate for the new run", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const runId = doc.localInsert("hello", { hlc: makeHlc(2) })!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cellId: runId, kind: "insert" });
  });

  it("sequential inserts produce the typed order", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    let last = doc.localInsert("a", { hlc: makeHlc(2) })!;
    last = doc.localInsert("b", { afterRun: last, hlc: makeHlc(3) })!;
    doc.localInsert("c", { afterRun: last, hlc: makeHlc(4) });
    expect(doc.text).toBe("abc");
  });
});

describe("TextDocument.localDelete", () => {
  it("adds one cut cell and queues an action", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    const actionId = doc.localDelete({ runId: seed.runId, offset: 2, count: 5, hlc: makeHlc(3) });

    expect(actionId).not.toBeNull();
    expect(doc.text).toBe("I  I can");
    expect(cutsOf(doc)).toHaveLength(1);
    expect(cutsOf(doc)[0]).toMatchObject({ runId: seed.runId, from: 2, to: 7 });
    expect(runOf(doc, seed.runId)?.text).toBe(BASE_TEXT);
  });

  it("rejects an invalid range or unknown run", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    expect(doc.localDelete({ runId: seed.runId, offset: -1, count: 1 })).toBeNull();
    expect(doc.localDelete({ runId: seed.runId, offset: 0, count: 0 })).toBeNull();
    expect(doc.localDelete({ runId: seed.runId, offset: 12, count: 5 })).toBeNull();
    expect(doc.localDelete({ runId: "missing", offset: 0, count: 1 })).toBeNull();
  });

  it("fires onUpdate as a cut", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    doc.localDelete({ runId: seed.runId, offset: 0, count: 1, hlc: makeHlc(3) });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("cut");
  });

  it("stamps the cut with the edit's write, never the run's", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    const run = runOf(doc, seed.runId)!;
    doc.localDelete({ runId: seed.runId, offset: 2, count: 5, hlc: makeHlc(50) });

    const committed = cutsOf(doc)[0]!;
    expect(committed.stamp).toBe(makeHlc(50));
    expect(committed.author).toBe("actor_b");
    // A cell that inherited its parent's stamp would fail this: provenance is
    // the write's, not the run's.
    expect(committed.stamp).not.toBe(run.stamp);
  });

  it("two cuts union, so overlapping deletes are idempotent", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_b");
    doc.localDelete({ runId: seed.runId, offset: 2, count: 5, hlc: makeHlc(3) });
    doc.localDelete({ runId: seed.runId, offset: 4, count: 5, hlc: makeHlc(4) });
    expect(doc.text).toBe("I  can");
  });
});

describe("TextDocument.localExtend", () => {
  it("adds a new run at the end of the named run without rewriting it", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    const parentBefore = runOf(doc, seed.runId);

    const actionId = doc.localExtend({ runId: seed.runId, appendText: ".", hlc: makeHlc(3) });

    expect(actionId).not.toBeNull();
    expect(doc.text).toBe(`${BASE_TEXT}.`);
    expect(runOf(doc, seed.runId)).toEqual(parentBefore);
    expect(cellsOf(doc)).toHaveLength(2);

    const extension = [...doc.docState.runs.values()].find((run) => run.id !== seed.runId)!;
    expect(extension.anchor).toEqual({ runId: seed.runId, offset: BASE_TEXT.length });
    expect(extension.stamp).toBe(makeHlc(3));
  });

  it("fires onUpdate as an insert", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    doc.localExtend({ runId: seed.runId, appendText: ".", hlc: makeHlc(3) });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("insert");
  });

  it("rejects an empty append or an unknown run", () => {
    const seed = seedBase();
    const doc = openReplica(seed.content, "actor_a");
    expect(doc.localExtend({ runId: seed.runId, appendText: "" })).toBeNull();
    expect(doc.localExtend({ runId: "missing", appendText: "x" })).toBeNull();
  });

  it("extend and an insert round-trip through the wire in the exact text", () => {
    const seed = seedBase();
    const a = openReplica(seed.content, "actor_a");
    const b = openReplica(seed.content, "actor_b");

    a.localExtend({ runId: seed.runId, appendText: ".", hlc: makeHlc(3) });
    b.localInsert("X", { afterRun: seed.runId, splitParentAt: 7, hlc: makeHlc(4) });
    a.applyActions(b.pendingActions());
    b.applyActions(a.pendingActions());

    expect(a.text).toBe("I thinkX I can.");
    expect(b.text).toBe(a.text);
  });
});

describe("TextDocument.local edit ids", () => {
  it("does not reuse an extend action id across instances of the same actor", () => {
    const seed = seedBase();
    const first = openReplica(seed.content, "actor_a");
    const second = openReplica(seed.content, "actor_a");

    const firstId = first.localExtend({ runId: seed.runId, appendText: ".", hlc: makeHlc(3) });
    const secondId = second.localExtend({ runId: seed.runId, appendText: "?", hlc: makeHlc(3) });
    expect(firstId).not.toBe(secondId);
  });

  it("does not reuse a delete action id across instances of the same actor", () => {
    const seed = seedBase();
    const first = openReplica(seed.content, "actor_a");
    const second = openReplica(seed.content, "actor_a");

    const firstId = first.localDelete({ runId: seed.runId, offset: 0, count: 1, hlc: makeHlc(3) });
    const secondId = second.localDelete({
      runId: seed.runId,
      offset: 0,
      count: 1,
      hlc: makeHlc(3),
    });
    expect(firstId).not.toBe(secondId);
  });
});

// ---------------------------------------------------------------------------
// Delivered actions
// ---------------------------------------------------------------------------

describe("TextDocument.applyActions", () => {
  it("projects an external run", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const base = peerRun(doc, "hello", { runId: "ROOT", offset: 0 }, "r1");
    const action = actionFrom(doc, [cellUpdate([base])]);

    doc.applyActions([action]);
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toEqual([]);
  });

  it("fires one event per newly delivered cell, attributed to its source action", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const first = peerRun(doc, "a", { runId: "ROOT", offset: 0 }, "r1");
    const second = peerRun(doc, "b", { runId: "r1", offset: 1 }, "r2");
    const actionA = actionFrom(doc, [cellUpdate([first])]);
    const actionB = actionFrom(doc, [cellUpdate([second])]);

    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));
    doc.applyActions([actionA, actionB]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ cellId: "r1", kind: "insert" });
    expect(events[0]?.action).toBe(actionA);
    expect(events[1]).toMatchObject({ cellId: "r2", kind: "insert" });
    expect(events[1]?.action).toBe(actionB);
  });

  it("ignores actions for another document type", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const base = peerRun(doc, "hello", { runId: "ROOT", offset: 0 }, "r1");
    doc.applyActions([actionFrom(doc, [cellUpdate([base], { subjectType: "other" })])]);
    expect(doc.text).toBe("");
  });

  it("is idempotent on re-delivery", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const base = peerRun(doc, "hello", { runId: "ROOT", offset: 0 }, "r1");
    const action = actionFrom(doc, [cellUpdate([base])]);

    doc.applyActions([action]);
    const state = doc.docState;
    doc.applyActions([action]);
    expect(doc.docState).toBe(state);
  });

  it("fails on a document from an unknown version", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const base = peerRun(doc, "hello", { runId: "ROOT", offset: 0 }, "r1");
    const action = actionFrom(doc, [cellUpdate([base], { version: 999 })]);
    expect(() => doc.applyActions([action])).toThrow(DocumentVersionError);
  });

  it("applyUpdate wraps a single Update", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    const base = peerRun(doc, "hi", { runId: "ROOT", offset: 0 }, "r1");
    doc.applyUpdate(cellUpdate([base]));
    expect(doc.text).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// Pending queue
// ---------------------------------------------------------------------------

describe("TextDocument.pendingActions + ackPending", () => {
  it("accumulates local edits and removes them by id", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    let runId = doc.localInsert("a", { hlc: makeHlc(2) })!;
    runId = doc.localInsert("b", { afterRun: runId, hlc: makeHlc(3) })!;

    const pending = doc.pendingActions();
    expect(pending).toHaveLength(2);
    doc.ackPending([pending[0]!.id]);
    expect(doc.pendingActions().map((action) => action.id)).toEqual([pending[1]!.id]);
  });

  it("clearPending removes all", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    doc.localInsert("a", { hlc: makeHlc(2) });
    doc.clearPending();
    expect(doc.pendingActions()).toEqual([]);
  });
});

describe("TextDocument.reset", () => {
  it("returns to empty state", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    doc.localInsert("hello", { hlc: makeHlc(2) });
    doc.reset();
    expect(doc.text).toBe("");
    expect(doc.docState.cells.size).toBe(0);
    expect(doc.pendingActions()).toEqual([]);
  });

  it("keeps the local clock monotonic, so a post-reset edit is accepted", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    doc.localInsert("a");
    doc.reset();
    // A reset rewinds content, not the HLC: reusing an earlier stamp would
    // mint an existing run id and be refused as a rewrite.
    expect(doc.localInsert("b")).not.toBeNull();
    expect(doc.text).toBe("b");
  });
});

describe("TextDocumentRegistry", () => {
  it("open returns the same instance for the same docId + actor", () => {
    const registry = new TextDocumentRegistry();
    expect(registry.open({ docId: "d", actorId: "a" })).toBe(
      registry.open({ docId: "d", actorId: "a" }),
    );
  });

  it("open returns a new instance when the actor or doc differs", () => {
    const registry = new TextDocumentRegistry();
    const first = registry.open({ docId: "d", actorId: "a" });
    expect(registry.open({ docId: "d", actorId: "b" })).not.toBe(first);
    expect(registry.open({ docId: "e", actorId: "a" })).not.toBe(first);
  });

  it("close and list", () => {
    const registry = new TextDocumentRegistry();
    registry.open({ docId: "d", actorId: "a" });
    expect(registry.list()).toHaveLength(1);
    expect(registry.close("d")).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance — both delivery orders converge on the exact text
// ---------------------------------------------------------------------------

describe("acceptance — concurrent edits converge", () => {
  it("two clients typing at the end converge", () => {
    const seed = seedBase();
    const a = openReplica(seed.content, "actor_a");
    const b = openReplica(seed.content, "actor_b");

    const aRun = a.localInsert("!", { hlc: makeHlc(3) })!;
    const bRun = b.localInsert("?", { hlc: makeHlc(4) })!;
    a.applyActions(b.pendingActions());
    b.applyActions(a.pendingActions());

    expect(a.text).toBe(b.text);
    expect(a.text).toContain("!");
    expect(a.text).toContain("?");
    expect([...a.docState.runs.keys()].sort()).toEqual([seed.runId, aRun, bRun].sort());
  });
});

// ---------------------------------------------------------------------------
// #762's four reproductions — the acceptance fixtures
// ---------------------------------------------------------------------------

const BASE_TEXT_762 = "I think I can";

type Scenario = {
  readonly name: string;
  readonly editA: (doc: TextDocument, runId: string) => void;
  readonly editB: (doc: TextDocument, runId: string) => void;
  readonly localTextA: string;
  readonly localTextB: string;
  readonly expectedText: string;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "insert vs insert inside one run",
    editA: (doc, runId) => {
      doc.localInsert("X", { afterRun: runId, splitParentAt: 7 });
    },
    editB: (doc, runId) => {
      doc.localInsert("Y", { afterRun: runId, splitParentAt: 9 });
    },
    localTextA: "I thinkX I can",
    localTextB: "I think IY can",
    expectedText: "I thinkX IY can",
  },
  {
    name: "partial delete vs mid-run insert",
    editA: (doc, runId) => {
      doc.localDelete({ runId, offset: 2, count: 5 });
    },
    editB: (doc, runId) => {
      doc.localInsert("X", { afterRun: runId, splitParentAt: 7 });
    },
    localTextA: "I  I can",
    localTextB: "I thinkX I can",
    expectedText: "I X I can",
  },
  {
    name: "two partial deletes in one run",
    editA: (doc, runId) => {
      doc.localDelete({ runId, offset: 2, count: 5 });
    },
    editB: (doc, runId) => {
      doc.localDelete({ runId, offset: 8, count: 5 });
    },
    localTextA: "I  I can",
    localTextB: "I think ",
    expectedText: "I  ",
  },
  {
    name: "extend vs mid-run insert",
    editA: (doc, runId) => {
      doc.localExtend({ runId, appendText: "." });
    },
    editB: (doc, runId) => {
      doc.localInsert("X", { afterRun: runId, splitParentAt: 7 });
    },
    localTextA: "I think I can.",
    localTextB: "I thinkX I can",
    expectedText: "I thinkX I can.",
  },
];

const editOnBothReplicas = (scenario: Scenario) => {
  const seed = seedBase();
  const a = openReplica(seed.content, "actor_a");
  const b = openReplica(seed.content, "actor_b");
  scenario.editA(a, seed.runId);
  scenario.editB(b, seed.runId);
  return { seed, a, b, aActions: a.pendingActions(), bActions: b.pendingActions() };
};

/** A applies B's actions, B applies A's: both delivery orders. */
const textAfterReplay = (scenario: Scenario) => {
  const { a, b, aActions, bActions } = editOnBothReplicas(scenario);
  a.applyActions(bActions);
  b.applyActions(aActions);
  return { aAppliesB: a.text, bAppliesA: b.text };
};

/** Hydrate a fresh replica from the merged cell map, merged in both orders. */
const textFromMergedCells = (scenario: Scenario) => {
  const { seed, aActions, bActions } = editOnBothReplicas(scenario);
  const aThenB = openReplica(mergedContent([...aActions, ...bActions], seed.content), "observer");
  const bThenA = openReplica(mergedContent([...bActions, ...aActions], seed.content), "observer");
  return { aThenB: aThenB.text, bThenA: bThenA.text };
};

describe("concurrent edits inside one run — fixtures", () => {
  it.each(SCENARIOS)("$name reaches the described local state", (scenario) => {
    const seed = seedBase();
    const a = openReplica(seed.content, "actor_a");
    const b = openReplica(seed.content, "actor_b");

    expect(a.text).toBe(BASE_TEXT_762);
    expect(b.text).toBe(BASE_TEXT_762);

    scenario.editA(a, seed.runId);
    scenario.editB(b, seed.runId);

    expect(a.text).toBe(scenario.localTextA);
    expect(b.text).toBe(scenario.localTextB);
  });
});

describe("concurrent edits inside one run — #762 reproductions", () => {
  describe.each(SCENARIOS)("$name", (scenario) => {
    it("converges on the exact text in both apply orders", () => {
      expect(textAfterReplay(scenario)).toEqual({
        aAppliesB: scenario.expectedText,
        bAppliesA: scenario.expectedText,
      });
    });

    it("projects the merged cell map to the exact text in either merge order", () => {
      expect(textFromMergedCells(scenario)).toEqual({
        aThenB: scenario.expectedText,
        bThenA: scenario.expectedText,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Version surface
// ---------------------------------------------------------------------------

describe("version leaf", () => {
  it("is written by every local edit", () => {
    const doc = new TextDocument({ docId: DOC_ID, actorId: "a" });
    doc.localInsert("a", { hlc: makeHlc(2) });
    const fields = (
      doc.pendingActions()[0]!.updates[0]!.data as {
        fields: Record<string, FieldValue>;
      }
    ).fields;
    expect(fields[DOC_VERSION_FIELD]).toMatchObject({ value: CURRENT_TEXT_VERSION });
  });
});
