/**
 * `with(...)` joins (#519) at the client seam.
 *
 * A join widens each projected row one level using the replica's
 * adjacency indices: one-cardinality forward joins resolve to a row or
 * `null`, many and reverse joins to arrays, and membership joins to the
 * row's groups. A join reads its targets by id — it never scans a target
 * type — and the typed surface derives its keys from the schema's
 * relationship map.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e, type WireFields } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import type { GroupFields } from "../../schema/system-entities";
import { createClient } from "../client";
import type { QueryRowOf } from "../../index";
import type { EntityFields } from "../namespace";
import { planQuery } from "../query-plan";
import type { ProjectedRow, QueryRow } from "../query-builder";
import { callApplyAction } from "../test-utils";

const issue = defineEntity("issue", { title: e.string(), status: e.string() });
const user = defineEntity("user", { name: e.string() });
const label = defineEntity("label", { name: e.string() });
const page = defineEntity("page", { title: e.string() });
const reference = defineEntity("reference", { label: e.string() });

const issueAssignee = defineRelationship({
  source: issue,
  target: user,
  as: "assignee",
  sourceCardinality: "one",
});
const issueTags = defineRelationship({
  source: issue,
  target: label,
  as: "tags",
  sourceCardinality: "many",
});
/** The reverse side of a comment's parent link is the issue's comments. */
const commentIssue = defineRelationship({
  source: page,
  target: issue,
  as: "comments",
  sourceCardinality: "one",
});
const pageParent = defineRelationship({
  source: page,
  target: page,
  as: "parent",
  sourceCardinality: "one",
});
const pageChildren = defineRelationship({
  source: page,
  target: page,
  as: "children",
  sourceCardinality: "many",
});
const pageBacklinks = defineRelationship({
  source: reference,
  target: page,
  as: "backlinks",
  sourceCardinality: "many",
});

const schema = defineSchema({
  entities: { issue, user, label, page, reference },
  relationships: {
    issueAssignee,
    issueTags,
    commentIssue,
    pageParent,
    pageChildren,
    pageBacklinks,
  },
  version: 1,
});

type Client = ReturnType<typeof createClient<typeof schema>>;
type IssueRow = QueryRow<EntityFields<typeof issue>>;
type UserRow = ProjectedRow<EntityFields<typeof user>>;
type LabelRow = ProjectedRow<EntityFields<typeof label>>;
type PageRow = ProjectedRow<EntityFields<typeof page>>;
type GroupRow = ProjectedRow<WireFields<GroupFields>>;

type IsAny<T> = 0 extends 1 & T ? true : false;
type JoinedIssue = Omit<IssueRow, "assignee"> & { readonly assignee: UserRow | null };

const makeClient = (): Client => {
  const storage = createMemoryAdapter();
  return createClient({ serverUrl: "http://x", actorId: "actor_1", storage, schema });
};

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

const seedIssueGraph = async (client: Client): Promise<void> => {
  await seed(client, [
    put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
    put(2, "issue_2", "issue", { title: "Test", status: "open" }),
    put(3, "user_1", "user", { name: "Ada" }),
    put(4, "label_1", "label", { name: "bug" }),
    put(5, "label_2", "label", { name: "docs" }),
    put(6, "comment_1", "page", { title: "A comment" }),
    link(7, "issue_1", "user_1", "assignee", "issue"),
    link(8, "issue_1", "label_1", "tags", "issue"),
    link(9, "issue_1", "label_2", "tags", "issue"),
    link(10, "comment_1", "issue_1", "comments", "page"),
  ]);
};

describe("with(...) — runtime", () => {
  it("widens a row with forward-one, forward-many, and reverse joins", async () => {
    const client = makeClient();
    await seedIssueGraph(client);

    const rows = await client.issue.query().with({ assignee: true, tags: true, comments: true });
    const first = rows.find((row) => row.id === "issue_1");
    const second = rows.find((row) => row.id === "issue_2");

    expect(first?.assignee).toEqual({ name: "Ada", id: "user_1" });
    expect(first?.tags).toEqual([
      { name: "bug", id: "label_1" },
      { name: "docs", id: "label_2" },
    ]);
    expect(first?.comments).toEqual([{ title: "A comment", id: "comment_1" }]);
    expect(second?.assignee).toBeNull();
    expect(second?.tags).toEqual([]);
    expect(second?.comments).toEqual([]);
  });

  it("joins after the plan narrows and orders the rows", async () => {
    const client = makeClient();
    await seedIssueGraph(client);

    const rows = await client.issue
      .query()
      .where("status", "open")
      .orderBy("title", "asc")
      .limit(1)
      .with({ assignee: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("issue_1");
    expect(rows[0]?.assignee?.name).toBe("Ada");
  });

  it("drops a dangling or tombstoned target from a join", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
      link(2, "issue_1", "user_missing", "assignee", "issue"),
    ]);

    const [row] = await client.issue.query().with({ assignee: true });
    expect(row?.assignee).toBeNull();
  });

  it("joins built-in membership rows", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(2, "group_1", "group", { name: "Workspace" }),
      put(3, "eg_1", "entityGroup", { entity_id: "issue_1", group_id: "group_1" }),
    ]);

    const [row] = await client.issue.query().with({ groups: true });
    expect(row?.groups).toEqual([{ name: "Workspace", id: "group_1" }]);
  });

  it("rejects a nested selector at runtime", () => {
    const client = makeClient();
    expect(() =>
      client.issue.query().with({ assignee: { tags: true } } as unknown as { assignee: true }),
    ).toThrow(/nested/);
  });

  it("rejects an unknown join key at runtime", () => {
    const client = makeClient();
    expect(() =>
      client.issue.query().with({ nope: true } as unknown as { assignee: true }),
    ).toThrow(/not a declared relationship/);
  });
});

describe("with(...) — typing", () => {
  it("types each join by cardinality and keeps base fields", async () => {
    const client = makeClient();
    await seedIssueGraph(client);

    const rows = await client.issue.query().with({ assignee: true, tags: true, comments: true });
    const row = rows[0];
    if (row === undefined) throw new Error("expected a row");

    expectTypeOf(row.assignee).toEqualTypeOf<UserRow | null>();
    expectTypeOf(row.tags).toEqualTypeOf<readonly LabelRow[]>();
    expectTypeOf(row.comments).toEqualTypeOf<readonly PageRow[]>();
    expectTypeOf(row.title).toEqualTypeOf<IssueRow["title"]>();

    const chained = await client.issue.query().with({ assignee: true }).with({ tags: true });
    const chainedRow = chained[0];
    if (chainedRow !== undefined) {
      expectTypeOf(chainedRow.assignee).toEqualTypeOf<UserRow | null>();
      expectTypeOf(chainedRow.tags).toEqualTypeOf<readonly LabelRow[]>();
      // @ts-expect-error comments was not selected
      void chainedRow.comments;
    }

    const first = await client.issue.query().with({ assignee: true }).first();
    const firstExpected: JoinedIssue | undefined = first;
    const firstRoundTrip: typeof first = firstExpected;
    const firstNotAny: IsAny<typeof first> = false;
    void firstRoundTrip;
    void firstNotAny;

    const [withGroups] = await client.issue.query().with({ groups: true });
    if (withGroups !== undefined) {
      expectTypeOf(withGroups.groups).toEqualTypeOf<readonly GroupRow[]>();
    }

    const [narrow] = await client.issue.query().with({ assignee: true });
    if (narrow !== undefined) {
      // @ts-expect-error tags was not selected
      void narrow.tags;
    }
  });

  it("exposes the same row type through QueryRowOf", () => {
    const base = {} as QueryRowOf<typeof schema, "issue">;
    expectTypeOf(base.groupIds).toEqualTypeOf<readonly string[]>();
    expectTypeOf(base.title).toEqualTypeOf<string>();

    const row = {} as QueryRowOf<typeof schema, "issue", "assignee" | "groups">;
    expectTypeOf(row.assignee).toEqualTypeOf<UserRow | null>();
    expectTypeOf(row.groups).toEqualTypeOf<readonly GroupRow[]>();
    expectTypeOf(row.groupIds).toEqualTypeOf<readonly string[]>();
    expectTypeOf(row.title).toEqualTypeOf<string>();
    // @ts-expect-error tags was not selected
    void row.tags;

    // @ts-expect-error "nope" is not a join on issue
    const invalid: QueryRowOf<typeof schema, "issue", "nope"> = {} as never;
    void invalid;
  });

  it("rejects nested and unknown selectors at the type level", () => {
    const client = makeClient();
    expect(() => {
      // @ts-expect-error nested with(...) is not a valid selector
      client.issue.query().with({ assignee: { tags: true } });
    }).toThrow(/nested/);
    expect(() => {
      // @ts-expect-error "nope" is not a relationship on issue
      client.issue.query().with({ nope: true });
    }).toThrow(/not a declared relationship/);
    expect(() => {
      // @ts-expect-error an explicit undefined is not a selection
      client.issue.query().with({ assignee: undefined });
    }).toThrow(/nested/);
  });
});

describe("with(...) — planning and adjacency", () => {
  it("lowers joins to pure data and names their read types in the plan", () => {
    const client = makeClient();
    const query = client.issue.query().with({ assignee: true, comments: true }).toQuery();

    expect(query.joins).toEqual([
      {
        kind: "relationship",
        as: "assignee",
        type: "issue",
        target: "user",
        direction: "forward",
        cardinality: "one",
      },
      {
        kind: "relationship",
        as: "comments",
        type: "page",
        target: "page",
        direction: "reverse",
        cardinality: "many",
      },
    ]);

    const plan = planQuery(query);
    expect(plan.readTypes).toEqual(["issue", "user", "page", "relationship", "entityGroup"]);
    expect(plan.joins).toEqual(query.joins);
  });

  it("reads adjacency and by-id rows without scanning a joined type", async () => {
    const client = makeClient();
    await seedIssueGraph(client);
    // Hydrate before installing the spies so the assertion covers the
    // query path only.
    await client.issue.query();

    const replicateIterate = vi.spyOn(client.replica, "iterate");
    const replicateRelationships = vi.spyOn(client.replica, "relationships");

    const [row] = await client.issue
      .query()
      .where("title", "Ship")
      .with({ assignee: true, tags: true, comments: true });

    expect(row?.assignee?.name).toBe("Ada");
    expect(row?.tags).toHaveLength(2);
    expect(replicateIterate.mock.calls.map(([type]) => type)).toEqual(["issue"]);
    expect(replicateRelationships).toHaveBeenCalledWith({
      as: "assignee",
      type: "issue",
      sourceId: "issue_1",
    });
    expect(replicateRelationships).toHaveBeenCalledWith({
      as: "tags",
      type: "issue",
      sourceId: "issue_1",
    });
    expect(replicateRelationships).toHaveBeenCalledWith({
      as: "comments",
      type: "page",
      targetId: "issue_1",
    });
  });

  it("reads membership adjacency without scanning the group type", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(2, "group_1", "group", { name: "Workspace" }),
      put(3, "eg_1", "entityGroup", { entity_id: "issue_1", group_id: "group_1" }),
    ]);
    await client.issue.query();

    const replicateIterate = vi.spyOn(client.replica, "iterate");
    const replicateMemberships = vi.spyOn(client.replica, "memberships");

    const [row] = await client.issue.query().with({ groups: true });

    expect(row?.groups).toEqual([{ name: "Workspace", id: "group_1" }]);
    expect(replicateIterate.mock.calls.map(([type]) => type)).toEqual(["issue"]);
    expect(replicateMemberships).toHaveBeenCalledWith({ entityId: "issue_1" });
  });
});

describe("with(...) — page tree and backlinks", () => {
  it("expresses a page tree and a backlinks list", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "page_root", "page", { title: "Root" }),
      put(2, "page_child", "page", { title: "Child" }),
      put(3, "page_other", "page", { title: "Other" }),
      put(4, "page_target", "page", { title: "Target" }),
      put(5, "ref_1", "reference", { label: "Links here" }),
      link(6, "page_root", "page_child", "children", "page"),
      link(7, "page_child", "page_root", "parent", "page"),
      link(8, "ref_1", "page_target", "backlinks", "reference"),
    ]);

    const [root] = await client.page.query().where("title", "Root").with({ children: true });
    expect(root?.children).toEqual([{ title: "Child", id: "page_child" }]);

    const [child] = await client.page.query().where("title", "Child").with({ parent: true });
    expect(child?.parent).toEqual({ title: "Root", id: "page_root" });

    const [target] = await client.page.query().where("title", "Target").with({ backlinks: true });
    expect(target?.backlinks).toEqual([{ label: "Links here", id: "ref_1" }]);
  });
});
