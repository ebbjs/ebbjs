/**
 * Wire format tests — convert between ebb Action/Update and tree DocAction,
 * apply wire Actions to a DocState, and verify round-trip fidelity.
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import {
  applyActions,
  docActionToUpdate,
  FIELD_APPEND,
  FIELD_RANGE,
  FIELD_RUN,
  isRunUpdate,
  isWellFormedRunUpdate,
  RUN_SUBJECT_TYPE,
  updateToDocAction,
} from "../wire";
import { createDocState, docReducer, makeRunId, type DocState, type RunNode } from "../tree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const makeRun = (ts: number, actorId: string, text: string, parentId: string): RunNode => {
  const hlc = makeHlc(ts);
  return { id: makeRunId(hlc, actorId), hlc, actorId, text, parentId, deleted: false };
};

const wrapInAction = (actorId: string, hlc: HLCTimestamp, updates: Action["updates"]): Action => ({
  id: "a_test",
  actor_id: actorId,
  hlc,
  gsn: 0,
  updates,
});

// ---------------------------------------------------------------------------
// isRunUpdate
// ---------------------------------------------------------------------------

describe("isRunUpdate", () => {
  it("returns true for subject_type='run'", () => {
    expect(
      isRunUpdate({
        id: "u_1",
        subject_id: "x",
        subject_type: "run",
        method: "put",
        data: null,
      }),
    ).toBe(true);
  });

  it("returns false for other subject types", () => {
    expect(
      isRunUpdate({
        id: "u_1",
        subject_id: "x",
        subject_type: "todo",
        method: "patch",
        data: null,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateToDocAction
// ---------------------------------------------------------------------------

describe("updateToDocAction", () => {
  it("translates a put update with splitParentAt", () => {
    const node = makeRun(2000, "peer-A", "XY", "0:peer-A");
    const action = updateToDocAction({
      id: "u_1",
      subject_id: node.id,
      subject_type: "run",
      method: "put",
      data: {
        [FIELD_RUN]: { value: node, update_id: "u_1", hlc: node.hlc, splitParentAt: 3 },
      },
    } as never);

    expect(action).toEqual({ type: "INSERT_RUN", node, splitParentAt: 3 });
  });

  it("translates a patch update", () => {
    const action = updateToDocAction({
      id: "u_2",
      subject_id: "0:peer-A",
      subject_type: "run",
      method: "patch",
      data: {
        [FIELD_APPEND]: { value: { text: "more" }, update_id: "u_2", hlc: "100" },
      },
    } as never);

    expect(action).toEqual({ type: "EXTEND_RUN", runId: "0:peer-A", appendText: "more" });
  });

  it("translates a delete update", () => {
    const action = updateToDocAction({
      id: "u_3",
      subject_id: "0:peer-A",
      subject_type: "run",
      method: "delete",
      data: {
        [FIELD_RANGE]: { value: { offset: 1, count: 2 }, update_id: "u_3", hlc: "100" },
      },
    } as never);

    expect(action).toEqual({ type: "DELETE_RANGE", runId: "0:peer-A", offset: 1, count: 2 });
  });

  it("returns null for non-run subject types", () => {
    expect(
      updateToDocAction({
        id: "u_1",
        subject_id: "x",
        subject_type: "todo",
        method: "put",
        data: null,
      }),
    ).toBeNull();
  });

  it("returns null for malformed fields", () => {
    expect(
      updateToDocAction({
        id: "u_1",
        subject_id: "x",
        subject_type: "run",
        method: "put",
        data: null,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// docActionToUpdate
// ---------------------------------------------------------------------------

describe("docActionToUpdate", () => {
  it("translates INSERT_RUN with splitParentAt", () => {
    const node = makeRun(2000, "peer-A", "XY", "0:peer-A");
    const update = docActionToUpdate(
      { type: "INSERT_RUN", node, splitParentAt: 3 },
      { actorId: "peer-A", hlc: node.hlc, updateId: "u_1" },
    );

    expect(update).not.toBeNull();
    expect(update!.subject_type).toBe(RUN_SUBJECT_TYPE);
    expect(update!.method).toBe("put");
    expect(update!.id).toBe("u_1");
    const fields = update!.data as Record<string, Record<string, unknown>>;
    const runField = fields[FIELD_RUN]!;
    expect(runField.value).toEqual(node);
    expect(runField.update_id).toBe("u_1");
    expect(runField.hlc).toBe(node.hlc);
    expect(runField.splitParentAt).toBe(3);
  });

  it("translates EXTEND_RUN", () => {
    const update = docActionToUpdate(
      { type: "EXTEND_RUN", runId: "0:peer-A", appendText: "more" },
      { actorId: "peer-A", hlc: "100", updateId: "u_2" },
    );

    expect(update).not.toBeNull();
    expect(update!.method).toBe("patch");
    const fields = update!.data as Record<string, Record<string, unknown>>;
    expect(fields[FIELD_APPEND]!.value).toEqual({ text: "more" });
  });

  it("translates DELETE_RANGE", () => {
    const update = docActionToUpdate(
      { type: "DELETE_RANGE", runId: "0:peer-A", offset: 1, count: 2 },
      { actorId: "peer-A", hlc: "100", updateId: "u_3" },
    );

    expect(update).not.toBeNull();
    expect(update!.method).toBe("delete");
    const fields = update!.data as Record<string, Record<string, unknown>>;
    expect(fields[FIELD_RANGE]!.value).toEqual({ offset: 1, count: 2 });
  });

  it("returns null for SPLIT (local-only)", () => {
    expect(
      docActionToUpdate(
        { type: "SPLIT", runId: "x", offset: 3 },
        { actorId: "peer-A", hlc: "100", updateId: "u_4" },
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyActions
// ---------------------------------------------------------------------------

describe("applyActions", () => {
  it("applies a single INSERT_RUN to an empty doc", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const action = wrapInAction("peer-A", node.hlc, [
      {
        id: "u_1",
        subject_id: node.id,
        subject_type: "run",
        method: "put",
        data: { [FIELD_RUN]: { value: node, update_id: "u_1", hlc: node.hlc } },
      } as never,
    ]);

    const { state, applied } = applyActions(createDocState(), [action]);

    expect(state.nodes.has(node.id)).toBe(true);
    expect(state.index.spans).toEqual([{ runId: node.id, length: 5 }]);
    expect(applied).toEqual([{ type: "INSERT_RUN", node }]);
  });

  it("applies a put with splitParentAt (performs split first)", () => {
    // First insert "abcdef" as ROOT child
    const parent = makeRun(1000, "peer-A", "abcdef", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node: parent });

    // Now insert "XY" as child of parent, splitting at offset 3
    const child = makeRun(2000, "peer-A", "XY", parent.id);
    const action = wrapInAction("peer-A", child.hlc, [
      {
        id: "u_2",
        subject_id: child.id,
        subject_type: "run",
        method: "put",
        data: {
          [FIELD_RUN]: { value: child, update_id: "u_2", hlc: child.hlc, splitParentAt: 3 },
        },
      } as never,
    ]);

    const { state: s2, applied } = applyActions(state, [action]);

    // Should have split the parent
    expect(s2.nodes.size).toBe(4); // ROOT + parent + split right + child
    const splitId = `${parent.id}:s:3`;
    expect(s2.nodes.has(splitId)).toBe(true);
    expect(s2.nodes.get(splitId)!.text).toBe("def");
    expect(s2.nodes.get(parent.id)!.text).toBe("abc");
    expect(s2.nodes.get(child.id)!.text).toBe("XY");

    // Applied list includes the split before the insert
    expect(applied[0]).toEqual({ type: "SPLIT", runId: parent.id, offset: 3 });
    expect(applied[1]).toEqual({ type: "INSERT_RUN", node: child });
  });

  it("applies multiple updates within one action", () => {
    const a = makeRun(1000, "peer-A", "a", "ROOT");
    const b = makeRun(1001, "peer-A", "b", "ROOT");
    const action = wrapInAction("peer-A", "100", [
      {
        id: "u_1",
        subject_id: a.id,
        subject_type: "run",
        method: "put",
        data: { [FIELD_RUN]: { value: a, update_id: "u_1", hlc: "100" } },
      } as never,
      {
        id: "u_2",
        subject_id: b.id,
        subject_type: "run",
        method: "put",
        data: { [FIELD_RUN]: { value: b, update_id: "u_2", hlc: "100" } },
      } as never,
    ]);

    const { state } = applyActions(createDocState(), [action]);
    expect(state.nodes.has(a.id)).toBe(true);
    expect(state.nodes.has(b.id)).toBe(true);
  });

  it("applies a delete update as DELETE_RANGE", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const action = wrapInAction("peer-A", "100", [
      {
        id: "u_1",
        subject_id: node.id,
        subject_type: "run",
        method: "delete",
        data: {
          [FIELD_RANGE]: { value: { offset: 1, count: 3 }, update_id: "u_1", hlc: "100" },
        },
      } as never,
    ]);

    const { state: s2 } = applyActions(state, [action]);
    expect(s2.index.totalLength).toBe(2);
  });

  it("applies a patch update as EXTEND_RUN", () => {
    const node = makeRun(1000, "peer-A", "hel", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const action = wrapInAction("peer-A", "100", [
      {
        id: "u_1",
        subject_id: node.id,
        subject_type: "run",
        method: "patch",
        data: {
          [FIELD_APPEND]: { value: { text: "lo" }, update_id: "u_1", hlc: "100" },
        },
      } as never,
    ]);

    const { state: s2 } = applyActions(state, [action]);
    expect(s2.nodes.get(node.id)!.text).toBe("hello");
    expect(s2.index.totalLength).toBe(5);
  });

  it("ignores updates targeting other subject types", () => {
    const action = wrapInAction("peer-A", "100", [
      {
        id: "u_1",
        subject_id: "x",
        subject_type: "todo",
        method: "put",
        data: null,
      } as never,
    ]);

    const { state, applied } = applyActions(createDocState(), [action]);
    expect(state.nodes.size).toBe(1); // only ROOT
    expect(applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isWellFormedRunUpdate
// ---------------------------------------------------------------------------

describe("isWellFormedRunUpdate", () => {
  it("returns true for well-formed put", () => {
    expect(
      isWellFormedRunUpdate({
        id: "u_1",
        subject_id: "x",
        subject_type: "run",
        method: "put",
        data: { [FIELD_RUN]: { value: {}, update_id: "u_1", hlc: "100" } },
      } as never),
    ).toBe(true);
  });

  it("returns false for malformed fields", () => {
    expect(
      isWellFormedRunUpdate({
        id: "u_1",
        subject_id: "x",
        subject_type: "run",
        method: "put",
        data: null,
      }),
    ).toBe(false);
  });

  it("returns false for non-run subject types", () => {
    expect(
      isWellFormedRunUpdate({
        id: "u_1",
        subject_id: "x",
        subject_type: "todo",
        method: "put",
        data: null,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("round-trip docAction → update → docAction", () => {
  it("preserves INSERT_RUN identity", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const original = { type: "INSERT_RUN" as const, node };
    const update = docActionToUpdate(original, {
      actorId: "peer-A",
      hlc: node.hlc,
      updateId: "u_1",
    });
    const back = update && updateToDocAction(update);

    expect(back).toEqual(original);
  });

  it("preserves EXTEND_RUN", () => {
    const original = { type: "EXTEND_RUN" as const, runId: "0:peer-A", appendText: "more" };
    const update = docActionToUpdate(original, { actorId: "peer-A", hlc: "100", updateId: "u_1" });
    const back = update && updateToDocAction(update);

    expect(back).toEqual(original);
  });

  it("preserves DELETE_RANGE", () => {
    const original = {
      type: "DELETE_RANGE" as const,
      runId: "0:peer-A",
      offset: 1,
      count: 2,
    };
    const update = docActionToUpdate(original, { actorId: "peer-A", hlc: "100", updateId: "u_1" });
    const back = update && updateToDocAction(update);

    expect(back).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// DocState helpers (keep typecheck happy)
// ---------------------------------------------------------------------------

const _unused: DocState = createDocState();
