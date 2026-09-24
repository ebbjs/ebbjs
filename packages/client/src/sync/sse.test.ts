import { describe, it, expect } from "vitest";
import { parseSSEBlock } from "./sse";
import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage";
import { makeHlc, type Action } from "@ebbjs/core";

describe("parseSSEBlock", () => {
  it("parses a data event", () => {
    const block = [
      "event: data",
      'data: {"id":"act_1","gsn":1,"actor_id":"a_1","hlc":123,"updates":[]}',
      "",
    ].join("\n");

    const result = parseSSEBlock(block);
    expect(result).toEqual({
      type: "data",
      action: { id: "act_1", gsn: 1, actor_id: "a_1", hlc: 123, updates: [] },
    });
  });

  it("parses a control event", () => {
    const block = [
      "event: control",
      'data: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":42}',
      "",
    ].join("\n");

    const result = parseSSEBlock(block);
    expect(result).toEqual({
      type: "control",
      control: { reconnect: true, reason: "behind_watermark", catchUpFrom: 42 },
    });
  });

  it("parses a presence event", () => {
    const block = [
      "event: presence",
      'data: {"actor_id":"a_1","entity_id":"e_1","data":{"cursor":{"line":5}}}',
      "",
    ].join("\n");

    const result = parseSSEBlock(block);
    expect(result).toEqual({
      type: "presence",
      presence: { actor_id: "a_1", entity_id: "e_1", data: { cursor: { line: 5 } } },
    });
  });

  it("returns null for comment-only block (keepalive)", () => {
    const block = ": keepalive\n\n";
    expect(parseSSEBlock(block)).toBeNull();
  });

  it("returns null for empty block", () => {
    expect(parseSSEBlock("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const block = "event: data\ndata: not json\n\n";
    expect(parseSSEBlock(block)).toBeNull();
  });

  it("returns null for unknown event type", () => {
    const block = "event: unknown\ndata: {}\n\n";
    expect(parseSSEBlock(block)).toBeNull();
  });

  it("joins multi-line data fields with newline", () => {
    const block = "event: data\ndata: line1\ndata: line2\n\n";
    const result = parseSSEBlock(block);
    // The server emits single-line JSON, but be permissive.
    expect(result).toBeNull(); // "line1line2" is not valid JSON
  });
});

/**
 * Drive the private `_applyAction` method on a SyncClient. Tests
 * migrated from the (now-deleted) top-level `applyAction` helper
 * use this to seed storage state without spinning up the full
 * SSE/HTTP path.
 */
const callApplyAction = async (
  storage: ReturnType<typeof createMemoryAdapter>,
  action: Action,
  groupId?: string,
): Promise<{ entityId: string; entityType: string }[]> => {
  const client = createClient({
    serverUrl: "http://localhost:0",
    actorId: "a_test",
    storage,
  });
  return (
    client as unknown as {
      _applyAction: (a: Action, g?: string) => Promise<{ entityId: string; entityType: string }[]>;
    }
  )._applyAction.call(client, action, groupId);
};

describe("_applyAction (storage path)", () => {
  it("appends action and marks entities dirty", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000),
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) } },
          },
        },
      ],
    };
    const affected = await callApplyAction(storage, action, "grp_1");
    expect(affected).toEqual([{ entityId: "todo_1", entityType: "todo" }]);
    expect(await storage.isDirty("todo_1")).toBe(true);
    expect(await storage.cursors.get("grp_1")).toBe(1);
  });

  it("advances the cursor only when gsn is higher", async () => {
    const storage = createMemoryAdapter();
    await storage.cursors.set("grp_1", 10);
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000),
      gsn: 5,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) } },
          },
        },
      ],
    };
    await callApplyAction(storage, action, "grp_1");
    expect(await storage.cursors.get("grp_1")).toBe(10);
  });

  it("skips cursor advance when gsn is 0", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000),
      gsn: 0,
      updates: [],
    };
    await callApplyAction(storage, action, "grp_1");
    expect(await storage.cursors.get("grp_1")).toBeNull();
  });

  it("returns affected entities without a group", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000),
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) } },
          },
        },
        {
          id: "u_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "World", update_id: "u_2", hlc: makeHlc(1711036800000, 1) } },
          },
        },
      ],
    };
    const affected = await callApplyAction(storage, action);
    expect(affected).toHaveLength(2);
    expect(await storage.cursors.get("grp_1")).toBeNull();
  });
});

// Exercises the patch path that calls `compare(existingValue.hlc,
// patchValue.hlc)` internally — confirms the packed-BigInt HLC
// fixtures round-trip through parse → compare → BigInt without
// throwing.
describe("_applyAction HLC handling", () => {
  it("applies a patch with packed BigInt HLCs without throwing", async () => {
    const storage = createMemoryAdapter();
    const putAction: Action = {
      id: "a_put",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000),
      gsn: 1,
      updates: [
        {
          id: "u_put",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: {
              title: { value: "Hello", update_id: "u_put", hlc: makeHlc(1711036800000) },
            },
          },
        },
      ],
    };
    const patchAction: Action = {
      id: "a_patch",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000, 1),
      gsn: 2,
      updates: [
        {
          id: "u_patch",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: {
            fields: {
              title: { value: "Updated", update_id: "u_patch", hlc: makeHlc(1711036800000, 1) },
            },
          },
        },
      ],
    };
    await callApplyAction(storage, putAction, "grp_1");
    // The patch calls `compare(existingValue.hlc, patchValue.hlc)` inside
    // `mergeFields`. With the old `${ms}:0` strings, `BigInt()` threw
    // `SyntaxError` here. With packed HLCs, it parses cleanly and the
    // patch lands.
    await expect(callApplyAction(storage, patchAction, "grp_1")).resolves.not.toThrow();
    const entity = await storage.entities.get("todo_1");
    expect(entity).not.toBeNull();
    expect((entity!.data.fields.title as { value: unknown }).value).toBe("Updated");
  });
});
