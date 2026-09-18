/**
 * Network-driven tests for TextDocument.
 *
 * Verifies that two TextDocuments connected through a mock SSE source
 * (representing the ebb_server fan-out path) converge to the same
 * document text, and that conflicts are surfaced on both sides.
 *
 * The mock source accepts Action submissions from one side and forwards
 * them to the other side as SSE data events — emulating the server's
 * SSE fan-out without booting the real server.
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import { TextDocument, type AppliedUpdate } from "../text-document";
import { FIELD_RUN as _FIELD_RUN, DEFAULT_DOC_SUBJECT_TYPE, formatRunFieldName } from "../wire";
void _FIELD_RUN;
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
      subject_id: "doc_xxx",
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

/**
 * Mock SSE source — accepts Actions from any side, fans them out to all
 * other sides as SSE `data` events. Mirrors the server's
 * watermark-gated fan-out behavior (slice 1's SSEConnection process).
 */
class MockSSESource {
  private subscribers = new Map<string, (action: Action) => void>();

  /** Subscribe a client to receive future Actions. */
  subscribe(actorId: string, cb: (action: Action) => void): () => void {
    this.subscribers.set(actorId, cb);
    return () => {
      this.subscribers.delete(actorId);
    };
  }

  /** Broadcast an Action to all subscribers (excluding the sender). */
  broadcast(action: Action, excludeActorId?: string): void {
    for (const [actorId, cb] of this.subscribers) {
      if (actorId === excludeActorId) continue;
      cb(action);
    }
  }
}

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

    // Each side's local edits broadcast to the other side
    docA.onUpdate(() => {
      for (const action of docA.pendingActions()) {
        source.broadcast(action, "peer-A");
      }
    });
    docB.onUpdate(() => {
      for (const action of docB.pendingActions()) {
        source.broadcast(action, "peer-B");
      }
    });

    // Simpler: directly broadcast after each edit
    docA.localInsert("hello");
    for (const action of docA.pendingActions()) source.broadcast(action, "peer-A");
    docA.clearPending();

    docB.localInsert("world");
    for (const action of docB.pendingActions()) source.broadcast(action, "peer-B");
    docB.clearPending();

    expect(docA.text).toBe(docB.text);
  });

  it("interleaved edits converge", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    // Peer A types "hello"
    docA.localInsert("hello");
    const aActs = docA.pendingActions();
    docA.clearPending();
    for (const action of aActs) source.broadcast(action, "peer-A");

    // Peer B sees A's text and types " world"
    expect(docB.text).toBe("hello");
    docB.localInsert(" world");
    const bActs = docB.pendingActions();
    docB.clearPending();
    for (const action of bActs) source.broadcast(action, "peer-B");

    // Peer A sees B's text
    expect(docA.text).toBe("hello world");
  });

  it("deletes propagate correctly across clients", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    // Peer A inserts "hello world"
    docA.localInsert("hello world");
    for (const action of docA.pendingActions()) {
      source.broadcast(action, "peer-A");
    }
    docA.clearPending();

    expect(docB.text).toBe("hello world");

    // Peer B deletes "world" (offset 6, count 5)
    const runId = docB.docState.children.get("ROOT")![0]!;
    docB.localDelete({ runId, offset: 6, count: 5 });
    for (const action of docB.pendingActions()) {
      source.broadcast(action, "peer-B");
    }
    docB.clearPending();

    expect(docA.text).toBe("hello ");
    expect(docB.text).toBe("hello ");
  });
});

// ---------------------------------------------------------------------------
// Conflicts via mock SSE
// ---------------------------------------------------------------------------

describe("TextDocument — conflict surfacing via mock SSE", () => {
  it("two concurrent edits to the same run surface a conflict on both sides", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    // Seed: peer-A inserts "hello"
    docA.localInsert("hello");
    for (const action of docA.pendingActions()) source.broadcast(action, "peer-A");
    docA.clearPending();

    expect(docB.text).toBe("hello");
    const runId = docB.docState.children.get("ROOT")![0]!;

    // Concurrent field updates to the same run with same HLC
    const extARun: RunNode = {
      id: runId,
      hlc: makeHlc(5000),
      actorId: "peer-A",
      text: "helloA",
      parentId: "ROOT",
      deleted: false,
    };
    const extBRun: RunNode = {
      id: runId,
      hlc: makeHlc(5000),
      actorId: "peer-B",
      text: "helloB",
      parentId: "ROOT",
      deleted: false,
    };
    const extA: Action = {
      id: "act_extA",
      actor_id: "peer-A",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_extA",
          subject_id: "doc_1",
          subject_type: DEFAULT_DOC_SUBJECT_TYPE,
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: extARun,
              update_id: "upd_extA",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };
    const extB: Action = {
      id: "act_extB",
      actor_id: "peer-B",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_extB",
          subject_id: "doc_1",
          subject_type: DEFAULT_DOC_SUBJECT_TYPE,
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: extBRun,
              update_id: "upd_extB",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };

    // Both peers broadcast without seeing the other's edit
    source.broadcast(extA, undefined);
    source.broadcast(extB, undefined);

    // Both should see a conflict on the run
    expect(docA.conflicts()).toHaveLength(1);
    expect(docB.conflicts()).toHaveLength(1);
    expect(docA.conflicts()[0]!.runId).toBe(runId);
    expect(docB.conflicts()[0]!.runId).toBe(runId);

    // Both should converge to the same document
    expect(docA.text).toBe(docB.text);
  });

  it("conflict listeners fire on the receiving side", () => {
    const source = new MockSSESource();
    const docA = new TextDocument({ docId: "doc_1", actorId: "peer-A" });
    const docB = new TextDocument({ docId: "doc_1", actorId: "peer-B" });

    source.subscribe("peer-A", (action) => docA.applyActions([action]));
    source.subscribe("peer-B", (action) => docB.applyActions([action]));

    // Seed run
    docA.localInsert("hi");
    for (const action of docA.pendingActions()) source.broadcast(action, "peer-A");
    docA.clearPending();

    const runId = docA.docState.children.get("ROOT")![0]!;

    const events: number[] = [];
    docB.onConflict(() => events.push(events.length));

    const extARun2: RunNode = {
      id: runId,
      hlc: makeHlc(5000),
      actorId: "peer-A",
      text: "hi!",
      parentId: "ROOT",
      deleted: false,
    };
    const extBRun2: RunNode = {
      id: runId,
      hlc: makeHlc(5000),
      actorId: "peer-B",
      text: "hi?",
      parentId: "ROOT",
      deleted: false,
    };
    const extA: Action = {
      id: "act_eA",
      actor_id: "peer-A",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_eA",
          subject_id: "doc_1",
          subject_type: DEFAULT_DOC_SUBJECT_TYPE,
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: extARun2,
              update_id: "upd_eA",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };
    const extB: Action = {
      id: "act_eB",
      actor_id: "peer-B",
      hlc: makeHlc(5000),
      gsn: 0,
      updates: [
        {
          id: "upd_eB",
          subject_id: "doc_1",
          subject_type: DEFAULT_DOC_SUBJECT_TYPE,
          method: "patch",
          data: {
            [formatRunFieldName(runId)]: {
              value: extBRun2,
              update_id: "upd_eB",
              hlc: makeHlc(5000),
            },
          },
        } as never,
      ],
    };

    source.broadcast(extA);
    source.broadcast(extB);

    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Update event flow
// ---------------------------------------------------------------------------

describe("TextDocument — update event flow", () => {
  it("fires onUpdate for each applied Update", () => {
    const doc = new TextDocument({ docId: "doc_1", actorId: "peer-A" });

    const events: AppliedUpdate[] = [];
    doc.onUpdate((evt) => events.push(evt));

    const run1 = makeRun(1000, "peer-B", "a", "ROOT");
    const run2 = makeRun(1001, "peer-C", "b", "ROOT");

    doc.applyActions([makeInsertAction(run1), makeInsertAction(run2)]);

    expect(events).toHaveLength(2);
    expect(events[0]!.runId).toBe(run1.id);
    expect(events[0]!.kind).toBe("insert");
    expect(events[1]!.runId).toBe(run2.id);
  });

  it("ignores Updates targeting non-run subjects", () => {
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

    // Local edit
    docLocal.localInsert("hello");

    // Simulate client.write() — the server would broadcast these to other subscribers
    for (const action of docLocal.pendingActions()) {
      source.broadcast(action, "peer-local");
    }
    docLocal.ackPending(docLocal.pendingActions().map((a) => a.id));

    // Remote peer now has the text
    expect(docRemote.text).toBe("hello");

    // Local sends another edit
    docLocal.localInsert(" world");
    for (const action of docLocal.pendingActions()) {
      source.broadcast(action, "peer-local");
    }
    docLocal.ackPending(docLocal.pendingActions().map((a) => a.id));

    // Convergence
    expect(docLocal.text).toBe("hello world");
    expect(docRemote.text).toBe("hello world");
  });
});
