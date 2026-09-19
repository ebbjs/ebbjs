/**
 * TextDocument tests — the user-facing facade for the causal-tree field.
 *
 * Covers:
 * - localInsert/localDelete (optimistic local apply + pending queue)
 * - applyActions (external incoming actions, from sync / SSE)
 * - onUpdate / onConflict event hooks
 * - pendingActions / ackPending queue management
 * - TextDocumentRegistry singleton-per-doc semantics
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import { TextDocument, TextDocumentRegistry, type AppliedUpdate } from "../text-document";
import { DEFAULT_DOC_SUBJECT_TYPE, formatRunFieldName } from "../wire";
import type { RunNode } from "../tree";

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
        [formatRunFieldName(run.id)]: {
          value: run,
          update_id: `upd_${run.id}`,
          hlc: run.hlc,
        },
      },
    } as never,
  ],
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
    expect(doc.conflicts()).toHaveLength(0);
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
      fields: Record<string, { value: RunNode }>;
    };
    const fields = data.fields;
    // Only the extended run's field appears in the diff.
    const fieldNames = Object.keys(fields);
    expect(fieldNames).toHaveLength(1);
    expect(fieldNames[0]).toBe(formatRunFieldName(runId));
    expect(fields[fieldNames[0]!]!.value.text).toBe("hello world");
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
// onConflict
// ---------------------------------------------------------------------------

describe("TextDocument.onConflict", () => {
  it("fires when concurrent non-trivial Updates target the same run", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });

    // Insert a base run as peer-A
    doc.localInsert("hello");
    expect(doc.text).toBe("hello");

    // Apply two concurrent field updates targeting the same run from peer-B
    const runId = doc.docState.children.get("ROOT")![0]!;
    const baseRun = doc.docState.nodes.get(runId)!;
    const runA: RunNode = { ...baseRun, text: "helloA", hlc: makeHlc(5000), actorId: "peer-B" };
    const runB: RunNode = { ...baseRun, text: "helloB", hlc: makeHlc(5000), actorId: "peer-C" };
    const extA: Action = {
      id: "act_extA",
      actor_id: "peer-B",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_extA",
          subject_id: "doc_1",
          subject_type: "text_document",
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: runA,
              update_id: "upd_extA",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };
    const extB: Action = {
      id: "act_extB",
      actor_id: "peer-C",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_extB",
          subject_id: "doc_1",
          subject_type: "text_document",
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: runB,
              update_id: "upd_extB",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };

    const conflicts: unknown[] = [];
    doc.onConflict((c) => conflicts.push(c));

    doc.applyActions([extA, extB]);

    expect(conflicts).toHaveLength(1);
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
    expect(doc.conflicts()).toHaveLength(0);
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
