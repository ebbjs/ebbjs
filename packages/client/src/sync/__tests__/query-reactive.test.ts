/**
 * Integration tests for reactive query results at the client seam (#512).
 *
 * The query cache lives beside the replica: a chain's result is cached by its
 * lowered query, a remount reads it back with a status instead of re-running,
 * and a replica change re-runs the query, diffing the result before waking
 * subscribers. The coarse `readTypes` intersection keeps unrelated type
 * changes silent.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { callApplyAction } from "../test-utils";

const issue = defineEntity("issue", { title: e.string(), status: e.string() });
const note = defineEntity("note", { body: e.string() });
const user = defineEntity("user", { name: e.string() });

const schema = defineSchema({
  entities: { issue, note, user },
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
  action(gsn, [
    {
      id: `u_${gsn}`,
      subject_id: id,
      subject_type: type,
      method: "put",
      data: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, field(value, `u_${gsn}`)]),
        ),
      },
    },
  ]);

const link = (gsn: number, sourceId: string, targetId: string, as: string, type: string): Action =>
  put(gsn, `rel_${gsn}`, "relationship", {
    source_id: sourceId,
    target_id: targetId,
    field: as,
    type,
  });

const seed = async (client: Client, actions: readonly Action[]): Promise<void> => {
  for (const next of actions) await callApplyAction(client, next);
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("query result cache at the client seam", () => {
  it("a remount reads the cached result with its status and does not re-run", async () => {
    const client = makeClient();
    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);

    const first = client.issue.query().result();
    const detach = first.subscribe(() => {});
    await flush();
    expect(first.getSnapshot()).toMatchObject({
      status: "current",
      loading: false,
    });
    detach();

    const iterate = vi.spyOn(client.replica, "iterate");
    const remount = client.issue.query().result();
    expect(remount.getSnapshot().status).toBe("current");
    expect(remount.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1"]);

    const detachRemount = remount.subscribe(() => {});
    await flush();
    expect(iterate).not.toHaveBeenCalled();
    detachRemount();
  });

  it("remounts a stale cached result and refreshes it for the subscriber", async () => {
    const client = makeClient();
    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);
    const first = client.issue.query().result();
    const detach = first.subscribe(() => {});
    await flush();
    expect(first.getSnapshot().status).toBe("current");
    detach();

    // No subscriber is attached, so the entry stays stale rather than
    // re-running in the background.
    await seed(client, [put(2, "issue_2", "issue", { title: "Test", status: "open" })]);
    expect(first.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(first.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1"]);

    const remount = client.issue.query().result();
    expect(remount.getSnapshot().status).toBe("stale");
    const detachRemount = remount.subscribe(() => {});
    await flush();
    expect(remount.getSnapshot().status).toBe("current");
    expect(remount.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1", "issue_2"]);
    detachRemount();
  });

  it("reports failed and recovers on a successful invalidation", async () => {
    const client = makeClient();
    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);
    const iterate = vi.spyOn(client.replica, "iterate").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const store = client.issue.query().result();
    store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "failed", loading: false });
    expect(store.getSnapshot().error?.message).toBe("boom");

    await seed(client, [put(2, "issue_2", "issue", { title: "Test", status: "open" })]);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "current", error: null });
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["issue_1", "issue_2"]);
    iterate.mockRestore();
  });
});

describe("subscribed query results", () => {
  it("emits only when the result changes", async () => {
    const client = makeClient();
    const query = client.issue.query().where("status", "open");
    const seen: string[][] = [];
    const unsubscribe = query.subscribe(() => {
      seen.push((query.result().getSnapshot().data ?? []).map((row) => row.id));
    });

    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);
    await flush();
    expect(seen).toEqual([["issue_1"]]);

    // A non-matching issue does not change the result.
    await seed(client, [put(2, "issue_2", "issue", { title: "Test", status: "done" })]);
    await flush();
    expect(seen).toEqual([["issue_1"]]);

    // A matching row's filtered-out field changes the projection.
    await seed(client, [put(3, "issue_1", "issue", { title: "Ship it", status: "open" })]);
    await flush();
    expect(seen).toEqual([["issue_1"], ["issue_1"]]);

    // A re-delivery with equal content is not a result change.
    await seed(client, [put(4, "issue_1", "issue", { title: "Ship it", status: "open" })]);
    await flush();
    expect(seen).toHaveLength(2);

    unsubscribe();
  });

  it("re-runs when a membership changes so a row's groupIds stay live", async () => {
    const client = makeClient();
    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);
    const query = client.issue.query();
    const seen: string[][] = [];
    const unsubscribe = query.subscribe(() => {
      const [row] = query.result().getSnapshot().data ?? [];
      seen.push([...(row?.groupIds ?? [])]);
    });
    await flush();
    expect(seen).toEqual([]);

    await seed(client, [
      put(2, "eg_1", "entityGroup", { entity_id: "issue_1", group_id: "group_1" }),
    ]);
    await flush();
    expect(seen).toEqual([["group_1"]]);

    unsubscribe();
  });

  it("re-runs a join when the joined target's row changes", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "user_1", "user", { name: "Ada" }),
      put(2, "issue_1", "issue", { title: "Ship", status: "open" }),
      link(3, "issue_1", "user_1", "assignee", "issue"),
    ]);
    const query = client.issue.query().with({ assignee: true });
    const store = query.result();
    let fires = 0;
    const unsubscribe = query.subscribe(() => {
      fires += 1;
    });
    await flush();
    expect(store.getSnapshot().data?.[0]?.assignee?.name).toBe("Ada");

    await seed(client, [put(4, "user_1", "user", { name: "Ada Lovelace" })]);
    await flush();
    expect(fires).toBe(1);
    expect(store.getSnapshot().data?.[0]?.assignee?.name).toBe("Ada Lovelace");

    unsubscribe();
  });

  it("ignores a change whose type is outside the query's readTypes", async () => {
    const client = makeClient();
    const query = client.issue.query();
    let fires = 0;
    const unsubscribe = query.subscribe(() => {
      fires += 1;
    });

    await seed(client, [put(1, "note_1", "note", { body: "hello" })]);
    await flush();
    expect(fires).toBe(0);

    await seed(client, [put(2, "issue_1", "issue", { title: "Ship", status: "open" })]);
    await flush();
    expect(fires).toBe(1);

    unsubscribe();
  });
});
