import { describe, it, expect } from "vitest";
import { parseSSEBlock } from "./sse";
import { createMemoryAdapter } from "@ebbjs/storage";
import { applyAction } from "./storage";
import type { Action } from "@ebbjs/core";

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

describe("applyAction", () => {
  it("appends action and marks entities dirty", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: "1711036800000:0",
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000:0" } },
        },
      ],
    };
    const affected = await applyAction(storage, action, "grp_1");
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
      hlc: "1711036800000:0",
      gsn: 5,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000:0" } },
        },
      ],
    };
    await applyAction(storage, action, "grp_1");
    expect(await storage.cursors.get("grp_1")).toBe(10);
  });

  it("skips cursor advance when gsn is 0", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: "1711036800000:0",
      gsn: 0,
      updates: [],
    };
    await applyAction(storage, action, "grp_1");
    expect(await storage.cursors.get("grp_1")).toBeNull();
  });

  it("returns affected entities without a group", async () => {
    const storage = createMemoryAdapter();
    const action: Action = {
      id: "a_1",
      actor_id: "a_user",
      hlc: "1711036800000:0",
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000:0" } },
        },
        {
          id: "u_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "put",
          data: { title: { value: "World", update_id: "u_2", hlc: "1711036800000:1" } },
        },
      ],
    };
    const affected = await applyAction(storage, action);
    expect(affected).toHaveLength(2);
    expect(await storage.cursors.get("grp_1")).toBeNull();
  });
});
