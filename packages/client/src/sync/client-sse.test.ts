import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage";
import type { Action } from "@ebbjs/core";
import type { SSEEvent } from "./types";

/**
 * SSE-driven subscribe test.
 *
 * Uses fetch mocks with controlled streaming bodies. Verifies the read path:
 * action receipt → storage append → onEvent callback, plus the connection
 * state transitions and reconnect / cancellation logic.
 */
describe("SyncClient.subscribe (SSE)", () => {
  it("opens SSE, applies action to storage, fires callback", async () => {
    const encoder = new TextEncoder();
    const action: Action = {
      id: "act_1",
      actor_id: "a_alice",
      hlc: "1711036800000:0",
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          // User entities nest their fields under `data.fields` (mirrors
          // `EbbServer.Storage.ActionValidator.well_formed_data?/1`).
          data: {
            fields: { title: { value: "Live", update_id: "u_1", hlc: "1711036800000:0" } },
          } as never,
        },
      ],
    };
    const makeBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(action)}\n\n`));
          controller.close();
        },
      });

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/sync/live")) {
        return new Response(makeBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    let resolveEvent!: (ev: SSEEvent) => void;
    const eventPromise = new Promise<SSEEvent>((resolve) => {
      resolveEvent = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "data") resolveEvent(ev);
    });

    const received = await eventPromise;
    expect(received.type).toBe("data");

    // The action should now be in storage.
    const entity = await client.readLocalEntity("todo_1");
    expect(entity).not.toBeNull();
    expect(entity!.data.fields.title).toMatchObject({ value: "Live" });

    unsubscribe();
  });

  it("rejects duplicate subscribe calls", () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });
    client.subscribe(["grp_1"], 0, () => {});
    expect(() => client.subscribe(["grp_1"], 0, () => {})).toThrow(/active subscription/);
    client.close();
  });

  it("appends actions from SSE to the storage adapter", async () => {
    const storage = createMemoryAdapter();
    const encoder = new TextEncoder();
    const action: Action = {
      id: "act_sse",
      actor_id: "a_other",
      hlc: "1711036800000:0",
      gsn: 5,
      updates: [
        {
          id: "u_sse",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          // User entities nest their fields under `data.fields` (mirrors
          // `EbbServer.Storage.ActionValidator.well_formed_data?/1`).
          data: {
            fields: { x: { value: 1, update_id: "u_sse", hlc: "1711036800000:0" } },
          } as never,
        },
      ],
    };
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(action)}\n\n`));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      storage,
    });

    let resolveEvent!: () => void;
    const eventPromise = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "data") resolveEvent();
    });

    await eventPromise;

    // Poll briefly to allow storage append to settle.
    for (let i = 0; i < 50 && !(await storage.isDirty("doc_1")); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await storage.isDirty("doc_1")).toBe(true);
    expect(await storage.cursors.get("grp_1")).toBe(5);

    unsubscribe();
  });

  it("fires onEvent for control events", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: control\ndata: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":42}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    let resolveControl!: (ev: SSEEvent) => void;
    const controlPromise = new Promise<SSEEvent>((resolve) => {
      resolveControl = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "control") resolveControl(ev);
    });

    const received = await controlPromise;
    if (received.type !== "control") throw new Error("expected control");
    expect(received.control.reconnect).toBe(true);
    expect(received.control.catchUpFrom).toBe(42);

    unsubscribe();
  });
});
