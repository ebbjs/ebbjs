/**
 * Patch fast paths (#942): a change that can only rewrite a projected value of a
 * resident row is spliced into the cached result instead of re-running the
 * query. Everything else — matching, ordering, a limit, a join, the row set, a
 * scope eviction, a journal gap — keeps re-running.
 *
 * Every case counts the rows a change made the result read. A re-run
 * materializes the plan's model scan (`replica.iterate`); a patch reads the
 * changed rows by id (`replica.get`); a row subscription re-projects its one row
 * through the same by-id read. A safe shape is then proven identical to a
 * re-run by comparing the patched result with the chain's own uncached
 * terminal, which executes the plan again.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Entity, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica } from "@ebbjs/storage/replica";
import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { createQueryCache, type QuerySource } from "../query-cache";
import { emptyQuery, type Query } from "../query";
import { callApplyAction, flushTasks, linkAction, rowComponents } from "../test-utils";
import { traversalCounter } from "../traversal-counter";

const user = defineModel("user", { name: e.string() });
const issue = defineModel("issue", { title: e.string(), status: e.string() });

const schema = defineSchema({
  models: { issue, user },
  relationships: {
    issue_assignee: defineRelationship({
      source: issue,
      target: user,
      as: "assignee",
      sourceCardinality: "one",
    }),
  },
  version: 1,
});

type Client = ReturnType<typeof createClient<typeof schema>>;

const makeClient = (): Client =>
  createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage: createMemoryAdapter(),
    schema,
  });

const field = (value: unknown, updateId: string) => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const action = (gsn: number, updates: Update[]): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates,
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

const remove = (gsn: number, id: string): Action =>
  action(gsn, [{ id: `u_${gsn}`, subject_id: id, method: "delete", data: null }]);

const link = (gsn: number, sourceId: string, targetId: string): Action =>
  linkAction({
    id: `a_${gsn}`,
    hlc: makeHlc(1_711_036_800_000, gsn),
    gsn,
    sourceId,
    edges: [{ as: "assignee", type: "issue", targetId }],
  });

const seed = async (client: Client, actions: readonly Action[]): Promise<void> => {
  for (const next of actions) await callApplyAction(client, next, "grp_1");
};

/** Deliver one remote action's updates to the replica, as the sync stream does. */
const deliver = (client: Client, next: Action): void => {
  client.replica.ingest(next, next.updates, next.gsn);
};

/**
 * What one change made a result read. `scans` counts a re-run's model scan; the
 * shipped counter counts the rows a propagating read materialized — a scan's
 * rows, a patch's by-id reads, or a row subscription's one row.
 */
const readCounter = (client: Client) => {
  const iterate = vi.spyOn(client.replica, "iterate");
  return {
    reset: () => {
      iterate.mockClear();
      traversalCounter.reset();
    },
    scans: () => iterate.mock.calls.length,
    rows: () => traversalCounter.resultRowsRead,
  };
};

const seedIssues = async (client: Client): Promise<void> => {
  await seed(client, [
    put(1, "issue_1", "issue", { title: "One", status: "open" }),
    put(2, "issue_2", "issue", { title: "Two", status: "open" }),
    put(3, "issue_3", "issue", { title: "Three", status: "done" }),
  ]);
};

type Snapshot = {
  getSnapshot(): { readonly data?: readonly { readonly id: string; readonly title?: string }[] };
};

const titles = (store: Snapshot): string[] =>
  (store.getSnapshot().data ?? []).map((row) => `${row.id}:${row.title ?? ""}`);

const subscribe = async (store: { subscribe: (listener: () => void) => () => void }) => {
  const detach = store.subscribe(() => {
    /* the change is read back through the snapshot */
  });
  await flushTasks();
  return detach;
};

describe("patched: a projected value of a resident row (#942)", () => {
  it("patches an unfiltered, unordered, unlimited result and reads the one changed row", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);
    expect(store.getSnapshot().status).toBe("current");

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { title: "Two (edited)" }));

    // A re-run would scan all three rows; the patch re-reads the changed one.
    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(1);
    expect(titles(store)).toEqual(["issue_1:One", "issue_2:Two (edited)", "issue_3:Three"]);

    // The plan's own uncached run is the oracle: same ids, same order.
    const reRun = await client.issue.query().toRaw();
    expect((store.getSnapshot().data ?? []).map((row) => row.id)).toEqual(
      reRun.map((row) => row.id),
    );
    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });
    detach();
  });

  it("patches a filtered result when the changed component is not a predicate", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().where("status", "open").result();
    const detach = await subscribe(store);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1", "issue_2"]);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { title: "Two (edited)" }));

    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(1);
    expect(titles(store)).toEqual(["issue_1:One", "issue_2:Two (edited)"]);
    detach();
  });

  it("patches a selected projection and reads nothing for a component it did not select", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().select({ title: true }).result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_1", "issue", { title: "One (edited)" }));
    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(1);
    expect(titles(store)).toEqual(["issue_1:One (edited)", "issue_2:Two", "issue_3:Three"]);

    // `status` is not selected, so it is not even part of the read set.
    reads.reset();
    deliver(client, put(5, "issue_1", "issue", { status: "done" }));
    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(0);
    expect(titles(store)).toEqual(["issue_1:One (edited)", "issue_2:Two", "issue_3:Three"]);
    detach();
  });

  it("patches a row subscription with the one row it re-reads", async () => {
    const client = makeClient();
    await seedIssues(client);
    const row = await client.issue.get("issue_2");
    if (row === null) throw new Error("expected issue_2");
    const seen: string[] = [];
    const detach = row.subscribe((event) => {
      if (event.type === "snapshot") seen.push(event.row.title ?? "");
    });

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { title: "Two (edited)" }));

    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(1);
    expect(seen).toEqual(["Two (edited)"]);
    detach();
  });

  it("patches every row one batch names in a single result", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(
      client,
      action(4, [
        ...put(4, "issue_1", "issue", { title: "One (edited)" }).updates,
        ...put(4, "issue_3", "issue", { title: "Three (edited)" }).updates,
      ]),
    );

    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(2);
    expect(titles(store)).toEqual([
      "issue_1:One (edited)",
      "issue_2:Two",
      "issue_3:Three (edited)",
    ]);
    detach();
  });
});

describe("re-run: a change a patch cannot apply (#942)", () => {
  it("re-runs when a predicate field changes", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().where("status", "open").result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { status: "done" }));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1"]);
    detach();
  });

  it("re-runs when the order key changes", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().orderBy("title", "asc").result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { title: "Aardvark" }));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.title)).toEqual(["Aardvark", "One", "Three"]);
    detach();
  });

  it("re-runs when a projected value changes under a limit", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().orderBy("title", "asc").limit(2).result();
    const detach = await subscribe(store);
    expect(store.getSnapshot().data?.map((row) => row.title)).toEqual(["One", "Three"]);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_2", "issue", { title: "Aardvark" }));

    expect(reads.scans()).toBe(1);
    // The row now sorts into the page, which only a re-run can decide.
    expect(store.getSnapshot().data?.map((row) => row.title)).toEqual(["Aardvark", "One"]);
    detach();
  });

  it("re-runs on a join when the join key changes", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "user_1", "user", { name: "Ada" }),
      put(2, "issue_1", "issue", { title: "One", status: "open" }),
    ]);
    const store = client.issue.query().with({ assignee: true }).result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, link(3, "issue_1", "user_1"));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.[0]?.assignee?.name).toBe("Ada");
    detach();
  });

  it("re-runs on a join when the joined target's row changes", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "user_1", "user", { name: "Ada" }),
      put(2, "issue_1", "issue", { title: "One", status: "open" }),
      link(3, "issue_1", "user_1"),
    ]);
    const store = client.issue.query().with({ assignee: true }).result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "user_1", "user", { name: "Ada Lovelace" }));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.[0]?.assignee?.name).toBe("Ada Lovelace");
    detach();
  });

  it("re-runs when a row is created (a membership change)", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_4", "issue", { title: "Four", status: "open" }));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toContain("issue_4");
    detach();
  });

  it("re-runs when a row is tombstoned (a membership change)", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, remove(4, "issue_2"));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1", "issue_3"]);
    detach();
  });

  it("re-runs when a scope eviction drops the row", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    client.replica.evict(["issue_2"]);

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1", "issue_3"]);
    detach();
  });

  it("re-runs when a membership row changes a row's groupIds", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "eg_1", "membership", { entity_id: "issue_1", group_id: "grp_1" }));

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.[0]?.groupIds).toEqual(["grp_1"]);
    detach();
  });

  it("re-runs on a journal gap rather than patching from an empty batch", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    // A replica `load` replaces the journal wholesale: the entry's cursor falls
    // to the floor, so the batch it is handed names no change and may have
    // changed anything.
    client.replica.load(client.replica.toRecord());

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual([
      "issue_1",
      "issue_2",
      "issue_3",
    ]);
    detach();
  });
});

describe("query cache: patch source contract (#942)", () => {
  const row = (id: string, title = id): Entity => ({
    id,
    model: "todo",
    data: { fields: { title: { value: title, update_id: `u_${id}`, hlc: makeHlc(0) } } },
    exists: true,
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: 1,
  });

  let gsn = 0;

  /** One action writes `todo/title` on each named row, so one batch names them all. */
  const write = (replica: ReturnType<typeof createReplica>, titles: Record<string, string>) => {
    gsn += 1;
    replica.ingest(
      { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
      Object.entries(titles).map(([id, title]) => ({
        id: `u_${gsn}_${id}`,
        subject_id: id,
        component: "todo/title",
        method: "replace" as const,
        data: { value: title, update_id: `u_${gsn}`, hlc: makeHlc(gsn) },
      })),
      gsn,
    );
  };

  const todoQuery = (): Query => emptyQuery("todo");

  /** A source whose run and patch are both observable. */
  const countingSource = (
    replica: ReturnType<typeof createReplica>,
    patch: (ids: readonly string[]) => readonly Entity[] | null,
  ): QuerySource<Entity> & {
    runs: number;
    patches: number;
    patched: (readonly string[])[];
  } => {
    const source = {
      runs: 0,
      patches: 0,
      patched: [] as (readonly string[])[],
      ready: async (): Promise<void> => {},
      isReady: (): boolean => true,
      execute: (): readonly Entity[] => {
        source.runs += 1;
        return replica.iterate("todo").filter((candidate) => candidate.deleted_hlc === null);
      },
      patch: (ids: readonly string[]): readonly Entity[] | null => {
        source.patches += 1;
        source.patched.push(ids);
        return patch(ids);
      },
    };
    return source;
  };

  const reRead =
    (replica: ReturnType<typeof createReplica>) =>
    (ids: readonly string[]): readonly Entity[] =>
      ids.flatMap((id) => {
        const found = replica.get(id);
        return found === undefined ? [] : [found];
      });

  it("patches only the rows one batch names", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two" });
    const cache = createQueryCache(replica);
    const source = countingSource(replica, reRead(replica));
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.runs).toBe(1);
    expect(source.patches).toBe(1);
    expect(source.patched[0]).toEqual(["todo_1", "todo_2"]);
    expect(
      store
        .getSnapshot()
        .data?.map((candidate) => `${candidate.id}:${String(candidate.data.fields.title?.value)}`),
    ).toEqual(["todo_1:One!", "todo_2:Two!"]);
    detach();
  });

  it("re-runs when the source opts out of patching", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const cache = createQueryCache(replica);
    let runs = 0;
    const source: QuerySource<Entity> = {
      ready: async (): Promise<void> => {},
      isReady: (): boolean => true,
      execute: (): readonly Entity[] => {
        runs += 1;
        return replica.iterate("todo").filter((candidate) => candidate.deleted_hlc === null);
      },
    };
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!" });

    // The seam is optional: a source without it keeps the re-run it always had.
    expect(runs).toBe(2);
    expect(store.getSnapshot().data?.map((candidate) => candidate.id)).toEqual(["todo_1"]);
    detach();
  });

  it("re-runs when the patch hands back a row the result does not hold", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const cache = createQueryCache(replica);
    const source = countingSource(replica, (ids) => [
      ...reRead(replica)(ids),
      row("todo_ghost", "Ghost"),
    ]);
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(2);
    expect(store.getSnapshot().data?.map((candidate) => candidate.id)).toEqual(["todo_1"]);
    detach();
  });

  it("keeps the result and stays silent when a patch reports no change", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const cache = createQueryCache(replica);
    // The patch hands back the row the result already holds: a write that
    // changed nothing the result projects is not a result change.
    const source = countingSource(replica, (ids) =>
      (store.getSnapshot().data ?? []).filter((candidate) => ids.includes(candidate.id)),
    );
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    const detach = store.subscribe(() => {
      notified += 1;
    });
    await flushTasks();
    const before = store.getSnapshot().data;

    write(replica, { todo_1: "One" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(1);
    expect(store.getSnapshot().data).toBe(before);
    expect(store.getSnapshot().status).toBe("current");
    expect(notified).toBe(1);
    detach();
  });
});
