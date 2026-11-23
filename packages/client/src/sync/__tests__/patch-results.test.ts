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
import { createSubscriptionRegistry } from "../subscriptions";
import { queryCacheKey } from "../selection";
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

/**
 * The claims every query entry holds, one `id:components` string per claimed
 * row. Claim order is not meaningful (it is a set of rows to hold), so both
 * sides are sorted.
 */
const claims = (client: Client): string[][] =>
  client.subscriptions
    .entries()
    .filter((entry) => entry.kind === "query")
    .map((entry) =>
      entry.dependencies
        .map((dependency) => `${dependency.id}:${[...dependency.components].sort().join(",")}`)
        .sort(),
    );

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

  it("patches two changes to one row in a batch with one read of that row", async () => {
    const client = makeClient();
    await seedIssues(client);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    deliver(
      client,
      action(4, [
        ...put(4, "issue_2", "issue", { title: "Two (edited)" }).updates,
        ...put(4, "issue_2", "issue", { status: "done" }).updates,
      ]),
    );

    // One row named twice is still one row to re-project, not two reads.
    expect(reads.scans()).toBe(0);
    expect(reads.rows()).toBe(1);
    expect(titles(store)).toEqual(["issue_1:One", "issue_2:Two (edited)", "issue_3:Three"]);
    expect(store.getSnapshot().data?.[1]?.status).toBe("done");
    detach();
  });

  it("claims a projected component a patch newly installs on a row", async () => {
    const client = makeClient();
    // `issue_1` arrives without `status` and `issue_2` with it, so the result's
    // claim set differs by row: a patch that installs `status` on `issue_1`
    // makes a component claimable that the first run could not claim.
    await seed(client, [
      put(1, "issue_1", "issue", { title: "One" }),
      put(2, "issue_2", "issue", { title: "Two", status: "open" }),
    ]);
    const store = client.issue.query().result();
    const detach = await subscribe(store);
    expect(claims(client)).toEqual([["issue_1:issue/title", "issue_2:issue/status,issue/title"]]);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(3, "issue_1", "issue", { status: "done" }));

    expect(reads.scans()).toBe(0);
    expect(store.getSnapshot().data?.[0]).toMatchObject({ id: "issue_1", status: "done" });
    // A claim is residency, not membership: the patch re-projects `status`, so
    // the entry must hold it even though the row set did not move.
    const patched = claims(client);
    expect(patched).toEqual([
      ["issue_1:issue/status,issue/title", "issue_2:issue/status,issue/title"],
    ]);

    // A re-run at the same rows is the oracle: a replica load is a journal gap,
    // so the entry runs the plan again and recomputes its claims.
    client.replica.load(client.replica.toRecord());
    expect(claims(client)).toEqual(patched);
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

  it("re-runs on a membership join even when the change is a projected value", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "One", status: "open" }),
      put(2, "group_1", "group", { name: "Workspace" }),
      put(3, "eg_1", "membership", { entity_id: "issue_1", group_id: "group_1" }),
    ]);
    const store = client.issue.query().with({ groups: true }).result();
    const detach = await subscribe(store);
    expect(store.getSnapshot().data?.[0]?.groups).toEqual([{ name: "Workspace", id: "group_1" }]);

    const reads = readCounter(client);
    reads.reset();
    deliver(client, put(4, "issue_1", "issue", { title: "One (edited)" }));

    // A join's cardinality is not something a row splice can stand in for.
    expect(reads.scans()).toBe(1);
    expect(titles(store)).toEqual(["issue_1:One (edited)"]);
    detach();
  });

  it("re-runs when a row changes model", async () => {
    const client = makeClient();
    await seed(client, [put(1, "issue_1", "issue", { title: "One", status: "open" })]);
    const store = client.issue.query().result();
    const detach = await subscribe(store);

    const reads = readCounter(client);
    reads.reset();
    const gsn = 2;
    // A create naming another model refiles the row: a membership change that
    // moves it out of the set a patch would splice it back into.
    const update: Update = {
      id: `u_${gsn}`,
      subject_id: "issue_1",
      model: "note",
      method: "create",
      data: null,
      hlc: makeHlc(1_711_036_800_000, gsn),
    };
    client.replica.ingest(action(gsn, [update]), [update], gsn);

    expect(reads.scans()).toBe(1);
    expect(store.getSnapshot().data).toEqual([]);
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

  it("advances the entry's revision to the patched batch's", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const registry = createSubscriptionRegistry(replica, { residencyTtlMs: 1_000 });
    const cache = createQueryCache(replica, registry);
    const source = countingSource(replica, reRead(replica));
    const store = cache.watch("rows", todoQuery(), source);
    const key = queryCacheKey("rows", todoQuery());
    const detach = store.subscribe(() => {});
    await flushTasks();
    const settled = replica.revision;
    expect(registry.peek("query", key)?.revision).toBe(settled);

    write(replica, { todo_1: "One!" });

    // The patch is the run it replaces, so it moves the entry's revision the
    // way a settle does: the entry is current at the batch it patched.
    expect(source.patches).toBe(1);
    expect(source.runs).toBe(1);
    expect(replica.revision).toBeGreaterThan(settled);
    expect(registry.peek("query", key)?.revision).toBe(replica.revision);
    expect(store.getSnapshot().status).toBe("current");
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

  /** The projected titles a store holds, in result order. */
  const titlesOf = (store: { getSnapshot(): { readonly data?: readonly Entity[] } }): string[] =>
    (store.getSnapshot().data ?? []).map((candidate) =>
      String(candidate.data.fields.title?.value ?? ""),
    );

  /**
   * A source as an untyped caller may write it: `patch` answers whatever it
   * likes, including a shape the type says cannot happen.
   */
  const malformedSource = (
    replica: ReturnType<typeof createReplica>,
    answer: (ids: readonly string[]) => unknown,
  ): QuerySource<Entity> & { runs: number; patches: number } => {
    const source = {
      runs: 0,
      patches: 0,
      ready: async (): Promise<void> => {},
      isReady: (): boolean => true,
      execute: (): readonly Entity[] => {
        source.runs += 1;
        return replica.iterate("todo").filter((candidate) => candidate.deleted_hlc === null);
      },
      patch: (ids: readonly string[]): unknown => {
        source.patches += 1;
        return answer(ids);
      },
    };
    // SAFETY: the point of this source is the answer the type forbids.
    return source as unknown as QuerySource<Entity> & { runs: number; patches: number };
  };

  /**
   * Drive one malformed answer through the seam: the source patches once, the
   * cache declines, and the entry re-runs into the new value. Reports whether
   * the registry had to swallow a listener throw on the way.
   */
  const declinedAnswer = async (
    answer: (ids: readonly string[], replica: ReturnType<typeof createReplica>) => unknown,
  ) => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const cache = createQueryCache(replica);
    const source = malformedSource(replica, (ids) => answer(ids, replica));
    const store = cache.watch("rows", todoQuery(), source);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const detach = store.subscribe(() => {});
    try {
      await flushTasks();
      write(replica, { todo_1: "One!" });
      return {
        runs: source.runs,
        patches: source.patches,
        titles: titlesOf(store),
        status: store.getSnapshot().status,
        listenerThrows: errors.mock.calls.filter((args) =>
          String(args[0]).includes("[Subscriptions] change listener threw:"),
        ).length,
      };
    } finally {
      errors.mockRestore();
      detach();
    }
  };

  it("re-runs when the patch answers undefined", async () => {
    const result = await declinedAnswer(() => undefined);
    expect(result.patches).toBe(1);
    expect(result.runs).toBe(2);
    expect(result.titles).toEqual(["One!"]);
    expect(result.status).toBe("current");
    expect(result.listenerThrows).toBe(0);
  });

  it("re-runs when the patch answers a single row instead of an array", async () => {
    const result = await declinedAnswer((ids, replica) => reRead(replica)(ids)[0]);
    expect(result.patches).toBe(1);
    expect(result.runs).toBe(2);
    expect(result.titles).toEqual(["One!"]);
    expect(result.status).toBe("current");
    expect(result.listenerThrows).toBe(0);
  });

  it("re-runs when the patch answers a promise", async () => {
    const result = await declinedAnswer((ids, replica) => Promise.resolve(reRead(replica)(ids)));
    expect(result.patches).toBe(1);
    expect(result.runs).toBe(2);
    expect(result.titles).toEqual(["One!"]);
    expect(result.status).toBe("current");
    expect(result.listenerThrows).toBe(0);
  });

  it("re-runs when the patch answers fewer rows than it was handed", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two" });
    const cache = createQueryCache(replica);
    // A source that filters out a row it cannot re-project: the row it drops
    // would keep serving the value the patch never re-projected.
    const source = countingSource(replica, (ids) => reRead(replica)(ids.slice(1)));
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(2);
    expect(titlesOf(store)).toEqual(["One!", "Two!"]);
    detach();
  });

  it("re-runs when the patch answers no rows for a non-empty id set", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two" });
    const cache = createQueryCache(replica);
    const source = countingSource(replica, () => []);
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(2);
    expect(titlesOf(store)).toEqual(["One!", "Two!"]);
    detach();
  });

  it("re-runs when the patch answers one id twice", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two" });
    const cache = createQueryCache(replica);
    const source = countingSource(replica, (ids) => {
      const rows = reRead(replica)(ids);
      // Same length as the ids, but one answer is missing and another repeats.
      return rows[0] === undefined ? [] : [rows[0], rows[0]];
    });
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(2);
    expect(titlesOf(store)).toEqual(["One!", "Two!"]);
    detach();
  });

  it("re-runs when the patch answers a row it was not asked for", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two", todo_3: "Three" });
    const cache = createQueryCache(replica);
    // The answer is in the result and the count matches, but it is not the row
    // the batch named: splicing it would leave `todo_2` stale.
    const source = countingSource(replica, () => reRead(replica)(["todo_1", "todo_3"]));
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(2);
    expect(titlesOf(store)).toEqual(["One!", "Two!", "Three"]);
    detach();
  });

  it("patches an answer in a different order than the ids it was handed", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One", todo_2: "Two" });
    const cache = createQueryCache(replica);
    // Order is not part of the contract: the splice matches on id.
    const source = countingSource(replica, (ids) => reRead(replica)([...ids].reverse()));
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!", todo_2: "Two!" });

    expect(source.patches).toBe(1);
    expect(source.runs).toBe(1);
    expect(titlesOf(store)).toEqual(["One!", "Two!"]);
    detach();
  });

  it("re-runs a collection result even when its source can patch", async () => {
    const replica = createReplica();
    write(replica, { todo_1: "One" });
    const cache = createQueryCache(replica);
    let runs = 0;
    let patches = 0;
    // A collection reads the plan's own components, so a title predicate is
    // what makes a title write relevant to it.
    const query: Query = {
      ...todoQuery(),
      groups: [[{ kind: "field", field: "title", value: "One!" }]],
    };
    const source: QuerySource<string> = {
      ready: async (): Promise<void> => {},
      isReady: (): boolean => true,
      execute: (): readonly string[] => {
        runs += 1;
        return replica
          .iterate("todo")
          .filter((candidate) => candidate.data.fields.title?.value === "One!")
          .map((candidate) => candidate.id);
      },
      patch: (): readonly string[] => {
        patches += 1;
        return ["todo_1"];
      },
    };
    const store = cache.watch("collection", query, source);
    const detach = store.subscribe(() => {});
    await flushTasks();

    write(replica, { todo_1: "One!" });

    // A collection holds an id set, not projected rows: there is no row to
    // splice, so it keeps the re-run.
    expect(patches).toBe(0);
    expect(runs).toBe(2);
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
