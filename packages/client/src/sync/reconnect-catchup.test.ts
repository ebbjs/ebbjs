/**
 * Reconnect rebase phase (#309): every connect pulls the missed window
 * for each subscribed group, runs the inbound conflict sweep, and only
 * then releases the Outbox flush. These tests drive the real `subscribe`
 * loop with a path-dispatching fetch mock.
 */

import { describe, it, expect, vi } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";

import { createClient } from "./client";
import type { SSEEvent } from "./types";
import {
  closingSseResponse,
  emptyCatchUpResponse,
  jsonResponse,
  openSseResponse,
} from "./test-utils";

const controlReconnect = (catchUpFrom: number): string =>
  `event: control\ndata: ${JSON.stringify({ reconnect: true, reason: "behind_watermark", catchUpFrom })}\n\n`;

const putAction = (opts: {
  id: string;
  gsn: number;
  hlc: string;
  updateId: string;
  title: string;
}): Action => ({
  id: opts.id,
  actor_id: "a_peer",
  hlc: opts.hlc,
  gsn: opts.gsn,
  updates: [
    {
      id: opts.updateId,
      subject_id: "todo_1",
      subject_type: "todo",
      method: "put",
      data: {
        fields: {
          title: { value: opts.title, update_id: opts.updateId, hlc: opts.hlc },
        },
      },
    },
  ],
});

const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("SyncClient rebase phase (#309)", () => {
  it("applies missed Actions on connect and surfaces them to onEvent", async () => {
    const missed = putAction({
      id: "act_missed",
      gsn: 7,
      hlc: makeHlc(1711036800000),
      updateId: "u_missed",
      title: "From peer",
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/sync/groups/")) {
        return jsonResponse([missed], {
          "stream-next-offset": "7",
          "stream-up-to-date": "true",
        });
      }
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    const events: SSEEvent[] = [];
    const unsubscribe = client.subscribe(["grp_1"], 0, (event) => events.push(event));

    await waitFor(async () => (await client.readLocalEntity("todo_1")) !== null);
    const entity = await client.readLocalEntity("todo_1");
    expect((entity!.data.fields.title as { value?: unknown }).value).toBe("From peer");
    expect(events.some((e) => e.type === "data" && e.action.id === "act_missed")).toBe(true);

    // The live stream resumes from the caught-up cursor, not from 0.
    const liveCall = calls.find((url) => url.includes("/sync/live"));
    expect(liveCall).toContain("cursor=7");

    unsubscribe();
  });

  it("honors the server's catch-up point over a stored cursor", async () => {
    const prior = putAction({
      id: "act_prior",
      gsn: 9,
      hlc: makeHlc(1711036800000),
      updateId: "u_prior",
      title: "Prior",
    });
    const missed = putAction({
      id: "act_stale_window",
      gsn: 6,
      hlc: makeHlc(1711036800000, 1),
      updateId: "u_stale",
      title: "Stale window",
    });
    const groupOffsets: string[] = [];
    let liveOpens = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/groups/")) {
        groupOffsets.push(url);
        if (url.includes("offset=0")) {
          return jsonResponse([prior], { "stream-up-to-date": "true" });
        }
        return jsonResponse([missed], { "stream-next-offset": "6", "stream-up-to-date": "true" });
      }
      if (url.includes("/sync/live")) {
        liveOpens += 1;
        return liveOpens === 1 ? closingSseResponse([controlReconnect(5)]) : openSseResponse();
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      reconnectInitialMs: 1,
      reconnectMaxMs: 5,
    });

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(async () => (await client.readLocalEntity("todo_1")) !== null);
    await waitFor(() => groupOffsets.some((url) => url.includes("offset=5")));

    // The stored cursor was 9 after the prior catch-up; the server's
    // stale-cursor signal widens the window back to 5.
    expect(groupOffsets.some((url) => url.includes("offset=9"))).toBe(false);

    unsubscribe();
  });

  it("re-sweeps entries written during catch-up against earlier pages", async () => {
    const firstPage = putAction({
      id: "act_page_one",
      gsn: 1,
      hlc: makeHlc(1711036800000, 1),
      updateId: "u_page_one",
      title: "Page one",
    });
    const pending = putAction({
      id: "act_local",
      gsn: 0,
      hlc: makeHlc(1711036800000),
      updateId: "u_local",
      title: "Local edit",
    });

    let resolveSecondPage!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecondPage = resolve;
    });
    let posted = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/groups/")) {
        if (url.includes("offset=0")) {
          return jsonResponse([firstPage], {
            "stream-next-offset": "1",
            "stream-up-to-date": "false",
          });
        }
        return secondPage;
      }
      if (url.includes("/sync/actions")) {
        posted += 1;
        return jsonResponse({ rejected: [] });
      }
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    // Page one is applied; the loop is now awaiting page two.
    await waitFor(async () => (await client.readLocalEntity("todo_1")) !== null);

    // A write during catch-up is deferred (not posted) and stays pending.
    await expect(client.write([pending])).rejects.toThrow(/checkpoint/);
    expect(await client.outbox.size("pending")).toBe(1);

    resolveSecondPage(emptyCatchUpResponse());

    // The checkpoint re-sweeps the whole missed window, so the entry that
    // arrived after page one is still caught by page one's LWW winner.
    await waitFor(async () => (await client.storage.conflicts.list()).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(posted).toBe(0);
    expect(await client.outbox.size("pending")).toBe(0);

    unsubscribe();
  });

  it("sweeps a pending Action that loses to a catch-up Action before any flush", async () => {
    const pending = putAction({
      id: "act_local",
      gsn: 0,
      hlc: makeHlc(1711036800000),
      updateId: "u_local",
      title: "Local edit",
    });
    const winning = putAction({
      id: "act_remote",
      gsn: 3,
      hlc: makeHlc(1711036800000, 1),
      updateId: "u_remote",
      title: "Remote edit",
    });

    const actionPosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/actions")) {
        actionPosts.push(url);
        return jsonResponse({ rejected: [] });
      }
      if (url.includes("/sync/groups/")) {
        return jsonResponse([winning], {
          "stream-next-offset": "3",
          "stream-up-to-date": "true",
        });
      }
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });
    await client.outbox.enqueue(pending);

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(async () => (await client.readLocalEntity("todo_1")) !== null);
    // Let the checkpoint flush run to completion.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(actionPosts).toHaveLength(0);
    const conflicts = await client.storage.conflicts.list();
    expect(conflicts.map((entry) => entry.action.id)).toContain("act_local");
    expect(await client.outbox.size("pending")).toBe(0);

    unsubscribe();
  });

  it("flushes a non-conflicting pending Action at the checkpoint", async () => {
    const pending = putAction({
      id: "act_local",
      gsn: 0,
      hlc: makeHlc(1711036800000),
      updateId: "u_local",
      title: "Local edit",
    });

    let posted = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/actions")) {
        posted += 1;
        return jsonResponse({ rejected: [] });
      }
      if (url.includes("/sync/groups/")) {
        return emptyCatchUpResponse();
      }
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });
    await client.outbox.enqueue(pending);

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(() => posted > 0);
    unsubscribe();
  });

  it("does not flush on a raw ConnectionState transition", async () => {
    const pending = putAction({
      id: "act_local",
      gsn: 0,
      hlc: makeHlc(1711036800000),
      updateId: "u_local",
      title: "Local edit",
    });

    let posted = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/actions")) {
        posted += 1;
        return jsonResponse({ rejected: [] });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });
    await client.outbox.enqueue(pending);

    // No subscription drives a catch-up, so these transitions must not
    // release anything onto the wire.
    client.setState("live");
    client.setState("connecting");
    client.setState("live");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(posted).toBe(0);
    client.close();
  });

  it("applies missed Actions after a server-requested reconnect", async () => {
    const missed = putAction({
      id: "act_after_reconnect",
      gsn: 6,
      hlc: makeHlc(1711036800000),
      updateId: "u_after",
      title: "After reconnect",
    });
    let liveOpens = 0;
    const groupOffsets: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/groups/")) {
        groupOffsets.push(url);
        if (url.includes("offset=0")) return emptyCatchUpResponse();
        return jsonResponse([missed], { "stream-next-offset": "6", "stream-up-to-date": "true" });
      }
      if (url.includes("/sync/live")) {
        liveOpens += 1;
        // The first stream reports a stale cursor, forcing a reconnect;
        // the second opens normally.
        return liveOpens === 1 ? closingSseResponse([controlReconnect(5)]) : openSseResponse();
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      reconnectInitialMs: 1,
      reconnectMaxMs: 5,
    });

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(async () => (await client.readLocalEntity("todo_1")) !== null);
    const entity = await client.readLocalEntity("todo_1");
    expect((entity!.data.fields.title as { value?: unknown }).value).toBe("After reconnect");
    expect(groupOffsets.some((url) => url.includes("offset=5"))).toBe(true);

    unsubscribe();
  });
});
