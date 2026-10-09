/**
 * Unit tests for the `Outbox` seam. The module is storage-agnostic:
 * it owns the ordered pending list and delegates optimistic apply,
 * network submission, and durable buffering through its injected
 * dependencies. These tests pin that contract with fakes so the
 * client integration tests can focus on the wiring.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import type { Action, FieldValue } from "@ebbjs/core";
import type {
  ConflictEntry,
  ConflictStore,
  OutboxEntry as StoredOutboxEntry,
  OutboxStore,
} from "@ebbjs/storage/types";

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

/**
 * Action carrying explicit field values so a conflict fixture can pin
 * the HLCs and update ids the LWW comparison reads.
 */
const mkFieldAction = (args: {
  id: string;
  subjectId: string;
  fields: Record<string, FieldValue>;
  subjectType?: string;
  method?: "put" | "patch";
  gsn?: number;
}): Action => ({
  id: args.id,
  actor_id: "actor_1",
  hlc: Object.values(args.fields)[0]?.hlc ?? "1",
  gsn: args.gsn ?? 0,
  updates: [
    {
      id: `u_${args.id}`,
      subject_id: args.subjectId,
      subject_type: args.subjectType ?? "todo",
      method: args.method ?? "patch",
      data: { fields: args.fields },
    },
  ],
});

/** A single conflict slot on `todo_1` by default. */
const slot = (field: string, path: readonly string[] = [], subjectId = "todo_1") => ({
  subjectId,
  field,
  path,
});

/** The losing slots of a conflict entry, in detection order. */
const slotsOf = (entry: ConflictEntry | undefined) =>
  entry === undefined ? [] : entry.losses.map((loss) => loss.slot);

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

/** In-test ConflictStore with a visible row map, mirroring `mkStore`. */
const mkConflicts = (
  initial: readonly ConflictEntry[] = [],
): ConflictStore & { rows: Map<string, ConflictEntry> } => {
  const rows = new Map(initial.map((entry) => [entry.action.id, entry]));
  return {
    rows,
    put: vi.fn(async (entry: ConflictEntry) => {
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
    conflicts: mkConflicts(),
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

    const outcome = await outbox.flush();

    expect(outcome).toEqual({ kind: "empty" });
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

  it("flush() marks rejected entries error, persists them, and retains them", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({
      submit: vi.fn(async () => ({ rejected: [rejection] })),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const outcome = await outbox.flush();

    expect(outcome).toEqual({ kind: "partial", accepted: [], rejected: [rejection] });
    expect(outbox.size("pending")).toBe(0);
    expect(outbox.size("error")).toBe(1);
    expect(outbox.errors().map((entry) => entry.action.id)).toEqual(["a_1"]);
    expect((await deps.store.get("a_1"))?.status).toBe("error");
  });

  it("flush() reports unreachable and leaves the entries pending when submission throws", async () => {
    const boom = new Error("network down");
    const deps = mkDeps({
      submit: vi.fn(async () => {
        throw boom;
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const outcome = await outbox.flush();

    expect(outcome).toEqual({ kind: "unreachable", error: boom });
    expect(outbox.size()).toBe(1);
    expect(outbox.pending()[0]?.action.id).toBe("a_1");
    expect((await deps.store.get("a_1"))?.status).toBe("pending");
  });

  it("keeps entries enqueued during an in-flight flush pending", async () => {
    let releaseSubmit: (() => void) | null = null;
    const deps = mkDeps({
      submit: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
        return { rejected: [] };
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const inFlight = outbox.flush();
    await outbox.enqueue(mkAction("a_2"));
    releaseSubmit!();
    const outcome = await inFlight;

    // a_1 was submitted and acknowledged; a_2 was enqueued after the
    // snapshot, so it is not part of this flush and stays pending.
    expect(outcome).toEqual({ kind: "accepted", actionIds: ["a_1"] });
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_2"]);
    expect(outbox.size("acknowledged")).toBe(1);
  });
});

describe("createOutbox lifecycle", () => {
  it("accepted entries become acknowledged, persisted, and are never re-flushed", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));

    const outcome = await outbox.flush();

    expect(outcome).toEqual({ kind: "accepted", actionIds: ["a_1", "a_2"] });
    expect(outbox.size("pending")).toBe(0);
    expect(outbox.size("acknowledged")).toBe(2);
    expect((await deps.store.get("a_1"))?.status).toBe("acknowledged");

    // A second flush finds nothing pending and does not re-submit.
    await expect(outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(deps.submitted).toHaveLength(1);
  });

  it("partial: accepted entries acknowledged, rejected entries error and retained", async () => {
    const rejection = { id: "a_2", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));

    const outcome = await outbox.flush();

    expect(outcome).toEqual({ kind: "partial", accepted: ["a_1"], rejected: [rejection] });
    expect(outbox.size("pending")).toBe(0);
    expect(outbox.size("acknowledged")).toBe(1);
    expect(outbox.errors().map((entry) => entry.action.id)).toEqual(["a_2"]);
    expect((await deps.store.get("a_1"))?.status).toBe("acknowledged");
    expect((await deps.store.get("a_2"))?.status).toBe("error");
  });

  it("size() defaults to the pending backlog and filters by status", async () => {
    const rejection = { id: "a_2", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));
    await outbox.flush();
    await outbox.enqueue(mkAction("a_3"));

    expect(outbox.size()).toBe(1);
    expect(outbox.size("pending")).toBe(1);
    expect(outbox.size("acknowledged")).toBe(1);
    expect(outbox.size("error")).toBe(1);
  });

  it("does not resurrect an entry whose echo arrives while the flush is in flight", async () => {
    let releaseSubmit: (() => void) | null = null;
    const deps = mkDeps({
      submit: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
        return { rejected: [] };
      }),
    });
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const inFlight = outbox.flush();
    await outbox.noteInbound({ ...action, gsn: 5 });
    releaseSubmit!();
    await inFlight;

    expect(outbox.size()).toBe(0);
    expect(outbox.size("acknowledged")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("re-deletes when an echo's delete interleaves with the flush put", async () => {
    let releasePut: (() => void) | null = null;
    const base = mkStore();
    const store: OutboxStore = {
      ...base,
      put: vi.fn(async (entry: StoredOutboxEntry) => {
        // Delay only the flush transition, not the enqueue write.
        if (entry.status !== "pending") {
          await new Promise<void>((resolve) => {
            releasePut = resolve;
          });
        }
        await base.put(entry);
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const inFlight = outbox.flush();
    await vi.waitFor(() => {
      expect(releasePut).not.toBeNull();
    });
    await outbox.noteInbound({ ...action, gsn: 9 });
    releasePut!();
    await inFlight;

    expect(outbox.size("acknowledged")).toBe(0);
    expect(await store.get("a_1")).toBeNull();
  });

  it("a store failure while persisting a transition leaves the batch pending", async () => {
    const base = mkStore();
    let puts = 0;
    const store: OutboxStore = {
      ...base,
      put: vi.fn(async (entry: StoredOutboxEntry) => {
        puts += 1;
        if (puts > 1) throw new Error("disk full");
        await base.put(entry);
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    await expect(outbox.flush()).rejects.toThrow("disk full");

    // No acknowledged transition was durable, so the entry stays
    // flushable rather than stuck awaiting an echo that already
    // happened.
    expect(outbox.size("pending")).toBe(1);
    expect(outbox.size("acknowledged")).toBe(0);
  });

  it("commits per entry so a mid-batch failure keeps memory and store aligned", async () => {
    const base = mkStore();
    let puts = 0;
    const store: OutboxStore = {
      ...base,
      put: vi.fn(async (entry: StoredOutboxEntry) => {
        puts += 1;
        // Two enqueues, then fail the second flush transition.
        if (puts > 3) throw new Error("disk full");
        await base.put(entry);
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));

    await expect(outbox.flush()).rejects.toThrow("disk full");

    // a_1's transition was durable and committed to memory; a_2's was not,
    // and both states agree with the store.
    expect(outbox.size("acknowledged")).toBe(1);
    expect(outbox.size("pending")).toBe(1);
    expect((await store.get("a_1"))?.status).toBe("acknowledged");
    expect((await store.get("a_2"))?.status).toBe("pending");
  });

  it("coalesces concurrent flushes into one submit", async () => {
    let release: (() => void) | null = null;
    const calls: (readonly Action[])[] = [];
    const deps = mkDeps({
      submit: vi.fn(async (actions: readonly Action[]) => {
        calls.push(actions);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { rejected: [] };
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    const first = outbox.flush();
    const second = outbox.flush();
    await vi.waitFor(() => {
      expect(release).not.toBeNull();
    });
    release!();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(a).toEqual({ kind: "accepted", actionIds: ["a_1"] });
    expect(b).toEqual(a);
  });

  it("does not re-flush an errored entry until retry()", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    let submits = 0;
    const deps = mkDeps({
      submit: vi.fn(async () => {
        submits += 1;
        return { rejected: [rejection] };
      }),
    });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.flush();

    await expect(outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(submits).toBe(1);
  });

  it("rehydrate seeds acknowledged entries without re-applying them", async () => {
    const action = mkAction("a_1");
    const store = mkStore([stored(action, "1", "acknowledged")]);
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);

    await outbox.rehydrate();

    expect(deps.applied).toEqual([]);
    expect(outbox.size("acknowledged")).toBe(1);
  });
});

describe("createOutbox noteInbound", () => {
  it("removes an acknowledged entry on its own echo and reports it", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);
    await outbox.flush();

    const outcome = await outbox.noteInbound({ ...action, gsn: 7 });

    expect(outcome).toEqual({ kind: "echo", actionId: "a_1" });
    expect(outbox.size("acknowledged")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("removes a still-pending entry when its echo arrives first", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const outcome = await outbox.noteInbound({ ...action, gsn: 3 });

    expect(outcome).toEqual({ kind: "echo", actionId: "a_1" });
    expect(outbox.size("pending")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("ignores an inbound Action with gsn 0", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const outcome = await outbox.noteInbound({ ...action, gsn: 0 });

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.size("pending")).toBe(1);
  });

  it("ignores an inbound Action that matches no buffered entry", async () => {
    const outbox = createOutbox(mkDeps());

    const outcome = await outbox.noteInbound({ ...mkAction("a_other"), gsn: 9 });

    expect(outcome).toEqual({ kind: "none" });
  });

  it("does not remove an errored entry on a matching echo", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);
    await outbox.flush();

    const outcome = await outbox.noteInbound({ ...action, gsn: 4 });

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.size("error")).toBe(1);
  });

  it("matches a rehydrated acknowledged entry", async () => {
    const action = mkAction("a_1");
    const store = mkStore([stored(action, "1", "acknowledged")]);
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    await outbox.rehydrate();

    const outcome = await outbox.noteInbound({ ...action, gsn: 12 });

    expect(outcome).toEqual({ kind: "echo", actionId: "a_1" });
    expect(outbox.size("acknowledged")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("returns none instead of throwing when the store read fails", async () => {
    const store: OutboxStore = {
      ...mkStore(),
      list: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const outbox = createOutbox(mkDeps({ store }));

    await expect(outbox.noteInbound({ ...mkAction("a_1"), gsn: 3 })).resolves.toEqual({
      kind: "none",
    });
  });

  it("keeps the entry when the store delete fails", async () => {
    const action = mkAction("a_1");
    const store: OutboxStore = {
      ...mkStore(),
      delete: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    await outbox.enqueue(action);

    await expect(outbox.noteInbound({ ...action, gsn: 3 })).resolves.toEqual({ kind: "none" });
    expect(outbox.size("pending")).toBe(1);
    expect(await deps.store.get("a_1")).not.toBeNull();
  });
});

describe("createOutbox conflict detection", () => {
  /** Enqueue one pending entry and return its inbound higher-HLC peer. */
  const seed = async (
    deps: ReturnType<typeof mkDeps>,
    localHlc = "10",
    localUpdateId = "u_local",
  ): Promise<{ outbox: ReturnType<typeof createOutbox>; local: Action }> => {
    const outbox = createOutbox(deps);
    const local = mkFieldAction({
      id: "a_local",
      subjectId: "todo_1",
      fields: { title: { value: "mine", update_id: localUpdateId, hlc: localHlc } },
    });
    await outbox.enqueue(local);
    return { outbox, local };
  };

  it("moves a pending entry whose LWW field loses, whole, into the Conflicts store", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_local", slots: [slot("title")] });
    expect(outbox.pending()).toEqual([]);
    expect(await deps.store.get("a_local")).toBeNull();
    const conflicts = await deps.conflicts.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.action.id).toBe("a_local");
    expect(slotsOf(conflicts[0])).toEqual([slot("title")]);
    expect(conflicts[0]?.losses).toEqual([
      { slot: slot("title"), winner: { update_id: "u_peer", hlc: "20", value: "theirs" } },
    ]);
    expect(conflicts[0]?.detectedAtHlc).toBe("2");
  });

  it("does not flag a concurrent write to a different map key", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: { content: { map: { a: { value: "mine", update_id: "u_local", hlc: "10" } } } },
      }),
    );

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { content: { map: { b: { value: "theirs", update_id: "u_peer", hlc: "20" } } } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(await deps.conflicts.list()).toEqual([]);
  });

  it("flags only the map key the inbound write out-dates", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: {
          content: {
            map: {
              a: { value: "mine", update_id: "u_local", hlc: "10" },
              b: { value: "kept", update_id: "u_local", hlc: "10" },
            },
          },
        },
      }),
    );

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { content: { map: { a: { value: "theirs", update_id: "u_peer", hlc: "20" } } } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({
      kind: "conflict",
      actionId: "a_local",
      slots: [slot("content", ["a"])],
    });
    const [entry] = await deps.conflicts.list();
    expect(entry?.losses).toEqual([
      {
        slot: slot("content", ["a"]),
        winner: { update_id: "u_peer", hlc: "20", value: "theirs" },
      },
    ]);
  });

  it("never posts a moved entry on a later flush", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);
    await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    await expect(outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(deps.submitted).toEqual([]);
  });

  it("keeps a pending entry that out-dates the inbound write", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps, "30");

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(await deps.conflicts.list()).toEqual([]);
  });

  it("breaks an equal-HLC tie toward the greater update_id", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps, "10", "u_b");

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_c", hlc: "10" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_local", slots: [slot("title")] });
  });

  it("lets an equal-HLC, equal-update_id inbound write win", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps, "10", "u_same");

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_same", hlc: "10" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_local", slots: [slot("title")] });
  });

  it("never flags a field the schema reports as non-LWW", async () => {
    const deps = mkDeps({ isLwwField: (_type, field) => field !== "count" });
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: {
          title: { value: "mine", update_id: "u_local", hlc: "10" },
          count: { value: 1, update_id: "u_local", hlc: "10" },
        },
      }),
    );

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: {
          title: { value: "theirs", update_id: "u_peer", hlc: "20" },
          count: { value: 2, update_id: "u_peer", hlc: "20" },
        },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_local", slots: [slot("title")] });
    expect(slotsOf((await deps.conflicts.list())[0])).toEqual([slot("title")]);
  });

  it("never flags structural relationship or membership edges", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    for (const subjectType of ["relationship", "entityGroup", "groupMember"]) {
      await outbox.enqueue(
        mkFieldAction({
          id: `a_${subjectType}`,
          subjectId: `row_${subjectType}`,
          subjectType,
          fields: { value: { value: "mine", update_id: "u_local", hlc: "10" } },
        }),
      );
      const outcome = await outbox.noteInbound(
        mkFieldAction({
          id: `a_peer_${subjectType}`,
          subjectId: `row_${subjectType}`,
          subjectType,
          fields: { value: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      );
      expect(outcome).toEqual({ kind: "none" });
    }

    expect(outbox.pending()).toHaveLength(3);
    expect(await deps.conflicts.list()).toEqual([]);
  });

  it("never flags a delete, which carries no fields", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);
    const deletion: Action = {
      id: "a_delete",
      actor_id: "actor_1",
      hlc: "20",
      gsn: 5,
      updates: [
        {
          id: "u_delete",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "delete",
          data: null,
        },
      ],
    };

    await expect(outbox.noteInbound(deletion)).resolves.toEqual({ kind: "none" });
    expect(outbox.pending()).toHaveLength(1);
  });

  it("moves every losing pending entry and reports the first in buffer order", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_first",
        subjectId: "todo_1",
        fields: { title: { value: "one", update_id: "u_a", hlc: "10" } },
      }),
    );
    await outbox.enqueue(
      mkFieldAction({
        id: "a_second",
        subjectId: "todo_1",
        fields: { title: { value: "two", update_id: "u_b", hlc: "11" } },
      }),
    );

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_first", slots: [slot("title")] });
    expect((await deps.conflicts.list()).map((entry) => entry.action.id).sort()).toEqual([
      "a_first",
      "a_second",
    ]);
    expect(outbox.pending()).toEqual([]);
  });

  it("leaves a non-targeted field's entry pending", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);
    await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_2",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
  });

  it("moves an acknowledged entry to the Conflicts store when a peer out-dates it", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: { title: { value: "mine", update_id: "u_local", hlc: "10" } },
      }),
    );
    await outbox.flush();

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "conflict", actionId: "a_local", slots: [slot("title")] });
    expect(outbox.size("acknowledged")).toBe(0);
    expect((await deps.conflicts.list()).map((entry) => entry.action.id)).toEqual(["a_local"]);
  });

  it("echo takes precedence over a conflicting write", async () => {
    const deps = mkDeps();
    const { outbox, local } = await seed(deps);

    const outcome = await outbox.noteInbound({ ...local, gsn: 5 });

    expect(outcome).toEqual({ kind: "echo", actionId: "a_local" });
    expect(outbox.pending()).toEqual([]);
    expect(await deps.conflicts.list()).toEqual([]);
  });

  it("keeps the entry pending when the conflicts store write fails", async () => {
    const conflicts: ConflictStore = {
      ...mkConflicts(),
      put: vi.fn(async () => {
        throw new Error("conflicts unavailable");
      }),
    };
    const deps = mkDeps({ conflicts });
    const { outbox } = await seed(deps);

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(await deps.store.get("a_local")).not.toBeNull();
  });

  it("rolls the conflict back and keeps the entry pending when the outbox delete fails", async () => {
    const deps = mkDeps();
    const store: OutboxStore = {
      ...deps.store,
      delete: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const conflictStore = mkConflicts();
    const scoped = mkDeps({ store, conflicts: conflictStore });
    const { outbox } = await seed(scoped);

    const outcome = await outbox.noteInbound(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(outcome).toEqual({ kind: "none" });
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(await conflictStore.list()).toEqual([]);
  });
});

describe("createOutbox error handling", () => {
  const mkErrored = async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.flush();
    return { deps, outbox };
  };

  it("errors() exposes errored entries with their action", async () => {
    const { outbox } = await mkErrored();

    const errors = outbox.errors();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.action.id).toBe("a_1");
    expect(errors[0]?.status).toBe("error");
  });

  it("retry() returns an errored entry to pending and re-flushes it", async () => {
    const { deps, outbox } = await mkErrored();

    await outbox.retry("a_1");

    expect(outbox.errors()).toEqual([]);
    expect(outbox.size("pending")).toBe(1);
    expect((await deps.store.get("a_1"))?.status).toBe("pending");

    (deps.submit as Mock).mockResolvedValueOnce({ rejected: [] });
    await expect(outbox.flush()).resolves.toEqual({ kind: "accepted", actionIds: ["a_1"] });
    expect(outbox.size("acknowledged")).toBe(1);
  });

  it("retry() ignores an unknown or non-errored id", async () => {
    const { deps, outbox } = await mkErrored();

    await outbox.retry("a_missing");
    await outbox.retry("a_1");
    await outbox.retry("a_1");

    expect(outbox.size("pending")).toBe(1);
    // enqueue, the error transition, and one retry.
    expect(deps.store.put).toHaveBeenCalledTimes(3);
  });

  it("clearError() deletes an errored entry from memory and the store", async () => {
    const { deps, outbox } = await mkErrored();

    await outbox.clearError("a_1");

    expect(outbox.errors()).toEqual([]);
    expect(outbox.size()).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("clearError() ignores a pending entry", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));

    await outbox.clearError("a_1");

    expect(outbox.size("pending")).toBe(1);
    expect(await deps.store.get("a_1")).not.toBeNull();
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

  it("rehydrate loads acknowledged and errored entries alongside pending", async () => {
    const store = mkStore([
      stored(mkAction("a_ack"), "1", "acknowledged"),
      stored(mkAction("a_pending"), "2"),
      stored(mkAction("a_error"), "3", "error"),
    ]);
    const outbox = createOutbox(mkDeps({ store }));

    await outbox.rehydrate();

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_pending"]);
    expect(outbox.size("acknowledged")).toBe(1);
    expect(outbox.errors().map((entry) => entry.action.id)).toEqual(["a_error"]);
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
