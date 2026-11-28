/**
 * Membership is a relation, not a component of the row (#1011, ADR 0005).
 *
 * A projected-row result declares `membership:<entityId>` for each row it
 * holds — derived from the ids it projects, never from a value — so a
 * membership write touches only the results holding that entity. A
 * `where("groups", …)` result still declares the group's scope key, so it is
 * touched by that group's membership and by nothing else. `groupIds` stays on
 * every query row; only the dependency moved.
 *
 * Every assertion is dispatch's own count (`subscriptions.stats().dispatch`),
 * a plan run, or a result snapshot, so a narrower key that misses a change
 * fails here instead of serving a stale `groupIds`.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica } from "@ebbjs/storage/replica";
import { defineModel, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { createQueryResults } from "../query-results";
import { emptyQuery } from "../query";
import { traversalCounter } from "../traversal-counter";
import { callApplyAction, flushTasks, rowComponents, waitFor } from "../test-utils";

const issue = defineModel("issue", { title: e.string(), status: e.string() });
const note = defineModel("note", { body: e.string() });

const schema = defineSchema({ models: { issue, note }, version: 1 });

type Client = ReturnType<typeof createClient<typeof schema>>;

const makeClient = (): Client =>
  createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage: createMemoryAdapter(),
    schema,
  });

const action = (gsn: number, updates: Update[]): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates,
});

const field = (value: unknown, updateId: string) => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const put = (gsn: number, id: string, type: string, fields: Record<string, unknown>): Action =>
  action(
    gsn,
    rowComponents(type, fields).map(
      ([component, value]): Update => ({
        id: `u_${gsn}_${component}`,
        subject_id: id,
        component,
        method: "replace" as const,
        data: field(value, `u_${gsn}`),
      }),
    ),
  );

/** A membership row filing `entityId` under `groupId`. */
const membership = (gsn: number, rowId: string, entityId: string, groupId: string): Action =>
  put(gsn, rowId, "membership", { entity_id: entityId, group_id: groupId });

/** One write through the client's inbound path, settled like a delivery. */
const write = async (client: Client, next: Action): Promise<void> => {
  await callApplyAction(client, next);
  await flushTasks();
};

/** What the last dispatched batch cost: the entries any work happens for. */
const touched = (client: Client): number => client.subscriptions.stats().dispatch.touched;

/** A projected row, as much of it as these assertions read. */
interface Row {
  readonly id: string;
  readonly groupIds?: readonly string[];
}

/** A result store, as much of it as these assertions read. */
interface Store<T> {
  getSnapshot(): { readonly data?: readonly T[]; readonly status: string };
  subscribe(listener: () => void): () => void;
}

interface Mounted<T> {
  readonly store: Store<T>;
  readonly detach: () => void;
  /** One entry per notification after the priming run. */
  readonly fired: number[];
}

const mount = async <T>(store: Store<T>): Promise<Mounted<T>> => {
  const fired: number[] = [];
  const detach = store.subscribe(() => fired.push(1));
  await waitFor(() => store.getSnapshot().status === "current");
  await flushTasks();
  // The priming run is not the batch any case below measures.
  fired.length = 0;
  return { store, detach, fired };
};

/** The plan runs and model scans one batch cost, from a reset counter. */
const probe = (client: Client) => {
  const iterate = vi.spyOn(client.replica, "iterate");
  return {
    reset: () => {
      iterate.mockClear();
      traversalCounter.reset();
    },
    planRuns: () => traversalCounter.planRuns,
    scans: () => iterate.mock.calls.length,
    restore: () => iterate.mockRestore(),
  };
};

const ids = (mounted: Mounted<Row>): string[] =>
  (mounted.store.getSnapshot().data ?? []).map((row) => row.id);

const groupIdsOf = (mounted: Mounted<Row>, id: string): readonly string[] | undefined =>
  (mounted.store.getSnapshot().data ?? []).find((row) => row.id === id)?.groupIds;

/**
 * issue_1 in grp_1, issue_2 in grp_2, note_1 in grp_1: two visible results, so
 * a write that touches nothing still has something it could have touched.
 */
const seed = async (client: Client): Promise<void> => {
  await write(client, put(1, "issue_1", "issue", { title: "One", status: "open" }));
  await write(client, put(2, "issue_2", "issue", { title: "Two", status: "open" }));
  await write(client, put(3, "note_1", "note", { body: "body" }));
  await write(client, membership(4, "eg_1", "issue_1", "grp_1"));
  await write(client, membership(5, "eg_2", "issue_2", "grp_2"));
  await write(client, membership(6, "en_1", "note_1", "grp_1"));
};

describe("membership keys: a projected result declares its own rows", () => {
  it("touches no result for a membership row no result projects", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().result());
    const notes = await mount(client.note.query().result());

    await write(client, membership(7, "eg_9", "issue_9", "grp_1"));

    expect(touched(client)).toBe(0);
    expect(issues.fired).toHaveLength(0);
    expect(notes.fired).toHaveLength(0);
    // Nothing the result read moved, so it is still as current as the replica.
    expect(issues.store.getSnapshot().status).toBe("current");
    expect(groupIdsOf(issues, "issue_1")).toEqual(["grp_1"]);

    issues.detach();
    notes.detach();
  });

  it("touches only the results holding a refiled entity, and re-runs each once", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().result());
    const notes = await mount(client.note.query().result());

    const reads = probe(client);
    reads.reset();
    await write(client, membership(7, "eg_1", "issue_1", "grp_2"));

    expect(touched(client)).toBe(1);
    expect(reads.planRuns()).toBe(1);
    expect(reads.scans()).toBe(1);
    expect(groupIdsOf(issues, "issue_1")).toEqual(["grp_2"]);
    expect(groupIdsOf(issues, "issue_2")).toEqual(["grp_2"]);
    expect(notes.fired).toHaveLength(0);
    expect(notes.store.getSnapshot().status).toBe("current");

    reads.restore();
    issues.detach();
    notes.detach();
  });

  it("leaves every query row's groupIds unchanged for an unrelated membership write", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().result());
    const before = issues.store.getSnapshot().data;

    await write(client, membership(7, "eg_9", "issue_9", "grp_9"));

    expect(touched(client)).toBe(0);
    expect(issues.store.getSnapshot().data).toEqual(before);
    expect(before?.map((row) => row.groupIds)).toEqual([["grp_1"], ["grp_2"]]);

    issues.detach();
  });

  it("keeps groupIds correct on a refile while an unrelated membership row arrives", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().result());

    // One batch: a held row refiles and a row nobody projects arrives.
    await write(
      client,
      action(7, [
        ...membership(7, "eg_1", "issue_1", "grp_2").updates,
        ...membership(7, "eg_9", "issue_9", "grp_1").updates,
      ]),
    );

    expect(touched(client)).toBe(1);
    expect(groupIdsOf(issues, "issue_1")).toEqual(["grp_2"]);
    expect(groupIdsOf(issues, "issue_2")).toEqual(["grp_2"]);

    issues.detach();
  });
});

describe("membership keys: a scoped result keeps only its group's scope", () => {
  it("is invalidated by its own group's membership and by nothing else", async () => {
    const client = makeClient();
    await seed(client);
    const scoped = await mount(client.issue.query().where("groups", "grp_1").result());
    expect(ids(scoped)).toEqual(["issue_1"]);

    // A refile between two groups the read never named: neither the group it
    // left nor the one it entered is this read's scope.
    await write(client, membership(7, "eg_2", "issue_2", "grp_3"));
    expect(touched(client)).toBe(0);
    expect(ids(scoped)).toEqual(["issue_1"]);

    // The group it does name: the row enters the result.
    await write(client, membership(8, "eg_2", "issue_2", "grp_1"));
    expect(touched(client)).toBe(1);
    expect(ids(scoped)).toEqual(["issue_1", "issue_2"]);

    scoped.detach();
  });

  it("declares its scope key and the membership keys of the rows it projects", async () => {
    const client = makeClient();
    await seed(client);
    // issue_1 is in two groups, so a refile of its *other* row moves the
    // membership key without moving the scope key the predicate declares.
    await write(client, membership(7, "eg_1b", "issue_1", "grp_2"));
    await write(client, membership(8, "eg_2", "issue_2", "grp_9"));

    const scoped = await mount(client.issue.query().where("groups", "grp_1").result());
    expect(ids(scoped)).toEqual(["issue_1"]);
    expect(groupIdsOf(scoped, "issue_1")).toEqual(["grp_1", "grp_2"]);

    // The entity is held, but neither group the move names is this read's
    // scope: only the row's own membership key can find it.
    await write(client, membership(9, "eg_1b", "issue_1", "grp_3"));
    expect(touched(client)).toBe(1);
    expect(scoped.fired).toHaveLength(1);
    expect(ids(scoped)).toEqual(["issue_1"]);
    expect(groupIdsOf(scoped, "issue_1")).toEqual(["grp_1", "grp_3"]);

    // A membership row naming neither a group nor a row it holds.
    await write(client, membership(10, "eg_9", "issue_9", "grp_9"));
    expect(touched(client)).toBe(0);
    expect(scoped.fired).toHaveLength(1);

    scoped.detach();
  });
});

describe("membership keys: an invite is not a membership of any projected row", () => {
  it("touches no projected result for a new ebb/grant row and fires no listener", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().result());
    const notes = await mount(client.note.query().result());

    await write(
      client,
      put(7, "gm_1", "grant", {
        actor_id: "actor_9",
        group_id: "grp_1",
        permissions: ["issue.*"],
      }),
    );

    expect(touched(client)).toBe(0);
    expect(issues.fired).toHaveLength(0);
    expect(notes.fired).toHaveLength(0);
    expect(ids(issues)).toEqual(["issue_1", "issue_2"]);

    issues.detach();
    notes.detach();
  });

  it("still reaches a groups join, which projects the ebb row set", async () => {
    const client = makeClient();
    await seed(client);
    await write(client, put(7, "grp_1", "group", { name: "Team" }));
    const joined = await mount(client.issue.query().with({ groups: true }).result());

    // A group row arriving is a membership change naming `ebb`, and a `groups`
    // join projects group rows, so it keeps observing that model's row set.
    // That remains the one breadth ADR 0005 leaves in place.
    await write(
      client,
      put(8, "gm_1", "grant", {
        actor_id: "actor_9",
        group_id: "grp_1",
        permissions: ["issue.*"],
      }),
    );

    expect(touched(client)).toBe(1);
    expect(ids(joined)).toEqual(["issue_1", "issue_2"]);

    joined.detach();
  });
});

describe("membership keys: a refile is a re-run, never a stale patch", () => {
  it("re-runs a batch holding a projected value and a held row's refile", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().select({ title: true }).result());

    const reads = probe(client);
    reads.reset();
    // One Action: a projected value of a held row, and a membership row moving
    // that same row. A patch would splice the title and keep the old groupIds.
    await write(
      client,
      action(7, [
        {
          id: "u_7_title",
          subject_id: "issue_1",
          component: "issue/title",
          method: "replace",
          data: field("One (edited)", "u_7_title"),
        },
        {
          id: "u_7_membership",
          subject_id: "eg_1",
          component: "ebb/membership",
          method: "replace",
          data: field({ entity_id: "issue_1", group_id: "grp_2" }, "u_7_membership"),
        },
      ]),
    );

    expect(reads.planRuns()).toBe(1);
    expect(reads.scans()).toBe(1);
    expect(issues.store.getSnapshot().data).toEqual([
      { id: "issue_1", title: "One (edited)", groupIds: ["grp_2"] },
      { id: "issue_2", title: "Two", groupIds: ["grp_2"] },
    ]);

    reads.restore();
    issues.detach();
  });

  it("still patches a batch that touches no membership key", async () => {
    const client = makeClient();
    await seed(client);
    const issues = await mount(client.issue.query().select({ title: true }).result());

    const reads = probe(client);
    reads.reset();
    await write(client, put(7, "issue_1", "issue", { title: "One (edited)" }));

    // The row is re-projected in place: no plan runs, and groupIds is untouched.
    expect(reads.planRuns()).toBe(0);
    expect(reads.scans()).toBe(0);
    expect(issues.store.getSnapshot().data?.[0]).toEqual({
      id: "issue_1",
      title: "One (edited)",
      groupIds: ["grp_1"],
    });

    reads.restore();
    issues.detach();
  });
});

describe("membership keys: a result that has not run yet declares none", () => {
  /** An `issue` projection whose `groupIds` come from the replica's index. */
  const projection = (replica: ReturnType<typeof createReplica>) => (): Row[] =>
    replica
      .iterate("issue")
      .map((row) => ({ id: row.id, groupIds: replica.memberships({ entityId: row.id }) }));

  it("touches, rather than misses, a membership change while its first run is pending", async () => {
    const replica = createReplica();
    const keep = (next: Action): void => {
      replica.ingest(next, next.updates, next.gsn);
    };
    keep(put(1, "issue_1", "issue", { title: "One", status: "open" }));
    keep(membership(2, "eg_1", "issue_1", "grp_1"));

    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const execute = projection(replica);
    const store = createQueryResults(replica).watch<Row>("rows", emptyQuery("issue"), {
      ready: () => ready,
      isReady: () => false,
      execute: () => {
        runs += 1;
        return execute();
      },
    });
    const detach = store.subscribe(() => {});
    expect(store.getSnapshot().status).toBe("unloaded");

    // Rows arrive while the source is still priming. The run has derived no
    // ids, so it holds no membership keys to narrow a change against: the
    // change touches it rather than being read as holding none.
    keep(put(3, "issue_2", "issue", { title: "Two", status: "open" }));
    keep(membership(4, "eg_2", "issue_2", "grp_2"));
    await flushTasks();

    release();
    await waitFor(() => store.getSnapshot().status === "current");

    expect(runs).toBe(1);
    expect(store.getSnapshot().data).toEqual([
      { id: "issue_1", groupIds: ["grp_1"] },
      { id: "issue_2", groupIds: ["grp_2"] },
    ]);
    detach();
  });

  it("retries a failed first run for a membership change it could not narrow", async () => {
    const replica = createReplica();
    const keep = (next: Action): void => {
      replica.ingest(next, next.updates, next.gsn);
    };
    keep(put(1, "issue_1", "issue", { title: "One", status: "open" }));
    keep(membership(2, "eg_1", "issue_1", "grp_1"));

    let attempts = 0;
    const execute = projection(replica);
    const store = createQueryResults(replica).watch<Row>("rows", emptyQuery("issue"), {
      ready: () => {},
      isReady: () => true,
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first read failed");
        return execute();
      },
    });
    const detach = store.subscribe(() => {});
    await flushTasks();
    expect(store.getSnapshot().status).toBe("failed");

    // The failed run derived no ids, so it declares no membership key: a refile
    // of the row it would project reaches it through neither its read set nor
    // its keys. The retry then comes from the change that does touch it, and
    // the window it examines must not be read as holding no membership.
    keep(membership(3, "eg_1", "issue_1", "grp_2"));
    await flushTasks();
    expect(store.getSnapshot().status).toBe("failed");

    keep(put(4, "issue_2", "issue", { title: "Two", status: "open" }));
    await waitFor(() => store.getSnapshot().status === "current");

    expect(attempts).toBe(2);
    expect(store.getSnapshot().data).toEqual([
      { id: "issue_1", groupIds: ["grp_2"] },
      { id: "issue_2", groupIds: [] },
    ]);
    detach();
  });

  it("wakes a listener that joined before a membership change reached its first result", async () => {
    const replica = createReplica();
    const keep = (next: Action): void => {
      replica.ingest(next, next.updates, next.gsn);
    };
    keep(put(1, "issue_1", "issue", { title: "One", status: "open" }));
    keep(membership(2, "eg_1", "issue_1", "grp_1"));

    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = projection(replica);
    const store = createQueryResults(replica).watch<Row>("rows", emptyQuery("issue"), {
      ready: () => ready,
      isReady: () => false,
      execute,
    });
    const fired: number[] = [];
    // Opted out of the priming run, the way a public change listener is: a
    // change that landed before the first result must still wake it.
    const detach = store.subscribe(() => fired.push(1), { initial: false });

    keep(membership(3, "eg_1", "issue_1", "grp_2"));
    await flushTasks();

    release();
    await waitFor(() => store.getSnapshot().status === "current");

    expect(store.getSnapshot().data).toEqual([{ id: "issue_1", groupIds: ["grp_2"] }]);
    expect(fired).toHaveLength(1);
    detach();
  });

  it("leaves a collection result with no membership keys and no membership re-run", async () => {
    const replica = createReplica();
    const keep = (next: Action): void => {
      replica.ingest(next, next.updates, next.gsn);
    };
    keep(put(1, "issue_1", "issue", { title: "One", status: "open" }));
    keep(membership(2, "eg_1", "issue_1", "grp_1"));

    let runs = 0;
    const store = createQueryResults(replica).watch<string>("collection", emptyQuery("issue"), {
      ready: () => {},
      isReady: () => true,
      execute: () => {
        runs += 1;
        return replica.iterate("issue").map((row) => row.id);
      },
    });
    const detach = store.subscribe(() => {});
    await flushTasks();
    expect(runs).toBe(1);

    // A collection result holds ids and projects nothing, so `groupIds` moves
    // no id it keeps: it declares no membership key and is not re-run.
    keep(membership(3, "eg_1", "issue_1", "grp_2"));
    await flushTasks();

    expect(runs).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ status: "current" });
    detach();
  });
});

describe("membership keys: a row that left the result drops its key", () => {
  it("holds no key for a row the result no longer projects", async () => {
    const client = makeClient();
    await seed(client);
    const open = await mount(
      client.issue.query().where("status", "open").select({ title: true }).result(),
    );
    expect(ids(open)).toEqual(["issue_1", "issue_2"]);

    // issue_1 stops matching, so the result stops holding it and its key.
    await write(client, put(7, "issue_1", "issue", { title: "One", status: "closed" }));
    expect(ids(open)).toEqual(["issue_2"]);
    // The re-run that narrowed the result is not the batch this case measures.
    open.fired.length = 0;

    // The departed row's membership moves: no result holds its key, and the
    // group it moved between is not this read's scope.
    await write(client, membership(8, "eg_1", "issue_1", "grp_2"));
    expect(touched(client)).toBe(0);
    expect(open.fired).toHaveLength(0);
    expect(ids(open)).toEqual(["issue_2"]);

    open.detach();
  });
});
