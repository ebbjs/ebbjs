/**
 * The relation, existence and scope index resolvers (#961).
 *
 * A query read declares the derived indices its predicates and joins read, and
 * the registry's resolvers turn a change back into the keys it may have moved.
 * Dispatch then touches the subscriptions whose key changed instead of every
 * subscription that reads the component — while a change the resolver cannot
 * resolve (a link write whose removed target the journal does not name) still
 * touches every reader of that index, which is the breadth the component read
 * set gave before.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica, type Replica } from "@ebbjs/storage/replica";

import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { createIndexResolvers } from "../index-resolvers";
import { callApplyAction, flushTasks, linkAction, rowComponents } from "../test-utils";

const issue = defineModel("issue", { title: e.string() });
const todo = defineModel("todo", { title: e.string(), due: e.number() });
const user = defineModel("user", { name: e.string() });

const issueAssignee = defineRelationship({
  source: issue,
  target: user,
  as: "assignee",
  sourceCardinality: "one",
});

const schema = defineSchema({
  models: { issue, todo, user },
  relationships: { issueAssignee },
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

const link = (gsn: number, sourceId: string, targetId: string): Action =>
  linkAction({
    id: `a_${gsn}`,
    hlc: makeHlc(1_711_036_800_000, gsn),
    gsn,
    sourceId,
    edges: [{ as: "assignee", type: "issue", targetId }],
  });

const write = async (client: Client, next: Action): Promise<void> => {
  await callApplyAction(client, next);
  await flushTasks();
};

/** What the last dispatched batch cost, as the registry reports it. */
const touched = (client: Client): number => client.subscriptions.stats().dispatch.touched;

describe("index resolvers at the client seam", () => {
  it("touches a relationship predicate by its own target only", async () => {
    const client = makeClient();
    await write(client, put(1, "user_1", "user", { name: "Ada" }));
    await write(client, put(2, "user_2", "user", { name: "Grace" }));
    await write(client, put(3, "issue_1", "issue", { title: "Ship" }));
    await write(client, link(4, "issue_1", "user_1"));

    const own = client.issue
      .query()
      .select({})
      .where("assignee", "user_1")
      .subscribe(() => {});
    const other = client.issue
      .query()
      .select({})
      .where("assignee", "user_2")
      .subscribe(() => {});
    await flushTasks();

    // A target's own write resolves to its id; the other target's read is not
    // touched, and a write outside the relation touches neither.
    await write(client, put(5, "user_1", "user", { name: "Ada Lovelace" }));
    expect(touched(client)).toBe(1);
    await write(client, put(6, "user_2", "user", { name: "Grace Hopper" }));
    expect(touched(client)).toBe(1);
    await write(client, put(7, "todo_1", "todo", { title: "Unrelated", due: 1 }));
    expect(touched(client)).toBe(0);

    own();
    other();
  });

  it("touches an existence predicate by its component only", async () => {
    const client = makeClient();
    await write(client, put(1, "todo_1", "todo", { title: "One", due: 1 }));

    const hasDue = client.todo
      .query()
      .select({})
      .has("due")
      .subscribe(() => {});
    await flushTasks();

    await write(client, put(2, "todo_1", "todo", { title: "Two" }));
    expect(touched(client)).toBe(0);
    await write(client, put(3, "todo_1", "todo", { due: 2 }));
    expect(touched(client)).toBe(1);

    hasDue();
  });

  it("falls back to every relation reader for a link write", async () => {
    const client = makeClient();
    await write(client, put(1, "user_1", "user", { name: "Ada" }));
    await write(client, put(2, "user_2", "user", { name: "Grace" }));
    await write(client, put(3, "issue_1", "issue", { title: "Ship" }));

    const one = client.issue
      .query()
      .select({})
      .where("assignee", "user_1")
      .subscribe(() => {});
    const two = client.issue
      .query()
      .select({})
      .where("assignee", "user_2")
      .subscribe(() => {});
    await flushTasks();

    // The write may have removed an edge to either target, and the journal
    // names the component, not the target it dropped. Both readers are handed
    // the batch: a fallback over-touches, it never misses.
    await write(client, link(4, "issue_1", "user_2"));
    expect(touched(client)).toBe(2);

    one();
    two();
  });
});

/** A replica seeded directly, for the resolver unit tests. */
const replicaWith = (updates: readonly Update[], position = 1): Replica => {
  const replica = createReplica();
  replica.ingest(
    {
      id: `a_${position}`,
      actor_id: "actor_1",
      hlc: makeHlc(position),
      gsn: position,
      updates: [],
    },
    updates,
    position,
  );
  return replica;
};

/** The resolver for one index name, as the dispatcher would look it up. */
const resolveFor = (replica: Replica, index: string) => {
  const resolvers = createIndexResolvers(replica);
  const exact = resolvers[index];
  if (exact !== undefined) return (change: Parameters<typeof exact>[0]) => exact(change, index);
  for (const [name, resolve] of Object.entries(resolvers)) {
    if (name.endsWith("*") && index.startsWith(name.slice(0, -1))) {
      return (change: Parameters<typeof resolve>[0]) => resolve(change, index);
    }
  }
  throw new Error(`no resolver for ${index}`);
};

describe("index resolvers: the three keys", () => {
  it("keys a relation change on its target row, and cannot resolve a link write", () => {
    const replica = replicaWith([
      {
        id: "u_link",
        subject_id: "issue_1",
        component: "ebb/link",
        method: "merge",
        data: {
          map: {
            assignee: {
              map: {
                issue: {
                  map: { user_1: { value: true, update_id: "u_link", hlc: makeHlc(1) } },
                },
              },
            },
          },
        },
      },
    ]);
    const resolve = resolveFor(replica, "relation:assignee/issue");

    expect(
      resolve({
        revision: 1,
        id: "user_1",
        kind: "content",
        deleted: false,
        components: ["user/name"],
      }),
    ).toEqual(["user_1"]);
    expect(
      resolve({
        revision: 2,
        id: "issue_1",
        kind: "content",
        deleted: false,
        components: ["ebb/link"],
      }),
    ).toBeNull();
    // A membership change names the row, so a joined target read follows it.
    expect(
      resolve({
        revision: 3,
        id: "user_1",
        kind: "membership",
        deleted: true,
        membership: "left",
        models: ["user"],
      }),
    ).toEqual(["user_1"]);
  });

  it("keys an existence change on the component it names", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    expect(
      resolve({
        revision: 1,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/due"],
      }),
    ).toEqual(["todo/due"]);
    expect(
      resolve({
        revision: 2,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/title"],
      }),
    ).toEqual([]);
  });

  it("keys a scope change on the group it entered, and falls back when it left one", () => {
    const replica = replicaWith([
      {
        id: "u_membership",
        subject_id: "todo_1",
        component: "ebb/membership",
        method: "replace",
        data: {
          value: { entity_id: "todo_1", group_id: "grp_1" },
          update_id: "u_membership",
          hlc: makeHlc(1),
        },
      },
    ]);
    const resolve = resolveFor(replica, "scope");

    expect(
      resolve({
        revision: 1,
        id: "todo_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["todo"],
      }),
    ).toEqual(["grp_1"]);
    // A membership value write may have left a group the journal does not name.
    expect(
      resolve({
        revision: 2,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["ebb/membership"],
      }),
    ).toBeNull();
    // An evicted row leaves no membership to read.
    expect(
      resolve({
        revision: 3,
        id: "todo_9",
        kind: "membership",
        deleted: true,
        membership: "left",
        models: ["todo"],
      }),
    ).toBeNull();
  });
});
