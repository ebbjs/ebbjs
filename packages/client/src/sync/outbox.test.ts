/**
 * Unit tests for the `Outbox` seam. The module is storage-agnostic:
 * it owns the ordered pending list and delegates optimistic apply,
 * network submission, and durable buffering through its injected
 * dependencies. These tests pin that contract with fakes so the
 * client integration tests can focus on the wiring.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import type { Action } from "@ebbjs/core";
import type { OutboxEntry as StoredOutboxEntry, OutboxStore } from "@ebbjs/storage/types";

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

/** A stored entry with a given HLC; the status defaults to `pending`. */
const stored = (
  action: Action,
  enqueuedAtHlc: string,
  status: StoredOutboxEntry["status"] = "pending",
): StoredOutboxEntry => ({ action, status, enqueuedAtHlc });

/**
 * In-test OutboxStore. `list()` returns rows in insertion order, so a
 * test can seed an order the outbox must re-sort by `enqueuedAtHlc`.
 */
const mkStore = (
  initial: readonly StoredOutboxEntry[] = [],
): OutboxStore & { rows: Map<string, StoredOutboxEntry> } => {
  const rows = new Map(initial.map((entry) => [entry.action.id, entry]));
  return {
    rows,
    put: vi.fn(async (entry: StoredOutboxEntry) => {
      rows.set(entry.action.id, structuredClone(entry));
    }),
    list: vi.fn(async () => [...rows.values()].map((entry) => structuredClone(entry))),
    get: vi.fn(async (id: string) => {
      const entry = rows.get(id);
      return entry === undefined ? null : structuredClone(entry);
    }),
    delete: vi.fn(async (id: string) => {
      rows.delete(id);
    }),
    clear: vi.fn(async () => {
      rows.clear();
    }),
  };
};

/** Deps with recording fakes; overrides let a test swap one behavior. */
const mkDeps = (
  overrides: Partial<OutboxDependencies> = {},
): OutboxDependencies & {
  applied: Action[];
  submitted: (readonly Action[])[];
} => {
  const applied: Action[] = [];
  const submitted: (readonly Action[])[] = [];
  let clock = 0;
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
    store: mkStore(),
    hlc: vi.fn(() => String(++clock)),
    ...overrides,
  };
};

const callOrder = (mock: unknown): number => (mock as Mock).mock.invocationCallOrder[0] as number;

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
    expect(outbox.pending()).toEqual<readonly OutboxEntry[]>([
      { action, status: "pending", enqueuedAtHlc: "1" },
    ]);
    expect(deps.applied).toEqual([action]);
  });

  it("persists the exact entry on enqueue", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");

    await outbox.enqueue(action);

    expect(deps.store.put).toHaveBeenCalledWith({
      action,
      status: "pending",
      enqueuedAtHlc: "1",
    });
  });

  it("persists before applying optimistically", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);

    await outbox.enqueue(mkAction("a_1"));

    expect(callOrder(deps.store.put)).toBeLessThan(callOrder(deps.applyOptimistic));
  });

  it("keeps the in-memory queue and the store in agreement", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);

    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));

    expect(outbox.pending()).toEqual(await deps.store.list());
  });

  it("does not buffer or apply when the store write throws", async () => {
    const store: OutboxStore = {
      ...mkStore(),
      put: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    await expect(outbox.enqueue(mkAction("a_1"))).rejects.toThrow("disk full");

    expect(outbox.size()).toBe(0);
    expect(deps.applied).toEqual([]);
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
    snapshot.push({ action: mkAction("a_2"), status: "pending", enqueuedAtHlc: "2" });

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

describe("createOutbox rehydration", () => {
  it("rehydrate seeds pending entries sorted by enqueuedAtHlc regardless of store order", async () => {
    const first = mkAction("a_1");
    const second = mkAction("a_2");
    const third = mkAction("a_3");
    const store = mkStore([stored(third, "30"), stored(first, "10"), stored(second, "20")]);
    const outbox = createOutbox(mkDeps({ store }));

    await outbox.rehydrate();

    expect(outbox.pending()).toEqual<readonly OutboxEntry[]>([
      { action: first, status: "pending", enqueuedAtHlc: "10" },
      { action: second, status: "pending", enqueuedAtHlc: "20" },
      { action: third, status: "pending", enqueuedAtHlc: "30" },
    ]);
  });

  it("rehydrate ignores acknowledged and errored entries", async () => {
    const store = mkStore([
      stored(mkAction("a_ack"), "1", "acknowledged"),
      stored(mkAction("a_pending"), "2"),
      stored(mkAction("a_error"), "3", "error"),
    ]);
    const outbox = createOutbox(mkDeps({ store }));

    await outbox.rehydrate();

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_pending"]);
  });

  it("rehydrate does not re-apply optimistically", async () => {
    const store = mkStore([stored(mkAction("a_1"), "1")]);
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    await outbox.rehydrate();

    expect(deps.applied).toEqual([]);
  });

  it("rehydrate is single-flight and idempotent", async () => {
    const store = mkStore([stored(mkAction("a_1"), "1")]);
    const outbox = createOutbox(mkDeps({ store }));

    await Promise.all([outbox.rehydrate(), outbox.rehydrate()]);
    await outbox.rehydrate();

    expect(outbox.size()).toBe(1);
    expect(store.list).toHaveBeenCalledTimes(1);
  });

  it("loads persisted entries eagerly, without a caller invoking rehydrate", async () => {
    const action = mkAction("a_1");
    const store = mkStore([stored(action, "1")]);
    const outbox = createOutbox(mkDeps({ store }));

    expect(store.list).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(outbox.pending()).toEqual<readonly OutboxEntry[]>([
        { action, status: "pending", enqueuedAtHlc: "1" },
      ]);
    });
  });

  it("flushes rehydrated entries without an explicit rehydrate call", async () => {
    const action = mkAction("a_1");
    const store = mkStore([stored(action, "1")]);
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    await outbox.flush();

    expect(deps.submitted).toEqual([[action]]);
    expect(outbox.size()).toBe(0);
  });

  it("serializes enqueue behind an in-flight rehydration", async () => {
    let releaseList: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const persisted = mkAction("a_persisted");
    const base = mkStore([stored(persisted, "1")]);
    const store: OutboxStore = {
      ...base,
      list: vi.fn(async () => {
        await gate;
        return base.list();
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    const enqueueing = outbox.enqueue(mkAction("a_new"));
    releaseList!();
    await enqueueing;

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_persisted", "a_new"]);
  });

  it("retries after a failed list() instead of bricking later writes", async () => {
    const persisted = mkAction("a_persisted");
    const base = mkStore([stored(persisted, "1")]);
    let calls = 0;
    const store: OutboxStore = {
      ...base,
      list: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("store unavailable");
        return base.list();
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    await expect(outbox.enqueue(mkAction("a_first"))).rejects.toThrow("store unavailable");

    await outbox.enqueue(mkAction("a_second"));

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_persisted", "a_second"]);
    expect(deps.store.put).toHaveBeenCalledWith({
      action: mkAction("a_second"),
      status: "pending",
      enqueuedAtHlc: "1",
    });
    expect(deps.applied).toEqual([mkAction("a_second")]);
  });

  it("a later rehydrate() retries and seeds after one that failed", async () => {
    const persisted = mkAction("a_persisted");
    const base = mkStore([stored(persisted, "1")]);
    let failing = true;
    const store: OutboxStore = {
      ...base,
      list: vi.fn(async () => {
        if (failing) {
          failing = false;
          throw new Error("store unavailable");
        }
        return base.list();
      }),
    };
    const outbox = createOutbox(mkDeps({ store }));

    await expect(outbox.rehydrate()).rejects.toThrow("store unavailable");
    await outbox.rehydrate();

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_persisted"]);
  });
});
