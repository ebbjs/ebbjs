/**
 * TextDocument tests — the user-facing facade for the causal-tree field.
 *
 * Covers:
 * - localInsert/localDelete (optimistic local apply + pending queue)
 * - applyActions (external incoming actions, from sync / SSE)
 * - onUpdate event hooks
 * - pendingActions / ackPending queue management
 * - TextDocumentRegistry singleton-per-doc semantics
 * - #762's same-run concurrency reproductions, expected failures until #764
 */

import { describe, expect, it } from "vitest";
import {
  mergeFieldValue,
  pack,
  format,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import {
  DOC_CONTENT_FIELD,
  TextDocument,
  TextDocumentRegistry,
  type AppliedUpdate,
} from "@ebbjs/schema";
import { DEFAULT_DOC_SUBJECT_TYPE } from "@ebbjs/schema";
import type { RunNode } from "@ebbjs/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const makeRun = (ts: number, actorId: string, text: string, parentId: string): RunNode => {
  const hlc = makeHlc(ts);
  return { id: `${hlc}:${actorId}`, hlc, actorId, text, parentId, deleted: false };
};

const makeInsertAction = (run: RunNode): Action => ({
  id: `act_${run.id}`,
  actor_id: run.actorId,
  hlc: run.hlc,
  gsn: 0,
  updates: [
    {
      id: `upd_${run.id}`,
      subject_id: "doc_1",
      subject_type: DEFAULT_DOC_SUBJECT_TYPE,
      method: "patch",
      data: {
        fields: {
          content: {
            map: {
              [run.id]: {
                value: run,
                update_id: `upd_${run.id}`,
                hlc: run.hlc,
              },
            },
          },
        },
      },
    } as never,
  ],
});

// ---------------------------------------------------------------------------
// Hydration from a materialized content map
// ---------------------------------------------------------------------------

const contentField = (runs: readonly RunNode[]): FieldValue => ({
  map: Object.fromEntries(
    runs.map((run) => [run.id, { value: run, update_id: `upd_${run.id}`, hlc: run.hlc }]),
  ),
});

describe("hydrate", () => {
  it("applies a content map to the document state", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
    const root = makeRun(1, "actor_1", "hello", "ROOT");

    doc.hydrate(contentField([root]));

    expect(doc.text).toBe("hello");
  });

  it("is a no-op for the same content version and unchanged state", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
    const content = contentField([makeRun(1, "actor_1", "hello", "ROOT")]);

    doc.hydrate(content);
    const state = doc.docState;
    doc.hydrate(content);

    expect(doc.docState).toBe(state);
  });

  it("re-hydrates after a local edit without rewinding it", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
    const root = makeRun(1, "actor_1", "hello", "ROOT");
    const content = contentField([root]);

    doc.hydrate(content);
    doc.localInsert("!", { afterRun: root.id });
    const afterEdit = doc.text;

    doc.hydrate(content);

    expect(doc.text).toBe(afterEdit);
  });

  it("applies a newer content version", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "actor_1" });
    const root = makeRun(1, "actor_1", "hello", "ROOT");
    const next = makeRun(2, "actor_2", " world", root.id);

    doc.hydrate(contentField([root]));
    doc.hydrate(contentField([root, next]));

    expect(doc.text).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Constructor / read accessors
// ---------------------------------------------------------------------------

describe("TextDocument — constructor", () => {
  it("starts empty", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    expect(doc.text).toBe("");
    expect(doc.docState.nodes.size).toBe(1); // ROOT only
    expect(doc.pendingActions()).toHaveLength(0);
    expect(doc.rootRunId).toBe("ROOT");
  });
});

// ---------------------------------------------------------------------------
// localInsert
// ---------------------------------------------------------------------------

describe("TextDocument.localInsert", () => {
  it("applies locally and queues an action", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const id = doc.localInsert("hello");

    expect(id).not.toBeNull();
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toHaveLength(1);

    const action = doc.pendingActions()[0]!;
    expect(action.actor_id).toBe("peer-A");
    expect(action.updates).toHaveLength(1);
    expect(action.updates[0]!.subject_id).toBe("doc_1");
    expect(action.updates[0]!.subject_type).toBe("text_document");
    expect(action.updates[0]!.method).toBe("patch");
  });

  it("inserts as child of ROOT by default", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("first");
    const run = doc.docState.nodes.get(doc.docState.children.get("ROOT")![0]!);
    expect(run?.text).toBe("first");
    expect(run?.parentId).toBe("ROOT");
  });

  it("inserts after a specified run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const firstId = doc.localInsert("hello");
    doc.localInsert(" world", { afterRun: firstId! });

    expect(doc.text).toBe("hello world");
  });

  it("applies locally with splitParentAt (splits parent first)", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("abcdef");
    const parentId = doc.docState.children.get("ROOT")![0]!;

    doc.localInsert("XY", { afterRun: parentId, splitParentAt: 3 });

    expect(doc.text).toBe("abcXYdef");
    // Parent should now be "abc" with split-id child "def"
    const parent = doc.docState.nodes.get(parentId)!;
    expect(parent.text).toBe("abc");
  });

  it("rejects invalid splitParentAt (0 or negative)", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("abcdef");
    const parentId = doc.docState.children.get("ROOT")![0]!;

    // splitParentAt must be in [1, text.length). 0 and -1 are invalid.
    expect(doc.localInsert("X", { afterRun: parentId, splitParentAt: 0 })).toBeNull();
    expect(doc.localInsert("X", { afterRun: parentId, splitParentAt: -1 })).toBeNull();
    // Doc state should be unchanged
    expect(doc.text).toBe("abcdef");
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("rejects splitParentAt >= parent text length", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("abcdef");
    const parentId = doc.docState.children.get("ROOT")![0]!;

    expect(doc.localInsert("X", { afterRun: parentId, splitParentAt: 6 })).toBeNull();
    expect(doc.localInsert("X", { afterRun: parentId, splitParentAt: 100 })).toBeNull();
    expect(doc.text).toBe("abcdef");
  });

  it("fires onUpdate listeners for local edits", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const id = doc.localInsert("hello");

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(id);
    expect(events[0]!.kind).toBe("insert");
  });

  it("multiple sequential inserts produce ordered runs", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("a");
    doc.localInsert("b");
    doc.localInsert("c");

    expect(doc.text).toBe("abc");
    expect(doc.pendingActions()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// localDelete
// ---------------------------------------------------------------------------

describe("TextDocument.localDelete", () => {
  it("applies locally and queues an action", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello world")!;

    const actionId = doc.localDelete({ runId, offset: 5, count: 6 });

    expect(actionId).not.toBeNull();
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toHaveLength(2);
  });

  it("returns null for invalid range", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;

    expect(doc.localDelete({ runId, offset: -1, count: 1 })).toBeNull();
    expect(doc.localDelete({ runId, offset: 0, count: 0 })).toBeNull();
    expect(doc.localDelete({ runId, offset: 0, count: 100 })).toBeNull();
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("returns null for nonexistent run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("hello");

    expect(doc.localDelete({ runId: "nonexistent", offset: 0, count: 1 })).toBeNull();
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("fires onUpdate listeners for local deletes", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello world")!;

    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));
    doc.localDelete({ runId, offset: 5, count: 6 });

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(runId);
    expect(events[0]!.kind).toBe("tombstone");
  });
});

// ---------------------------------------------------------------------------
// localExtend
// ---------------------------------------------------------------------------

describe("TextDocument.localExtend", () => {
  it("appends text to an existing run and queues an action", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;

    const actionId = doc.localExtend({ runId, appendText: " world" });

    expect(actionId).not.toBeNull();
    expect(doc.text).toBe("hello world");
    expect(doc.docState.nodes.size).toBe(2); // ROOT + 1 run (extended in place)
    expect(doc.pendingActions()).toHaveLength(2);
  });

  it("emits a single field update for the extended run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;

    doc.localExtend({ runId, appendText: " world" });

    const extendAction = doc.pendingActions()[1]!;
    expect(extendAction.updates).toHaveLength(1);
    // Wire format wraps user-entity fields under `data.fields` so the
    // server's per-field LWW merge handles each run independently.
    const data = extendAction.updates[0]!.data as unknown as {
      fields: { content: { map: Record<string, { value: RunNode }> } };
    };
    const runs = data.fields.content.map;
    // Only the extended run's key appears in the diff.
    const fieldNames = Object.keys(runs);
    expect(fieldNames).toHaveLength(1);
    expect(fieldNames[0]).toBe(runId);
    expect(runs[fieldNames[0]!]!.value.text).toBe("hello world");
  });

  it("fires onUpdate with kind 'extend'", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));
    events.length = 0; // clear the insert event

    doc.localExtend({ runId, appendText: " world" });

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(runId);
    expect(events[0]!.kind).toBe("extend");
  });

  it("returns null for an empty appendText", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;

    expect(doc.localExtend({ runId, appendText: "" })).toBeNull();
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("returns null for a nonexistent run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("hello");

    expect(doc.localExtend({ runId: "nonexistent", appendText: "x" })).toBeNull();
    expect(doc.text).toBe("hello");
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("returns null for a tombstoned run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;
    doc.localDelete({ runId, offset: 0, count: 5 });
    expect(doc.docState.nodes.get(runId)?.deleted).toBe(true);

    expect(doc.localExtend({ runId, appendText: "x" })).toBeNull();
    expect(doc.text).toBe("");
  });

  it("extend survives a roundtrip through applyActions (wire compatibility)", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const runId = doc.localInsert("hello")!;
    doc.localExtend({ runId, appendText: " world" });

    const extendAction = doc.pendingActions()[1]!;

    // A fresh doc receives the extend action — should see "hello world".
    const peer = new TextDocument({ docId: "doc_1", actorId: "peer-B" });
    peer.applyActions([extendAction]);

    expect(peer.text).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// action ids (#285)
// ---------------------------------------------------------------------------

describe("TextDocument action ids (#285)", () => {
  it("does not reuse an extend action id across instances of the same actor", () => {
    const first = new TextDocument({ docId: "doc_1", actorId: "drew" });
    const firstRun = first.localInsert("hello")!;
    first.localExtend({ runId: firstRun, appendText: "!" });

    const second = new TextDocument({ docId: "doc_1", actorId: "drew" });
    const secondRun = second.localInsert("hello")!;
    second.localExtend({ runId: secondRun, appendText: "!" });

    const firstExtendId = first.pendingActions()[1]!.id;
    const secondExtendId = second.pendingActions()[1]!.id;

    expect(firstExtendId).not.toBe(secondExtendId);
  });

  it("does not reuse a delete action id across instances of the same actor", () => {
    const first = new TextDocument({ docId: "doc_1", actorId: "drew" });
    const firstRun = first.localInsert("hello")!;
    first.localDelete({ runId: firstRun, offset: 0, count: 1 });

    const second = new TextDocument({ docId: "doc_1", actorId: "drew" });
    const secondRun = second.localInsert("hello")!;
    second.localDelete({ runId: secondRun, offset: 0, count: 1 });

    const firstDeleteId = first.pendingActions()[1]!.id;
    const secondDeleteId = second.pendingActions()[1]!.id;

    expect(firstDeleteId).not.toBe(secondDeleteId);
  });
});

// ---------------------------------------------------------------------------
// applyActions
// ---------------------------------------------------------------------------

describe("TextDocument.applyActions", () => {
  it("applies an external INSERT_RUN", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const remoteRun = makeRun(1000, "peer-B", "remote", "ROOT");

    doc.applyActions([makeInsertAction(remoteRun)]);

    expect(doc.text).toBe("remote");
    expect(doc.docState.nodes.has(remoteRun.id)).toBe(true);
  });

  it("fires onUpdate listeners with the applied update", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const remoteRun = makeRun(1000, "peer-B", "hello", "ROOT");
    doc.applyActions([makeInsertAction(remoteRun)]);

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(remoteRun.id);
    expect(events[0]!.kind).toBe("insert");
  });

  it("attributes each applied update to its source action, not the first one in the batch", () => {
    // Regression: appliedToEvent used to scan the actions array for the
    // first one carrying a run:* field and attribute every event to it.
    // With two actions in a batch, the second action's events would all
    // be mis-attributed to the first.
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const run1 = makeRun(1000, "peer-B", "first", "ROOT");
    const run2 = makeRun(1001, "peer-C", "second", "ROOT");
    const action1 = makeInsertAction(run1);
    const action2 = makeInsertAction(run2);

    doc.applyActions([action1, action2]);

    expect(events).toHaveLength(2);
    expect(events[0]!.action.id).toBe(action1.id);
    expect(events[0]!.runId).toBe(run1.id);
    expect(events[1]!.action.id).toBe(action2.id);
    expect(events[1]!.runId).toBe(run2.id);
  });

  it("ignores actions for other document/entity scopes (no filter at this level)", () => {
    // TextDocument itself doesn't filter by docId — that's the SyncClient's job.
    // Verify it still applies all run updates correctly.
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.applyActions([
      makeInsertAction(makeRun(1000, "peer-B", "a", "ROOT")),
      makeInsertAction(makeRun(1001, "peer-C", "b", "ROOT")),
    ]);

    expect(doc.text).toBe("ba"); // peer-C > peer-B → b first
  });

  it("is idempotent on duplicate action ids (storage-layer dedup)", () => {
    // TextDocument itself doesn't dedup — duplicate inserts produce duplicate
    // nodes that get ignored by the tree reducer (idempotency at run id).
    // Action-level dedup is the storage adapter's responsibility.
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const run = makeRun(1000, "peer-B", "once", "ROOT");

    doc.applyActions([makeInsertAction(run)]);
    doc.applyActions([makeInsertAction(run)]);

    expect(doc.text).toBe("once");
    expect(doc.docState.nodes.size).toBe(2); // ROOT + 1 run
  });

  it("does not modify pendingActions (external actions don't queue)", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.applyActions([makeInsertAction(makeRun(1000, "peer-B", "remote", "ROOT"))]);

    expect(doc.pendingActions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pendingActions + ackPending
// ---------------------------------------------------------------------------

describe("TextDocument.pendingActions + ackPending", () => {
  it("accumulates local edits in pendingActions", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("a");
    doc.localInsert("b");
    doc.localInsert("c");

    expect(doc.pendingActions()).toHaveLength(3);
  });

  it("ackPending removes by id", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("a");
    doc.localInsert("b");

    const actions = doc.pendingActions();
    doc.ackPending([actions[0]!.id]);

    expect(doc.pendingActions()).toHaveLength(1);
    expect(doc.pendingActions()[0]!.id).toBe(actions[1]!.id);
  });

  it("clearPending removes all", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("a");
    doc.localInsert("b");
    doc.localInsert("c");

    doc.clearPending();
    expect(doc.pendingActions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("TextDocument.reset", () => {
  it("returns to empty state", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    doc.localInsert("hello");
    doc.localInsert("world");

    doc.reset();

    expect(doc.text).toBe("");
    expect(doc.docState.nodes.size).toBe(1);
    expect(doc.pendingActions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("TextDocumentRegistry", () => {
  it("open returns same instance for same docId+actor", () => {
    const reg = new TextDocumentRegistry();
    const a = reg.open({ docId: "doc_1", actorId: "peer-A" });
    const b = reg.open({ docId: "doc_1", actorId: "peer-A" });
    expect(b).toBe(a);
  });

  it("open returns new instance when actor differs", () => {
    const reg = new TextDocumentRegistry();
    const a = reg.open({ docId: "doc_1", actorId: "peer-A" });
    const b = reg.open({ docId: "doc_1", actorId: "peer-B" });
    expect(b).not.toBe(a);
  });

  it("open returns new instance for different docIds", () => {
    const reg = new TextDocumentRegistry();
    const a = reg.open({ docId: "doc_1", actorId: "peer-A" });
    const b = reg.open({ docId: "doc_2", actorId: "peer-A" });
    expect(b).not.toBe(a);
  });

  it("close removes the document", () => {
    const reg = new TextDocumentRegistry();
    reg.open({ docId: "doc_1", actorId: "peer-A" });
    expect(reg.close("doc_1")).toBe(true);
    expect(reg.close("doc_1")).toBe(false);
    expect(reg.get("doc_1")).toBeUndefined();
  });

  it("list returns all open documents", () => {
    const reg = new TextDocumentRegistry();
    reg.open({ docId: "doc_1", actorId: "peer-A" });
    reg.open({ docId: "doc_2", actorId: "peer-A" });
    expect(reg.list()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: applyActions produces same document as POC for same edit sequence
// ---------------------------------------------------------------------------

describe("acceptance — applyActions matches POC for same edit sequence", () => {
  it("two clients typing concurrently converge to the same document", () => {
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    // Peer-A types "hello"
    docA.localInsert("hello");
    // Peer-B types "world" — they exchange actions
    docB.localInsert("world");

    // Cross-apply
    const aActions = docA.pendingActions();
    const bActions = docB.pendingActions();

    docA.applyActions(bActions);
    docB.applyActions(aActions);

    expect(docA.text).toBe(docB.text);
    // Higher actorId first (peer-B > peer-A): "worldhello"
    expect(docA.text).toBe("worldhello");
  });

  it("extended sequence with deletes produces identical docs", () => {
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    docA.localInsert("The quick brown fox");
    const aRun = docA.docState.children.get("ROOT")![0]!;
    docA.localDelete({ runId: aRun, offset: 4, count: 6 }); // remove "quick "

    docB.localInsert("jumps over");

    const aActions = docA.pendingActions();
    const bActions = docB.pendingActions();
    docA.applyActions(bActions);
    docB.applyActions(aActions);

    expect(docA.text).toBe(docB.text);
  });
});

// ---------------------------------------------------------------------------
// Same-run concurrent edits: #762's reproductions (#763)
// ---------------------------------------------------------------------------
//
// Written from #762's report rather than from the implementation: two peers
// editing inside one run at the same time. Each asserts exact text rather than
// replica equality — two replicas can agree on text nobody wrote — and each
// also hydrates from the merged cell map, which is its own read path.
//
// They are the specification #764 has to satisfy. Every fixture is an expected
// failure today; flipping `it.fails` to `it` is #764's definition of done. The
// rebuilt model's properties — convergence, write discipline, no resurrection,
// total order, stamp provenance — are asserted in #764.

const DOC_ID = "doc_1";
const BASE_TEXT = "I think I can";
const BASE_ACTOR = "actor_a";

type Seed = {
  /** The base document as the merged `content` field a peer would receive. */
  readonly content: FieldValue;
  /** Id of the single run holding `BASE_TEXT`. */
  readonly runId: string;
};

type Scenario = {
  readonly name: string;
  readonly editA: (doc: TextDocument, runId: string) => void;
  readonly editB: (doc: TextDocument, runId: string) => void;
  /** What each peer sees after its own optimistic edit, before exchange. */
  readonly localTextA: string;
  readonly localTextB: string;
  /** What both peers must see once the edits have reached each other. */
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

const seedBase = (): Seed => {
  const doc = new TextDocument({ docId: DOC_ID, actorId: BASE_ACTOR });
  // An old HLC keeps the base run distinct from the edits, which would
  // otherwise reuse its id when they land in the same millisecond.
  const runId = doc.localInsert(BASE_TEXT, { hlc: makeHlc(1) });
  if (runId === null) throw new Error("failed to seed the base run");
  return { content: mergedContent(doc.pendingActions()), runId };
};

const openReplica = (seed: Seed, actorId: string): TextDocument => {
  const doc = new TextDocument({ docId: DOC_ID, actorId });
  doc.hydrate(seed.content);
  return doc;
};

const editOnBothReplicas = (scenario: Scenario) => {
  const seed = seedBase();
  const a = openReplica(seed, "actor_a");
  const b = openReplica(seed, "actor_b");
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
  const aThenB = openReplica(
    { ...seed, content: mergedContent([...aActions, ...bActions], seed.content) },
    "observer",
  );
  const bThenA = openReplica(
    { ...seed, content: mergedContent([...bActions, ...aActions], seed.content) },
    "observer",
  );
  return { aThenB: aThenB.text, bThenA: bThenA.text };
};

/**
 * A fixture that never reaches the buggy state would let every expected
 * failure below pass for the wrong reason, so assert the starting point as
 * plain expectations: the base run hydrates, and each local edit is correct
 * before any exchange.
 */
describe("concurrent edits inside one run — fixtures", () => {
  it.each(SCENARIOS)("$name reaches the state #762 describes", (scenario) => {
    const seed = seedBase();
    const a = openReplica(seed, "actor_a");
    const b = openReplica(seed, "actor_b");

    expect(a.text).toBe(BASE_TEXT);
    expect(b.text).toBe(BASE_TEXT);

    scenario.editA(a, seed.runId);
    scenario.editB(b, seed.runId);

    expect(a.text).toBe(scenario.localTextA);
    expect(b.text).toBe(scenario.localTextB);
  });
});

describe("concurrent edits inside one run — #762 reproductions", () => {
  describe.each(SCENARIOS)("$name", (scenario) => {
    it.fails("converges on the exact text in both apply orders", () => {
      expect(textAfterReplay(scenario)).toEqual({
        aAppliesB: scenario.expectedText,
        bAppliesA: scenario.expectedText,
      });
    });

    it.fails("projects the merged cell map to the exact text in either merge order", () => {
      expect(textFromMergedCells(scenario)).toEqual({
        aThenB: scenario.expectedText,
        bThenA: scenario.expectedText,
      });
    });
  });
});
