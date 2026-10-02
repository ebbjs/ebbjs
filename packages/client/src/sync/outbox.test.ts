/**
 * Unit tests for the `Outbox` seam. The module is storage-agnostic:
 * it owns the ordered pending list and delegates optimistic apply +
 * network submission through its injected dependencies. These tests
 * pin that contract with fakes so the client integration tests can
 * focus on the wiring.
 */

import { describe, it, expect, vi } from "vitest";
import type { Action } from "@ebbjs/core";

import { createOutbox, type OutboxDependencies, type OutboxEntry } from "./outbox";

/** Minimal well-formed Action; only the identity matters to the outbox. */
const mkAction = (id: string): Action => ({
  id,
  actor_id: "actor_1",
  hlc: "1",
  gsn: 0,
  updates: [
    {
      id: `u_${id}`,
      subject_id: `e_${id}`,
      subject_type: "todo",
      method: "put",
      data: { fields: {} },
    },
  ],
});

/** Deps with recording fakes; overrides let a test swap one behavior. */
const mkDeps = (
  overrides: Partial<OutboxDependencies> = {},
): OutboxDependencies & {
  applied: Action[];
  submitted: (readonly Action[])[];
} => {
  const applied: Action[] = [];
  const submitted: (readonly Action[])[] = [];
  return {
    applied,
    submitted,
    applyOptimistic: vi.fn(async (action: Action) => {
      applied.push(action);
    }),
    submit: vi.fn(async (actions: readonly Action[]) => {
      submitted.push(actions);
      return { rejected: [] };
    }),
    ...overrides,
  };
};

describe("createOutbox", () => {
  it("starts empty", () => {
    const outbox = createOutbox(mkDeps());
    expect(outbox.size()).toBe(0);
    expect(outbox.pending()).toEqual([]);
  });

  it("enqueue appends a pending entry and optimistically applies the action", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");

    await outbox.enqueue(action);

    expect(outbox.size()).toBe(1);
    expect(outbox.pending()).toEqual<readonly OutboxEntry[]>([{ action, status: "pending" }]);
    expect(deps.applied).toEqual([action]);
  });

  it("enqueue preserves insertion order", async () => {
    const outbox = createOutbox(mkDeps());
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));
    await outbox.enqueue(mkAction("a_3"));

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_1", "a_2", "a_3"]);
  });

  it("pending() returns a snapshot that callers cannot use to mutate the queue", async () => {
    const outbox = createOutbox(mkDeps());
    await outbox.enqueue(mkAction("a_1"));

    const snapshot = outbox.pending() as OutboxEntry[];
    snapshot.push({ action: mkAction("a_2"), status: "pending" });

    expect(outbox.size()).toBe(1);
  });

  it("flush() with nothing pending resolves empty without submitting", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);

    const response = await outbox.flush();

    expect(response).toEqual({ rejected: [] });
    expect(deps.submitted).toEqual([]);
  });

  it("flush() submits the pending actions in order as a single batch", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));

    await outbox.flush();

    expect(deps.submitted).toHaveLength(1);
    expect(deps.submitted[0]?.map((action) => action.id)).toEqual(["a_1", "a_2"]);
  });

  it("flush() returns the submit response and clears the submitted entries", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({
      submit: vi.fn(async () => ({ rejected: [rejection] })),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const response = await outbox.flush();

    expect(response.rejected).toEqual([rejection]);
    expect(outbox.size()).toBe(0);
  });

  it("flush() leaves the entries pending when submission throws", async () => {
    const deps = mkDeps({
      submit: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    await expect(outbox.flush()).rejects.toThrow("network down");
    expect(outbox.size()).toBe(1);
    expect(outbox.pending()[0]?.action.id).toBe("a_1");
  });

  it("keeps entries enqueued during an in-flight flush pending", async () => {
    let releaseSubmit: (() => void) | null = null;
    const deps = mkDeps({
      submit: vi.fn(async (actions: readonly Action[]) => {
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
        return { rejected: actions.map((action) => ({ id: action.id, reason: "x" })) };
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const inFlight = outbox.flush();
    await outbox.enqueue(mkAction("a_2"));
    releaseSubmit!();
    await inFlight;

    // a_1 was submitted and removed; a_2 was enqueued after the snapshot.
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_2"]);
  });
});
