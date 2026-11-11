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
import { TextDocument } from "./text-document";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

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
