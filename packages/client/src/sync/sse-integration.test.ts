import { describe, it, expect, vi } from "vitest";
import { openSSEStream } from "./sse";
import type { SSEEvent } from "./types";

/**
 * Build a `fetch` mock that returns a streaming Response built from a list
 * of pre-encoded SSE bytes. Models what the ebb server sends.
 */
function makeStreamingFetch(
  chunks: string[],
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(body, {
      status: options.status ?? 200,
      headers: new Headers(options.headers ?? { "content-type": "text/event-stream" }),
    });
  }) as unknown as typeof fetch;

  return { fn, calls };
}

describe("openSSEStream (Node implementation)", () => {
  it("opens a stream and parses data events", async () => {
    const sse = [
      'event: data\ndata: {"id":"act_1","gsn":1,"actor_id":"a_1","hlc":1,"updates":[]}\n\n',
      ": keepalive\n\n",
      'event: data\ndata: {"id":"act_2","gsn":2,"actor_id":"a_1","hlc":2,"updates":[]}\n\n',
    ];
    const { fn, calls } = makeStreamingFetch(sse);
    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_1"],
      cursor: 0,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });

    const events: SSEEvent[] = [];
    (async () => {
      for await (const ev of sub.events()) {
        events.push(ev);
        if (events.length === 2) {
          sub.close();
        }
      }
    })();
    await sub.closed;

    expect(calls[0].url).toBe("http://localhost:4000/sync/live?groups=grp_1&cursor=0");
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers["x-ebb-actor-id"]).toBe("a_1");
    expect(headers["Accept"]).toBe("text/event-stream");

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("data");
    if (events[0].type === "data") {
      expect(events[0].action.id).toBe("act_1");
    }
    expect(events[1].type).toBe("data");
    if (events[1].type === "data") {
      expect(events[1].action.id).toBe("act_2");
    }
  });

  it("parses control and presence events", async () => {
    const sse = [
      'event: control\ndata: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":5}\n\n',
      'event: presence\ndata: {"actor_id":"a_2","entity_id":"e_1","data":{"cursor":{"line":1}}}\n\n',
    ];
    const { fn } = makeStreamingFetch(sse);
    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_1"],
      cursor: 0,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });

    const events: SSEEvent[] = [];
    (async () => {
      for await (const ev of sub.events()) {
        events.push(ev);
        if (events.length === 2) sub.close();
      }
    })();
    await sub.closed;

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "control",
      control: { reconnect: true, reason: "behind_watermark", catchUpFrom: 5 },
    });
    expect(events[1]).toEqual({
      type: "presence",
      presence: { actor_id: "a_2", entity_id: "e_1", data: { cursor: { line: 1 } } },
    });
  });

  it("splits events across chunk boundaries", async () => {
    const sse = [
      'event: data\ndata: {"id":"act_1"',
      ',"gsn":1,"actor_id":"a_1","hlc":1,"updates":[]}\n\nevent: data\n',
      'data: {"id":"act_2","gsn":2,"actor_id":"a_1","hlc":2,"updates":[]}\n\n',
    ];
    const { fn } = makeStreamingFetch(sse);
    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_1"],
      cursor: 0,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });

    const events: SSEEvent[] = [];
    (async () => {
      for await (const ev of sub.events()) {
        events.push(ev);
        if (events.length === 2) sub.close();
      }
    })();
    await sub.closed;

    expect(events).toHaveLength(2);
  });

  it("URL-encodes multiple groups", async () => {
    const { fn, calls } = makeStreamingFetch(['event: control\ndata: {"reason":"x"}\n\n']);
    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_a", "grp_b"],
      cursor: 7,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });
    (async () => {
      for await (const _ev of sub.events()) {
        sub.close();
      }
    })();
    await sub.closed;
    expect(calls[0].url).toBe("http://localhost:4000/sync/live?groups=grp_a%2Cgrp_b&cursor=7");
  });

  it("fails the stream on a non-2xx response", async () => {
    const { fn } = makeStreamingFetch([], { status: 403 });
    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_x"],
      cursor: 0,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });

    await expect(sub.closed).resolves.toBeUndefined();
    let rejected = false;
    try {
      for await (const _ev of sub.events()) {
        // should not happen
      }
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("aborts the underlying fetch on close()", async () => {
    let aborted = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: data\ndata: {"id":"a"}\n\n'));
        // Then block forever — the client should close us.
      },
      cancel() {
        aborted = true;
      },
    });
    const fn = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_1"],
      cursor: 0,
      headers: { actorId: "a_1" },
      fetchImpl: fn,
    });

    const it = (async () => {
      for await (const _ev of sub.events()) {
        sub.close();
      }
    })();
    await it;
    // Give the cancel handler a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });
});
