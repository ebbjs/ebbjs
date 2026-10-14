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
  ConflictSide,
  ConflictSlot,
  OutboxConflict,
  OutboxEntry as StoredOutboxEntry,
  OutboxStore,
} from "@ebbjs/storage/types";

import { createOutbox, type OutboxDependencies, type OutboxEntry, type StoreFault } from "./outbox";

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

/** One contested position with both sides, defaulting to a `todo_1` leaf. */
const slot = (args: {
  field: string;
  local: ConflictSide;
  remote: ConflictSide;
  path?: readonly string[];
  subjectId?: string;
}): ConflictSlot => ({
  subjectId: args.subjectId ?? "todo_1",
  field: args.field,
  path: args.path ?? [],
  local: args.local,
  remote: args.remote,
});

/** A `ConflictSide`: a leaf carries its LWW triple, a map only its value. */
const side = (value: unknown, updateId?: string, hlc?: string): ConflictSide => ({
  value,
  ...(updateId === undefined ? {} : { update_id: updateId }),
  ...(hlc === undefined ? {} : { hlc }),
});

/** A stored entry with a given HLC; status and `basedOnGsn` default to pending / 0. */
const stored = (
  action: Action,
  enqueuedAtHlc: string,
  status: StoredOutboxEntry["status"] = "pending",
  basedOnGsn = 0,
  conflict?: OutboxConflict,
): StoredOutboxEntry => ({
  action,
  status,
  enqueuedAtHlc,
  basedOnGsn,
  ...(conflict === undefined ? {} : { conflict }),
});

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
    putAndDelete: vi.fn(async (entry: StoredOutboxEntry, deleteId: string) => {
      rows.delete(deleteId);
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
  let conflicts = 0;
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
    baseGsn: () => 0,
    conflictScope: () => "field" as const,
    conflictId: vi.fn(() => `c_${++conflicts}`),
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
      { action, status: "pending", enqueuedAtHlc: "1", basedOnGsn: 0 },
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
      basedOnGsn: 0,
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
    snapshot.push({
      action: mkAction("a_2"),
      status: "pending",
      enqueuedAtHlc: "2",
      basedOnGsn: 0,
    });

    expect(outbox.size()).toBe(1);
  });

  it("unrejected() returns non-error entries in authoring order", async () => {
    const deps = mkDeps({
      submit: vi.fn(async () => ({ rejected: [{ id: "a_3", reason: "permission_denied" }] })),
    });
    const outbox = createOutbox(deps);

    await outbox.enqueue(mkAction("a_1"));
    await outbox.flush();
    await outbox.enqueue(mkAction("a_2"));
    await outbox.enqueue(mkAction("a_3"));
    await outbox.flush();

    expect(outbox.size("error")).toBe(1);
    expect(outbox.unrejected().map((entry) => [entry.action.id, entry.status])).toEqual([
      ["a_1", "acknowledged"],
      ["a_2", "acknowledged"],
    ]);
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
    await outbox.matchEcho({ ...action, gsn: 5 });
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
    await outbox.matchEcho({ ...action, gsn: 9 });
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

describe("createOutbox matchEcho", () => {
  it("removes an acknowledged entry on its own echo and reports it", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);
    await outbox.flush();

    const matched = await outbox.matchEcho({ ...action, gsn: 7 });

    expect(matched).toBe(true);
    expect(outbox.size("acknowledged")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("removes a still-pending entry when its echo arrives first", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const matched = await outbox.matchEcho({ ...action, gsn: 3 });

    expect(matched).toBe(true);
    expect(outbox.size("pending")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("ignores an inbound Action with gsn 0", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);

    const matched = await outbox.matchEcho({ ...action, gsn: 0 });

    expect(matched).toBe(false);
    expect(outbox.size("pending")).toBe(1);
  });

  it("ignores an inbound Action that matches no buffered entry", async () => {
    const outbox = createOutbox(mkDeps());

    const matched = await outbox.matchEcho({ ...mkAction("a_other"), gsn: 9 });

    expect(matched).toBe(false);
  });

  it("never records a conflict for a live inbound write sharing a position", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: { title: { value: "mine", update_id: "u_local", hlc: "10" } },
      }),
    );

    const matched = await outbox.matchEcho(
      mkFieldAction({
        id: "a_peer",
        subjectId: "todo_1",
        fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
        gsn: 5,
      }),
    );

    expect(matched).toBe(false);
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("does not remove an errored entry on a matching echo", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);
    await outbox.flush();

    const matched = await outbox.matchEcho({ ...action, gsn: 4 });

    expect(matched).toBe(false);
    expect(outbox.size("error")).toBe(1);
  });

  it("does not retire a conflicted entry on a matching echo", async () => {
    // The server may have committed the write, but the local value lost
    // and the user has not decided; only a resolution clears the row.
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkFieldAction({
      id: "a_local",
      subjectId: "todo_1",
      fields: { title: { value: "mine", update_id: "u_local", hlc: "10" } },
    });
    await outbox.enqueue(action);
    await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );
    expect(outbox.size("conflicted")).toBe(1);

    const matched = await outbox.matchEcho({ ...action, gsn: 7 });

    expect(matched).toBe(false);
    expect(outbox.size("conflicted")).toBe(1);
    expect(await deps.store.get("a_local")).not.toBeNull();
  });

  it("matches a rehydrated acknowledged entry", async () => {
    const action = mkAction("a_1");
    const store = mkStore([stored(action, "1", "acknowledged")]);
    const deps = mkDeps({ store });
    const outbox = createOutbox(deps);
    await outbox.rehydrate();

    const matched = await outbox.matchEcho({ ...action, gsn: 12 });

    expect(matched).toBe(true);
    expect(outbox.size("acknowledged")).toBe(0);
    expect(await deps.store.get("a_1")).toBeNull();
  });

  it("returns false instead of throwing when the store read fails", async () => {
    const store: OutboxStore = {
      ...mkStore(),
      list: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const outbox = createOutbox(mkDeps({ store }));

    await expect(outbox.matchEcho({ ...mkAction("a_1"), gsn: 3 })).resolves.toBe(false);
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

    await expect(outbox.matchEcho({ ...action, gsn: 3 })).resolves.toBe(false);
    expect(outbox.size("pending")).toBe(1);
    expect(await deps.store.get("a_1")).not.toBeNull();
  });
});

describe("createOutbox conflict detection", () => {
  /** Enqueue one pending `title` write and return it as the local loser. */
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

  /** A peer `patch` on `todo_1`'s title, concurrent with a base-0 write. */
  const peerTitle = (value = "theirs", gsn = 5): Action =>
    mkFieldAction({
      id: "a_peer",
      subjectId: "todo_1",
      fields: { title: { value, update_id: "u_peer", hlc: "20" } },
      gsn,
    });

  it("surfaces a same-position concurrent write with both sides", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected).toEqual([
      {
        actionId: "a_local",
        subjects: ["todo_1"],
        slots: [
          slot({
            field: "title",
            local: side("mine", "u_local", "10"),
            remote: side("theirs", "u_peer", "20"),
          }),
        ],
      },
    ]);
    expect(outbox.pending()).toEqual([]);
    expect(outbox.size("conflicted")).toBe(1);

    const entry = outbox.conflicts()[0];
    expect(entry?.action.id).toBe("a_local");
    expect(entry?.conflict.subjects).toEqual(["todo_1"]);
    expect(entry?.conflict.slots).toEqual([
      slot({
        field: "title",
        local: side("mine", "u_local", "10"),
        remote: side("theirs", "u_peer", "20"),
      }),
    ]);
    expect(entry?.basedOnGsn).toBe(0);
    expect(entry?.conflict.catchUpId).toBe("cu_1");
    expect(entry?.conflict.conflictId).toBe("c_1");
    expect(entry?.conflict.detectedAtHlc).toBe("2");
    // Held and recorded in the one durable write.
    expect(await deps.store.get("a_local")).toEqual(entry);
  });

  it("records a conflict even when the local value would win the merge", async () => {
    // GSN, not HLC, decides concurrency: a newer local HLC is still
    // concurrent with a write the client had not seen.
    const deps = mkDeps();
    const { outbox } = await seed(deps, "30");

    const detected = await outbox.detectConflicts([peerTitle("theirs", 5)], "cu_1");

    expect(detected.map((conflict) => conflict.actionId)).toEqual(["a_local"]);
    expect(outbox.size("conflicted")).toBe(1);
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

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { content: { map: { b: { value: "theirs", update_id: "u_peer", hlc: "20" } } } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([]);
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("flags only the map key the inbound write shares", async () => {
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

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { content: { map: { a: { value: "theirs", update_id: "u_peer", hlc: "20" } } } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([
      {
        actionId: "a_local",
        subjects: ["todo_1"],
        slots: [
          slot({
            field: "content",
            path: ["a"],
            local: side("mine", "u_local", "10"),
            remote: side("theirs", "u_peer", "20"),
          }),
        ],
      },
    ]);
  });

  it("reports a whole-field kind change with a projected-map remote side", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: { content: { value: "leaf", update_id: "u_local", hlc: "10" } },
      }),
    );

    await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { content: { map: { a: { value: "map", update_id: "u_peer", hlc: "20" } } } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    const entry = outbox.conflicts()[0];

    // A whole-field map winner has no single leaf triple.
    expect(entry?.conflict.slots).toEqual([
      slot({
        field: "content",
        local: side("leaf", "u_local", "10"),
        remote: side({ a: "map" }),
      }),
    ]);
  });

  it("sweeps a pending field an inbound put omits, with an empty-path slot", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);

    // A `put` replaces the whole entity, so a field it omits is reverted
    // on the server regardless of the local value's HLC.
    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { completed: { value: true, update_id: "u_peer", hlc: "20" } },
          method: "put",
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([
      {
        actionId: "a_local",
        subjects: ["todo_1"],
        slots: [
          slot({ field: "title", local: side("mine", "u_local", "10"), remote: side(undefined) }),
        ],
      },
    ]);
    expect(outbox.pending()).toEqual([]);
  });

  it("sweeps pending patches when an inbound delete removes the subject", async () => {
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

    const detected = await outbox.detectConflicts([deletion], "cu_1");

    expect(detected).toEqual([
      {
        actionId: "a_local",
        subjects: ["todo_1"],
        slots: [
          slot({ field: "title", local: side("mine", "u_local", "10"), remote: side(undefined) }),
        ],
      },
    ]);
    expect(outbox.pending()).toEqual([]);
  });

  it("sweeps every pending field an inbound put touches, carrying or omitting each", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: {
          title: { value: "mine", update_id: "u_local", hlc: "10" },
          notes: { value: "mine", update_id: "u_local", hlc: "10" },
        },
      }),
    );

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          method: "put",
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([
      {
        actionId: "a_local",
        subjects: ["todo_1"],
        slots: [
          slot({
            field: "title",
            local: side("mine", "u_local", "10"),
            remote: side("theirs", "u_peer", "20"),
          }),
          slot({ field: "notes", local: side("mine", "u_local", "10"), remote: side(undefined) }),
        ],
      },
    ]);
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

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: {
            title: { value: "theirs", update_id: "u_peer", hlc: "20" },
            count: { value: 2, update_id: "u_peer", hlc: "20" },
          },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected[0]?.slots).toEqual([
      slot({
        field: "title",
        local: side("mine", "u_local", "10"),
        remote: side("theirs", "u_peer", "20"),
      }),
    ]);
  });

  it("never flags structural relationship, group, or membership edges", async () => {
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
    }

    const detected = await outbox.detectConflicts(
      ["relationship", "entityGroup", "groupMember"].map((subjectType) =>
        mkFieldAction({
          id: `a_peer_${subjectType}`,
          subjectId: `row_${subjectType}`,
          subjectType,
          fields: { value: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ),
      "cu_1",
    );

    expect(detected).toEqual([]);
    expect(outbox.pending()).toHaveLength(3);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("entity scope surfaces a concurrent touch of a different field, with empty slots", async () => {
    const deps = mkDeps({ conflictScope: () => "entity" });
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { completed: { value: true, update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([{ actionId: "a_local", subjects: ["todo_1"], slots: [] }]);
  });

  it("field scope does not surface a concurrent touch of a different field", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { completed: { value: true, update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([]);
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
  });

  it("does not surface when the write base is at or beyond the inbound gsn", async () => {
    const deps = mkDeps({ baseGsn: () => 5 });
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts([peerTitle("theirs", 5)], "cu_1");

    expect(detected).toEqual([]);
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("surfaces when the write base trails the inbound gsn", async () => {
    const deps = mkDeps({ baseGsn: () => 4 });
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts([peerTitle("theirs", 5)], "cu_1");

    expect(detected.map((conflict) => conflict.actionId)).toEqual(["a_local"]);
  });

  it("moves an acknowledged entry that loses, not only pending ones", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);
    await outbox.flush();
    expect(outbox.size("acknowledged")).toBe(1);

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected.map((conflict) => conflict.actionId)).toEqual(["a_local"]);
    expect(outbox.size("acknowledged")).toBe(0);
    expect(outbox.conflicts().map((entry) => entry.action.id)).toEqual(["a_local"]);
  });

  it("never treats an errored entry as a conflict candidate", async () => {
    const rejection = { id: "a_local", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const { outbox } = await seed(deps);
    await outbox.flush();
    expect(outbox.size("error")).toBe(1);

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected).toEqual([]);
    expect(outbox.errors().map((entry) => entry.action.id)).toEqual(["a_local"]);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("surfaces nothing on a reconnect with no buffered writes", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected).toEqual([]);
    expect(outbox.conflicts()).toEqual([]);
  });

  it("no-ops on an empty missed window", async () => {
    const { outbox } = await seed(mkDeps());

    await expect(outbox.detectConflicts([], "cu_1")).resolves.toEqual([]);
    expect(outbox.pending()).toHaveLength(1);
  });

  it("never posts a moved entry on a later flush", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);
    await outbox.detectConflicts([peerTitle()], "cu_1");

    await expect(outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(deps.submitted).toEqual([]);
  });

  it("keeps a loser held when a detection races the in-flight submit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = mkDeps({
      submit: vi.fn(async () => {
        await gate;
        return { rejected: [] };
      }),
    });
    const { outbox } = await seed(deps);

    const flushing = outbox.flush();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalled());
    // The catch-up pass holds the entry while the submit is on the wire.
    await outbox.detectConflicts([peerTitle()], "cu_1");
    release();
    await flushing;

    // The submit outcome must not overwrite the hold.
    expect(outbox.size("pending")).toBe(0);
    expect(outbox.size("acknowledged")).toBe(0);
    expect(outbox.size("conflicted")).toBe(1);
  });

  it("leaves an entry alone when the missed window touches another subject", async () => {
    const deps = mkDeps();
    const { outbox } = await seed(deps);

    const detected = await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_2",
          fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(detected).toEqual([]);
    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_local"]);
  });

  it("still holds a detected loser when the durable write fails, and surfaces the fault", async () => {
    // Detection is the only durable write. A store fault must not reopen
    // the flush path: the in-memory status transition is the hold.
    let puts = 0;
    const store: OutboxStore = {
      ...mkStore(),
      put: vi.fn(async () => {
        puts += 1;
        if (puts === 2) throw new Error("store unavailable");
      }),
    };
    const deps = mkDeps({ store });
    const { outbox } = await seed(deps);
    const faults: StoreFault[] = [];
    outbox.onStoreFault((fault) => faults.push(fault));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected.map((conflict) => conflict.actionId)).toEqual(["a_local"]);
    expect(outbox.storeFaults()).toBe(1);
    expect(faults.map((fault) => fault.actionId)).toEqual(["a_local"]);
    expect(outbox.pending()).toEqual([]);
    expect(outbox.size("conflicted")).toBe(1);
    await expect(outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(deps.submitted).toEqual([]);
    consoleError.mockRestore();
  });

  it("moves every losing pending entry in buffer order", async () => {
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

    const detected = await outbox.detectConflicts([peerTitle()], "cu_1");

    expect(detected.map((conflict) => conflict.actionId)).toEqual(["a_first", "a_second"]);
    expect(outbox.pending()).toEqual([]);
    const entries = outbox.conflicts();
    // Two losers on one subject form one conflict: they share a
    // `conflictId`, so the group survives a reload and a partial
    // resolution.
    expect(entries.map((entry) => entry.conflict.conflictId)).toEqual(["c_1", "c_1"]);
    expect(entries.every((entry) => entry.conflict.catchUpId === "cu_1")).toBe(true);
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
      { action: first, status: "pending", enqueuedAtHlc: "10", basedOnGsn: 0 },
      { action: second, status: "pending", enqueuedAtHlc: "20", basedOnGsn: 0 },
      { action: third, status: "pending", enqueuedAtHlc: "30", basedOnGsn: 0 },
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

  it("records basedOnGsn per buffered write and rehydrates it", async () => {
    const store = mkStore();
    let base = 4;
    const deps = mkDeps({ store, baseGsn: () => base });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    base = 9;
    await outbox.enqueue(mkAction("a_2"));

    expect(outbox.pending().map((entry) => entry.basedOnGsn)).toEqual([4, 9]);
    expect((await store.get("a_1"))?.basedOnGsn).toBe(4);

    const reloaded = createOutbox(mkDeps({ store }));
    await reloaded.rehydrate();

    expect(reloaded.pending().map((entry) => entry.basedOnGsn)).toEqual([4, 9]);
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
        { action, status: "pending", enqueuedAtHlc: "1", basedOnGsn: 0 },
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
      basedOnGsn: 0,
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

describe("createOutbox counts + onChange", () => {
  it("counts() reports depth by status as one snapshot", async () => {
    const rejection = { id: "a_2", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);

    expect(outbox.counts()).toEqual({ pending: 0, acknowledged: 0, error: 0, conflicted: 0 });

    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));
    expect(outbox.counts()).toEqual({ pending: 2, acknowledged: 0, error: 0, conflicted: 0 });

    await outbox.flush();
    await outbox.enqueue(mkAction("a_3"));
    expect(outbox.counts()).toEqual({ pending: 1, acknowledged: 1, error: 1, conflicted: 0 });
  });

  it("fires with the new counts on enqueue", async () => {
    const outbox = createOutbox(mkDeps());
    const listener = vi.fn();
    outbox.onChange(listener);

    await outbox.enqueue(mkAction("a_1"));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ pending: 1, acknowledged: 0, error: 0, conflicted: 0 });
  });

  it("fires on the ack and error transitions of a flush", async () => {
    const rejection = { id: "a_2", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.enqueue(mkAction("a_2"));
    const seen: unknown[] = [];
    outbox.onChange((counts) => seen.push(counts));

    await outbox.flush();

    expect(seen).toEqual([{ pending: 0, acknowledged: 1, error: 1, conflicted: 0 }]);
  });

  it("fires on retry", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.flush();
    const seen: unknown[] = [];
    outbox.onChange((counts) => seen.push(counts));

    await outbox.retry("a_1");

    expect(seen).toEqual([{ pending: 1, acknowledged: 0, error: 0, conflicted: 0 }]);
  });

  it("fires on clearError", async () => {
    const rejection = { id: "a_1", reason: "permission_denied" };
    const deps = mkDeps({ submit: vi.fn(async () => ({ rejected: [rejection] })) });
    const outbox = createOutbox(deps);
    await outbox.enqueue(mkAction("a_1"));
    await outbox.flush();
    const seen: unknown[] = [];
    outbox.onChange((counts) => seen.push(counts));

    await outbox.clearError("a_1");

    expect(seen).toEqual([{ pending: 0, acknowledged: 0, error: 0, conflicted: 0 }]);
  });

  it("fires when an echo removes an entry", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    const action = mkAction("a_1");
    await outbox.enqueue(action);
    await outbox.flush();
    const seen: unknown[] = [];
    outbox.onChange((counts) => seen.push(counts));

    await outbox.matchEcho({ ...action, gsn: 7 });

    expect(seen).toEqual([{ pending: 0, acknowledged: 0, error: 0, conflicted: 0 }]);
  });

  it("fires when a detection marks an entry conflicted", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(
      mkFieldAction({
        id: "a_local",
        subjectId: "todo_1",
        fields: { title: { value: "mine", update_id: "u_local", hlc: "10" } },
      }),
    );
    const seen: unknown[] = [];
    outbox.onChange((counts) => seen.push(counts));

    await outbox.detectConflicts(
      [
        mkFieldAction({
          id: "a_peer",
          subjectId: "todo_1",
          fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
          gsn: 5,
        }),
      ],
      "cu_1",
    );

    expect(seen).toEqual([{ pending: 0, acknowledged: 0, error: 0, conflicted: 1 }]);
  });

  it("fires when rehydration seeds persisted entries", async () => {
    const store = mkStore([stored(mkAction("a_1"), "1"), stored(mkAction("a_2"), "2")]);
    const outbox = createOutbox(mkDeps({ store }));
    const listener = vi.fn();
    outbox.onChange(listener);

    await outbox.rehydrate();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ pending: 2, acknowledged: 0, error: 0, conflicted: 0 });
  });

  it("does not fire on subscription, and stops after unsubscribe", async () => {
    const outbox = createOutbox(mkDeps());
    const listener = vi.fn();
    const unsubscribe = outbox.onChange(listener);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    await outbox.enqueue(mkAction("a_1"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener from the others", async () => {
    const outbox = createOutbox(mkDeps());
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    outbox.onChange(() => {
      throw new Error("subscriber blew up");
    });
    outbox.onChange(good);

    await outbox.enqueue(mkAction("a_1"));

    expect(good).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith({ pending: 1, acknowledged: 0, error: 0, conflicted: 0 });
    consoleError.mockRestore();
  });
});

describe("createOutbox conflict holds and retries", () => {
  /** A peer `patch` concurrent with a base-0 `todo_1` write. */
  const peer = (): Action =>
    mkFieldAction({
      id: "a_peer",
      subjectId: "todo_1",
      fields: { title: { value: "theirs", update_id: "u_peer", hlc: "20" } },
      gsn: 5,
    });

  const localTitle = (): Action =>
    mkFieldAction({
      id: "a_local",
      subjectId: "todo_1",
      fields: { title: { value: "mine", update_id: "u_local", hlc: "10" } },
    });

  /** A store whose `put` faults for a `conflicted` row, as a disk fault would. */
  const faultingStore = (): OutboxStore & { rows: Map<string, StoredOutboxEntry> } => {
    const store = mkStore();
    return {
      ...store,
      put: vi.fn(async (entry: StoredOutboxEntry) => {
        if (entry.status === "conflicted") throw new Error("disk full");
        store.rows.set(entry.action.id, structuredClone(entry));
      }),
    };
  };

  it("replaces a conflicted row with a pending re-assert in one durable write", async () => {
    const deps = mkDeps();
    const outbox = createOutbox(deps);
    await outbox.enqueue(localTitle());
    await outbox.detectConflicts([peer()], "cu_1");
    expect(outbox.size("conflicted")).toBe(1);
    expect(deps.applied).toHaveLength(1);

    const reassert = mkFieldAction({
      id: "a_reassert",
      subjectId: "todo_1",
      fields: { title: { value: "mine", update_id: "u_new", hlc: "30" } },
    });
    await outbox.retryConflicted("a_local", reassert);

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_reassert"]);
    expect(outbox.size("conflicted")).toBe(0);
    // The atomic write replaced the row: the old id is gone from the store.
    expect(await deps.store.get("a_local")).toBeNull();
    expect(await deps.store.get("a_reassert")).toMatchObject({
      action: reassert,
      status: "pending",
    });
    expect(deps.applied).toHaveLength(2);
  });

  it("leaves the conflict resolvable when the atomic retry write fails", async () => {
    const store = mkStore();
    const outbox = createOutbox(
      mkDeps({
        store: {
          ...store,
          putAndDelete: vi.fn(async () => {
            throw new Error("disk full");
          }),
        },
      }),
    );
    await outbox.enqueue(localTitle());
    await outbox.detectConflicts([peer()], "cu_1");

    await expect(outbox.retryConflicted("a_local", mkAction("a_reassert"))).rejects.toThrow(
      "disk full",
    );

    // No half-applied transition: the loser is still held and nothing new
    // is pending.
    expect(outbox.size("conflicted")).toBe(1);
    expect(outbox.pending()).toEqual([]);
    expect(await store.get("a_local")).toMatchObject({ status: "conflicted" });
  });

  it("no-ops retryConflicted for an unknown or non-conflicted id", async () => {
    const outbox = createOutbox(mkDeps());
    await outbox.enqueue(mkAction("a_pending"));

    await outbox.retryConflicted("a_pending", mkAction("a_reassert"));
    await outbox.retryConflicted("a_missing", mkAction("a_reassert"));

    expect(outbox.pending().map((entry) => entry.action.id)).toEqual(["a_pending"]);
  });

  it("isolates a throwing store-fault listener", async () => {
    const outbox = createOutbox(mkDeps({ store: faultingStore() }));
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    outbox.onStoreFault(() => {
      throw new Error("listener blew up");
    });
    outbox.onStoreFault(good);

    await outbox.enqueue(localTitle());
    await outbox.detectConflicts([peer()], "cu_1");

    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
