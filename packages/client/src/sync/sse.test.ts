import { describe, it, expect, vi } from "vitest";
import { openSSEStream, parseSSEBlock } from "./sse";
import type { SSEEvent } from "./types";
import { makeStreamingFetch } from "./test-utils";

// `parseSSEBlock` is part of the package's public surface (`src/index.ts`),
// so these pin the wire shapes a caller can hand it.
describe("parseSSEBlock", () => {
  it("parses an event's name and data into its typed payload", () => {
    // The event name is what selects the payload field, so every known
    // name has to survive the line loop with its own shape.
    const cases = [
      {
        block:
          'event: data\ndata: {"id":"act_1","gsn":1,"actor_id":"a_1","hlc":123,"updates":[]}\n',
        expected: {
          type: "data",
          action: { id: "act_1", gsn: 1, actor_id: "a_1", hlc: 123, updates: [] },
        },
      },
      {
        block:
          'event: control\ndata: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":42}\n',
        expected: {
          type: "control",
          control: { reconnect: true, reason: "behind_watermark", catchUpFrom: 42 },
        },
      },
      {
        block:
          'event: presence\ndata: {"actor_id":"a_1","entity_id":"e_1","data":{"cursor":{"line":5}}}\n',
        expected: {
          type: "presence",
          presence: { actor_id: "a_1", entity_id: "e_1", data: { cursor: { line: 5 } } },
        },
      },
    ] as const;

    for (const { block, expected } of cases) {
      expect(parseSSEBlock(block)).toEqual(expected);
    }
  });

  it("returns null for a block with no data field (keepalive comment)", () => {
    expect(parseSSEBlock(": keepalive\n\n")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const block = "event: data\ndata: not json\n\n";
    expect(parseSSEBlock(block)).toBeNull();
  });

  it("returns null for unknown event type", () => {
    const block = "event: unknown\ndata: {}\n\n";
    expect(parseSSEBlock(block)).toBeNull();
  });
});

describe("openSSEStream", () => {
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
      actorId: "a_1",
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
    // Auth is header-only: no legacy `actor_id=` query param.
    expect(calls[0].url).not.toMatch(/[?&]actor_id=/);
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
      actorId: "a_1",
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
      actorId: "a_1",
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
      actorId: "a_1",
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
      actorId: "a_1",
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
        // Then block — consumer should signal us via abort.
      },
      cancel() {
        aborted = true;
      },
    });
    const fn = vi.fn(async (_url: string, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const sub = openSSEStream({
      serverUrl: "http://localhost:4000",
      groupIds: ["grp_1"],
      cursor: 0,
      actorId: "a_1",
      fetchImpl: fn,
    });

    const iter = (async () => {
      for await (const _ev of sub.events()) {
        sub.close();
      }
    })();
    await iter;
    // Give the abort handler a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });
});
