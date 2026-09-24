import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage";
import { makeHlc, type Action } from "@ebbjs/core";
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
      hlc: "112134507724800000",
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Live", update_id: "u_1", hlc: "112134507724800000" } },
          },
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
      hlc: "112134507724800000",
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
            fields: { x: { value: 1, update_id: "u_sse", hlc: "112134507724800000" } },
          },
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

  it("materializes a user-entity patch when fields are wrapped under data.fields", async () => {
    // Regression guard: a patch update for a user entity must wrap the
    // field map under `data.fields` to mirror
    // `EbbServer.Storage.ActionValidator.well_formed_data?/1`. With the
    // correct wrapping, the materializer should merge the patched field
    // into the existing entity.
    const storage = createMemoryAdapter();
    const putAction: Action = {
      id: "act_put",
      actor_id: "a_alice",
      hlc: makeHlc(1711036800000),
      gsn: 1,
      updates: [
        {
          id: "u_put",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Hello", update_id: "u_put", hlc: makeHlc(1711036800000) } },
          },
        },
      ],
    };
    const patchAction: Action = {
      id: "act_patch",
      actor_id: "a_alice",
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
    // Seed via the same wire path subscribe() uses.
    const { applyAction } = await import("./storage");
    await applyAction(storage, putAction, "grp_1");
    await applyAction(storage, patchAction, "grp_1");
    const e = await storage.entities.get("todo_1");
    expect(e).not.toBeNull();
    expect((e!.data.fields.title as { value?: unknown }).value).toBe("Updated");
  });

  it("does not materialize a user-entity patch with unwrapped (flat) data", async () => {
    // Documents the failure mode that the smoke test in
    // examples/ebb-client-smoke used to hit: a patch update whose `data`
    // shape doesn't wrap fields is silently dropped by the client
    // materializer (extractPatchFields returns {}), and the entity never
    // updates. This pins the failure mode so a future "fix" that loosens
    // the unwrap won't silently regress.
    const storage = createMemoryAdapter();
    const putAction: Action = {
      id: "act_put",
      actor_id: "a_alice",
      hlc: makeHlc(1711036800000),
      gsn: 1,
      updates: [
        {
          id: "u_put",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: { title: { value: "Hello", update_id: "u_put", hlc: makeHlc(1711036800000) } },
          },
        },
      ],
    };
    const flatPatch: Action = {
      id: "act_flat_patch",
      actor_id: "a_alice",
      hlc: makeHlc(1711036800000, 1),
      gsn: 2,
      updates: [
        {
          id: "u_flat",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          // NO `fields` wrapper — this is the bug shape.
          data: {
            title: {
              value: "Should not stick",
              update_id: "u_flat",
              hlc: makeHlc(1711036800000, 1),
            },
          },
        },
      ],
    };
    const { applyAction } = await import("./storage");
    await applyAction(storage, putAction, "grp_1");
    await applyAction(storage, flatPatch, "grp_1");
    const e = await storage.entities.get("todo_1");
    expect(e).not.toBeNull();
    // The flat patch must NOT have overwritten the put's title.
    expect((e!.data.fields.title as { value?: unknown }).value).toBe("Hello");
    // And the patch must not have produced a stray `fields` key under data.fields.
    expect(e!.data.fields).not.toHaveProperty("fields");
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
