/**
 * Client wiring for the flush scheduler (#229). The scheduler's policy is
 * pinned by unit tests; these assert the client actually routes `write()`
 * through it: debounced batching, background retry after an unreachable
 * submit, terminal `partial`, and `close()` stopping the retry loop.
 *
 * Fake timers make every window deterministic, including the injected
 * `Date.now` the scheduler measures latency with. A `write()` under fake
 * timers only settles once its debounce fires, so each test starts the
 * write, advances the clock, then awaits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";

import { createClient } from "../client";
import { makeFetchMock, type FetchCall } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";
const DEBOUNCE_MS = 10;

/** A well-formed Action for a distinct entity, so batches stay independent. */
const mkAction = (id: string): Action => ({
  id,
  actor_id: ACTOR_ID,
  hlc: makeHlc(1_711_036_800_000),
  gsn: 0,
  updates: [
    {
      id: `u_${id}`,
      subject_id: `todo_${id}`,
      subject_type: "todo",
      method: "put",
      data: {
        fields: {
          title: { value: id, update_id: `u_${id}`, hlc: makeHlc(1_711_036_800_000) },
        },
      },
    },
  ],
});

const actionRequests = (calls: readonly FetchCall[]): FetchCall[] =>
  calls.filter((call) => call.url.endsWith("/sync/actions"));

const mkClient = (
  fetchImpl: typeof fetch,
  opts: { reconnectInitialMs?: number; reconnectMaxMs?: number } = {},
) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    fetchImpl,
    flushDebounceMs: DEBOUNCE_MS,
    reconnectInitialMs: opts.reconnectInitialMs ?? 100,
    reconnectMaxMs: opts.reconnectMaxMs ?? 400,
  });

describe("client.write flush scheduling (#229)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid writes into one /sync/actions request", async () => {
    const { fn, calls } = makeFetchMock([{ body: JSON.stringify({ rejected: [] }) }]);
    const client = mkClient(fn);

    const writes = ["a", "b", "c"].map((id) => client.write([mkAction(id)]));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await Promise.all(writes);

    expect(actionRequests(calls)).toHaveLength(1);
    expect(client.outbox.size("acknowledged")).toBe(3);
    client.close();
  });

  it("keeps an unreachable entry pending and retries it with backoff", async () => {
    const { fn, calls } = makeFetchMock([
      { status: 500, body: "boom" },
      { body: JSON.stringify({ rejected: [] }) },
    ]);
    const client = mkClient(fn);

    const write = client.write([mkAction("a")]);
    const failed = expect(write).rejects.toThrow(/write failed: 500/);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await failed;
    expect(actionRequests(calls)).toHaveLength(1);
    expect(client.outbox.size("pending")).toBe(1);

    // Nothing happens inside the first backoff interval.
    await vi.advanceTimersByTimeAsync(50);
    expect(actionRequests(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(actionRequests(calls)).toHaveLength(2);
    expect(client.outbox.size("pending")).toBe(0);
    expect(client.outbox.size("acknowledged")).toBe(1);
    client.close();
  });

  it("resets the backoff after a successful retry", async () => {
    const { fn, calls } = makeFetchMock([
      { status: 500, body: "boom" }, // first attempt of write A fails
      { body: JSON.stringify({ rejected: [] }) }, // retry of A succeeds
      { status: 500, body: "boom" }, // first attempt of write B fails
      { body: JSON.stringify({ rejected: [] }) }, // retry of B succeeds
    ]);
    const client = mkClient(fn);

    const writeA = client.write([mkAction("a")]);
    const failedA = expect(writeA).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await failedA;
    expect(actionRequests(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100); // A's retry succeeds, attempt resets
    expect(actionRequests(calls)).toHaveLength(2);

    const writeB = client.write([mkAction("b")]);
    const failedB = expect(writeB).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await failedB;
    expect(actionRequests(calls)).toHaveLength(3);

    // B's retry waits the initial interval, not a doubled one.
    await vi.advanceTimersByTimeAsync(100);
    expect(actionRequests(calls)).toHaveLength(4);
    client.close();
  });

  it("never retries a rejected (partial) flush", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ rejected: [{ id: "a", reason: "permission_denied" }] }) },
    ]);
    const client = mkClient(fn);

    const write = client.write([mkAction("a")]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    const response = await write;
    expect(response.rejected).toEqual([{ id: "a", reason: "permission_denied" }]);
    expect(actionRequests(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionRequests(calls)).toHaveLength(1);
    expect(client.outbox.errors().map((entry) => entry.action.id)).toEqual(["a"]);
    client.close();
  });

  it("close() stops the retry loop", async () => {
    const { fn, calls } = makeFetchMock([{ status: 500, body: "boom" }]);
    const client = mkClient(fn);

    const write = client.write([mkAction("a")]);
    const failed = expect(write).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await failed;
    expect(actionRequests(calls)).toHaveLength(1);

    client.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it("reports flush latency once a flush resolves", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify({ rejected: [] }) }]);
    const client = mkClient(fn);

    expect(client.flushLatency).toBeNull();
    const write = client.write([mkAction("a")]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    await write;
    expect(client.flushLatency).not.toBeNull();
    expect(client.flushLatency).toBeGreaterThanOrEqual(0);
    client.close();
  });
});
