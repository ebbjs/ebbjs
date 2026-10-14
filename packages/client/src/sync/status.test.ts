/**
 * Unit tests for the aggregate client status (#371).
 *
 * Built over `createObservable` children so a transition can be driven
 * one child at a time and the aggregate's dedupe and unsubscribe
 * behaviour asserted directly.
 */

import { describe, it, expect, vi } from "vitest";

import { ConnectionStateMachine } from "./connection-state";
import type { ConflictSnapshot } from "./conflicts";
import { createObservable } from "./observable";
import type { OutboxSnapshot } from "./outbox-observer";
import { createClientStatus } from "./status";

const emptyOutbox = (): OutboxSnapshot => ({
  pending: 0,
  acknowledged: 0,
  error: 0,
  conflicted: 0,
  flushLatency: null,
  storeFaults: 0,
});

const emptyConflicts = (): ConflictSnapshot => ({ count: 0, conflicts: [] });

const mkHarness = () => {
  const connection = new ConnectionStateMachine();
  const outbox = createObservable<OutboxSnapshot>(emptyOutbox());
  const conflicts = createObservable<ConflictSnapshot>(emptyConflicts());
  let clock = 1_000;
  const controller = createClientStatus({
    connection,
    outbox,
    conflicts,
    now: () => clock,
  });
  return {
    connection,
    outbox,
    conflicts,
    ...controller,
    tick: (ms: number) => {
      clock += ms;
    },
  };
};

describe("createClientStatus", () => {
  it("reads the initial aggregate from its children", () => {
    const { status } = mkHarness();

    expect(status.get()).toEqual({
      connection: "connecting",
      lastSyncedAt: null,
      outbox: {
        pending: 0,
        acknowledged: 0,
        error: 0,
        conflicted: 0,
        flushLatency: null,
        storeFaults: 0,
      },
      conflicts: { count: 0, conflicts: [] },
    });
  });

  it("notifies subscribers on an outbox change", () => {
    const { status, outbox } = mkHarness();
    const listener = vi.fn();
    status.subscribe(listener);

    const next: OutboxSnapshot = {
      pending: 1,
      acknowledged: 2,
      error: 3,
      conflicted: 4,
      flushLatency: 25,
      storeFaults: 0,
    };
    outbox.set(next);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(status.get().outbox).toBe(next);
  });

  it("notifies subscribers on a conflicts change", () => {
    const { status, conflicts } = mkHarness();
    const listener = vi.fn();
    status.subscribe(listener);

    const next: ConflictSnapshot = { count: 2, conflicts: [] };
    conflicts.set(next);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ conflicts: next }));
    expect(status.get().conflicts).toBe(next);
  });

  it("notifies subscribers on a connection transition", () => {
    const { status, connection } = mkHarness();
    const listener = vi.fn();
    status.subscribe(listener);

    connection.transition("live");

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ connection: "live" }));
  });

  it("does not fire on subscription despite the connection machine's deferred replay", async () => {
    const { status } = mkHarness();
    const listener = vi.fn();
    status.subscribe(listener);

    await Promise.resolve();
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });

  it("carries lastSyncedAt and advances it monotonically", () => {
    const { status, markSynced, tick } = mkHarness();
    const listener = vi.fn();
    status.subscribe(listener);

    markSynced();
    expect(status.get().lastSyncedAt).toBe(1_000);

    tick(500);
    markSynced();
    expect(status.get().lastSyncedAt).toBe(1_500);

    // An out-of-order timestamp never moves the clock backwards.
    markSynced(1_200);
    expect(status.get().lastSyncedAt).toBe(1_500);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying a subscriber after unsubscribe", () => {
    const { status, outbox } = mkHarness();
    const listener = vi.fn();
    const unsubscribe = status.subscribe(listener);

    unsubscribe();
    outbox.set({
      pending: 1,
      acknowledged: 0,
      error: 0,
      conflicted: 0,
      flushLatency: null,
      storeFaults: 0,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
