/**
 * The relation, existence and scope index resolvers (#961).
 *
 * A query read declares the derived indices its predicates and joins read, and
 * the registry's resolvers turn a change (and its journal delta) back into the
 * keys it may have moved. Dispatch then touches the subscriptions whose key
 * changed instead of every subscription that reads the component — while a
 * change whose shape cannot say what moved (a link write or membership change
 * with no delta) still touches every reader of that index, which is the breadth
 * the component read set gave before.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica, type Replica, type ReplicaChange } from "@ebbjs/storage/replica";

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

const link = (gsn: number, sourceId: string, targetId: string, present = true): Action =>
  linkAction({
    id: `a_${gsn}`,
    hlc: makeHlc(1_711_036_800_000, gsn),
    gsn,
    sourceId,
    edges: [{ as: "assignee", type: "issue", targetId, present }],
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

  it("touches the relation reader of the target an edge delta moved", async () => {
    const client = makeClient();
    await write(client, put(1, "user_1", "user", { name: "Ada" }));
    await write(client, put(2, "user_2", "user", { name: "Grace" }));
    await write(client, put(3, "issue_1", "issue", { title: "Ship" }));
    await write(client, link(4, "issue_1", "user_1"));

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

    // The journal's edge delta names the target the write dropped, so only that
    // target's reader is touched — not every reader of the relation.
    await write(client, link(5, "issue_1", "user_1", false));
    expect(touched(client)).toBe(1);
    // The other target's reader still watches its own key.
    await write(client, link(6, "issue_1", "user_2"));
    expect(touched(client)).toBe(1);

    one();
    two();
  });

  it("follows the changed row's own key on a link write", async () => {
    const client = makeClient();
    await write(client, put(1, "user_1", "user", { name: "Ada" }));
    await write(client, put(2, "issue_1", "issue", { title: "Ship" }));
    await write(client, link(3, "issue_1", "user_1"));

    // Keyed on the changed row, not on either edge target: the reader follows
    // the row's projected values, so the write has to reach it too.
    const row = client.issue
      .query()
      .select({})
      .where("assignee", "issue_1")
      .subscribe(() => {});
    await flushTasks();

    await write(client, link(4, "issue_1", "user_1", false));
    expect(touched(client)).toBe(1);

    row();
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

const content = (
  revision: number,
  id: string,
  components: readonly string[],
  delta?: ReplicaChange["delta"],
): ReplicaChange =>
  delta === undefined
    ? { revision, id, kind: "content", deleted: false, components }
    : { revision, id, kind: "content", deleted: false, components, delta };

const membership = (
  revision: number,
  id: string,
  transition: "entered" | "left" | "changed-model",
  models: readonly string[],
  delta?: ReplicaChange["delta"],
): ReplicaChange =>
  delta === undefined
    ? {
        revision,
        id,
        kind: "membership",
        deleted: transition === "left",
        membership: transition,
        models,
      }
    : {
        revision,
        id,
        kind: "membership",
        deleted: transition === "left",
        membership: transition,
        models,
        delta,
      };

describe("index resolvers: observation", () => {
  it("keeps the changed row for a relation change that names no edge", () => {
    const resolve = resolveFor(replicaWith([]), "relation:assignee/issue");

    expect(resolve(content(1, "user_1", ["user/name"]))).toEqual(["user_1"]);
  });

  it("answers a link write's moved targets under the relation the index names", () => {
    const resolve = resolveFor(replicaWith([]), "relation:assignee/issue");

    expect(
      resolve(
        content(1, "issue_1", ["ebb/link"], {
          edges: [
            { as: "assignee", type: "issue", added: ["user_2"], removed: ["user_1"] },
            { as: "tags", type: "issue", added: ["label_1"], removed: [] },
          ],
        }),
      ),
    ).toEqual(["issue_1", "user_2", "user_1"]);
  });

  it("answers only the changed row when the delta moved another relation", () => {
    const resolve = resolveFor(replicaWith([]), "relation:assignee/issue");

    expect(
      resolve(
        content(1, "issue_1", ["ebb/link"], {
          edges: [{ as: "tags", type: "issue", added: ["label_1"], removed: [] }],
        }),
      ),
    ).toEqual(["issue_1"]);
  });

  it("falls back when a link write carries no delta", () => {
    const resolve = resolveFor(replicaWith([]), "relation:assignee/issue");

    expect(resolve(content(1, "issue_1", ["ebb/link"]))).toBeNull();
  });

  it("answers a membership change's delta, and falls back without one", () => {
    const resolve = resolveFor(replicaWith([]), "relation:assignee/issue");

    expect(
      resolve(
        membership(1, "issue_1", "left", ["issue"], {
          edges: [{ as: "assignee", type: "issue", added: [], removed: ["user_1"] }],
        }),
      ),
    ).toEqual(["issue_1", "user_1"]);
    expect(resolve(membership(2, "issue_1", "left", ["issue"]))).toBeNull();
  });

  it("falls back rather than guess from a malformed relation index name", () => {
    const replica = replicaWith([]);

    expect(
      resolveFor(replica, "relation:assignee")(content(1, "issue_1", ["ebb/link"])),
    ).toBeNull();
    expect(resolveFor(replica, "relation:/issue")(content(1, "issue_1", ["ebb/link"]))).toBeNull();
    expect(
      resolveFor(replica, "relation:assignee/")(content(1, "issue_1", ["ebb/link"])),
    ).toBeNull();
  });
});

describe("index resolvers: existence", () => {
  it("answers the component whose existence the delta moved", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    expect(
      resolve(
        content(1, "todo_1", ["todo/due"], {
          existence: { added: ["todo/due"], removed: [] },
        }),
      ),
    ).toEqual(["todo/due"]);
    expect(
      resolve(
        content(2, "todo_1", ["todo/due"], {
          existence: { added: [], removed: ["todo/due"] },
        }),
      ),
    ).toEqual(["todo/due"]);
  });

  it("answers nothing when the delta moved another component's existence", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    expect(
      resolve(
        content(1, "todo_1", ["todo/status"], {
          existence: { added: ["todo/status"], removed: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("answers a component whose value moved beside another's arrival", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    // One Action can write an existing component and introduce another. The
    // existence delta names only the arrival, but the content change names both
    // components, and `todo/due` is covered, so the value write has no other
    // way to reach the read.
    expect(
      resolve(
        content(1, "todo_1", ["todo/due", "todo/tag"], {
          existence: { added: ["todo/tag"], removed: [] },
        }),
      ),
    ).toEqual(["todo/due"]);
  });

  it("reads a content change's component set when no delta moved existence", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    expect(resolve(content(1, "todo_1", ["todo/due"]))).toEqual(["todo/due"]);
    expect(resolve(content(2, "todo_1", ["todo/title"]))).toEqual([]);
  });

  it("answers an eviction's existence delta, and falls back only when no delta arrived", () => {
    const resolve = resolveFor(replicaWith([]), "exists:todo/due");

    expect(
      resolve(
        membership(1, "todo_1", "left", ["todo"], {
          existence: { added: [], removed: ["todo/due"] },
        }),
      ),
    ).toEqual(["todo/due"]);
    // No delta at all: the journal cannot say what the row took with it.
    expect(resolve(membership(2, "todo_1", "left", ["todo"]))).toBeNull();
    // A delta that moved another component's existence says `todo/due` stayed.
    expect(
      resolve(
        membership(3, "todo_1", "left", ["todo"], {
          existence: { added: ["todo/tag"], removed: [] },
        }),
      ),
    ).toEqual([]);
  });
});

describe("index resolvers: scope", () => {
  const resolve = resolveFor(replicaWith([]), "scope");
  const side = (groupId: string, entityId = "todo_1") => ({ entityId, groupId });

  it("answers both groups a move touched, deduped", () => {
    expect(
      resolve(
        content(1, "todo_1", ["ebb/membership"], {
          membership: { before: side("grp_1"), after: side("grp_2") },
        }),
      ),
    ).toEqual(["grp_1", "grp_2"]);
    // A member refile inside one group moves no group, so the pair is deduped.
    expect(
      resolve(
        content(2, "todo_1", ["ebb/membership"], {
          membership: { before: side("grp_1"), after: side("grp_1", "todo_2") },
        }),
      ),
    ).toEqual(["grp_1"]);
  });

  it("answers the group an evicted row left", () => {
    expect(
      resolve(
        membership(1, "todo_1", "left", ["todo"], {
          membership: { before: side("grp_1"), after: null },
        }),
      ),
    ).toEqual(["grp_1"]);
  });

  it("answers nothing for a content change that left every group alone", () => {
    expect(resolve(content(1, "todo_1", ["todo/title"]))).toEqual([]);
    expect(resolve(content(2, "todo_1", ["ebb/membership"]))).toEqual([]);
  });

  it("falls back only for a membership change that carries no delta", () => {
    expect(resolve(membership(1, "page_1", "left", ["page"]))).toBeNull();
    // A delta that moved other things — `parent` here — moved no pair, so no
    // scoped read is touched.
    expect(
      resolve(
        membership(2, "page_1", "left", ["page"], {
          edges: [{ as: "parent", type: "page", added: [], removed: ["page_0"] }],
        }),
      ),
    ).toEqual([]);
  });
});
