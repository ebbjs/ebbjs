/**
 * Network-driven tests for TextDocument.
 *
 * Two TextDocuments connected through a mock SSE source (representing the
 * ebb_server fan-out path) converge to the same projected text. Actions are
 * produced by ordinary local edits, so they carry the body's `version` leaf
 * and only ever add cell keys.
 */

import { describe, expect, it } from "vitest";
import { format, pack, type Action, type HLCTimestamp } from "@ebbjs/core";
import {
  DOC_CONTENT_FIELD,
  DOC_VERSION_FIELD,
  makeRunId,
  TextDocument,
  versionField,
  type AppliedUpdate,
  type RunCell,
} from "@ebbjs/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const peerRun = (
  ts: number,
  actorId: string,
  text: string,
  anchor: RunCell["anchor"],
  id?: string,
): RunCell => {
  const stamp = makeHlc(ts);
  return {
    kind: "run",
    id: id ?? makeRunId(stamp, actorId),
    text,
    author: actorId,
    stamp,
    anchor,
  };
};

const makeInsertAction = (run: RunCell, subjectType = "text_document"): Action => ({
  id: `act_${run.id}`,
  actor_id: run.author,
  hlc: run.stamp,
  gsn: 0,
  updates: [
    {
      id: `upd_${run.id}`,
      subject_id: "doc_1",
      subject_type: subjectType,
      method: "patch",
      data: {
        fields: {
          [DOC_CONTENT_FIELD]: {
            map: {
              [run.id]: { value: run, update_id: `upd_${run.id}`, hlc: run.stamp },
            },
          },
          [DOC_VERSION_FIELD]: versionField(run.stamp, `upd_${run.id}`),
        },
      },
    },
  ],
});

/**
 * Mock SSE source — accepts Actions from any side, fans them out to all
 * other sides as SSE `data` events, mirroring the server's watermark-gated
 * fan-out.
 */
class MockSSESource {
  private subscribers = new Map<string, (action: Action) => void>();

  subscribe(actorId: string, cb: (action: Action) => void): () => void {
    this.subscribers.set(actorId, cb);
    return () => {
      this.subscribers.delete(actorId);
    };
  }

  broadcast(action: Action, excludeActorId?: string): void {
    for (const [actorId, cb] of this.subscribers) {
      if (actorId === excludeActorId) continue;
      cb(action);
    }
  }
}

const wire = (from: TextDocument, source: MockSSESource): void => {
  for (const action of from.pendingActions()) source.broadcast(action, from.actorId);
  from.ackPending(from.pendingActions().map((action) => action.id));
};

// ---------------------------------------------------------------------------
// Convergence via mock SSE
// ---------------------------------------------------------------------------

describe("TextDocument — mock SSE convergence", () => {
  it("two clients typing sequentially converge to the same document", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });
    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    docA.localInsert("hello");
    wire(docA, source);
    expect(docB.text).toBe("hello");

    docB.localInsert("world");
    wire(docB, source);
    expect(docA.text).toBe(docB.text);
  });

  it("interleaved edits converge and keep every character", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });
    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    docA.localInsert("hello");
    const aActs = docA.pendingActions();
    docB.localInsert(" world");
    const bActs = docB.pendingActions();

    docA.applyActions(bActs);
    docB.applyActions(aActs);

    expect(docA.text).toBe(docB.text);
    expect([...docA.text].sort().join("")).toBe([..."hello world"].sort().join(""));
  });

  it("deletes propagate as cuts and stay deleted", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });
    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    docA.localInsert("hello world");
    wire(docA, source);
    expect(docB.text).toBe("hello world");

    const runId = docB.docState.index.spans[0]!.runId;
    docB.localDelete({ runId, offset: 6, count: 5 });
    wire(docB, source);

    expect(docA.text).toBe("hello ");
    expect(docB.text).toBe("hello ");
  });

  it("a later insert into a deleted range survives the delete", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });
    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    docA.localInsert("hello");
    wire(docA, source);
    const runId = docB.docState.index.spans[0]!.runId;

    docB.localInsert("X", { afterRun: runId, splitParentAt: 2, hlc: makeHlc(5) });
    docA.localDelete({ runId, offset: 0, count: 5, hlc: makeHlc(6) });
    wire(docB, source);
    wire(docA, source);

    expect(docA.text).toBe("X");
    expect(docB.text).toBe("X");
  });
});

// ---------------------------------------------------------------------------
// Update event flow
// ---------------------------------------------------------------------------

describe("TextDocument — update event flow", () => {
  it("fires onUpdate for each delivered cell", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const run1 = peerRun(1000, "peer-B", "a", { runId: "ROOT", offset: 0 }, "r1");
    const run2 = peerRun(1001, "peer-C", "b", { runId: "ROOT", offset: 0 }, "r2");
    doc.applyActions([makeInsertAction(run1), makeInsertAction(run2)]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ cellId: "r1", kind: "insert" });
    expect(events[1]).toMatchObject({ cellId: "r2", kind: "insert" });
  });

  it("ignores Updates targeting other subjects", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    doc.applyActions([
      {
        id: "act_todo",
        actor_id: "peer-B",
        hlc: makeHlc(1000),
        gsn: 0,
        updates: [
          {
            id: "upd_todo",
            subject_id: "todo_x",
            subject_type: "todo",
            method: "put",
            data: null,
          } as never,
        ],
      },
    ]);

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Simulated server roundtrip
// ---------------------------------------------------------------------------

describe("TextDocument — simulated full server roundtrip", () => {
  it("writes flow through pendingActions and arrive as SSE updates", () => {
    const source = new MockSSESource();
    const docLocal = new TextDocument({ docId: "doc_1", actorId: "peer-local" });
    const docRemote = new TextDocument({ docId: "doc_1", actorId: "peer-remote" });
    source.subscribe("peer-local", (action) => docLocal.applyActions([action]));
    source.subscribe("peer-remote", (action) => docRemote.applyActions([action]));

    docLocal.localInsert("hello");
    wire(docLocal, source);
    expect(docRemote.text).toBe("hello");

    docLocal.localInsert(" world");
    wire(docLocal, source);

    expect(docLocal.text).toBe("hello world");
    expect(docRemote.text).toBe("hello world");
  });
});
