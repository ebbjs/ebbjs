/**
 * Integration tests for the query engine at the client seam (#498).
 *
 * `client.<entity>.query()` lowers the fluent chain to a serializable
 * `Query`, plans it, and executes the plan synchronously over the
 * client's replica. These tests pin the acceptance criteria from the
 * client side: the replica is the read path, adjacency predicates read
 * the replica's indices without a scan or an accessor traversal, and
 * the lowered value is pure data the planner can describe.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Entity, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { buildQueryBuilder } from "../query-builder";
import { planQuery } from "../query-plan";
import { callApplyAction } from "../test-utils";
import { traversalCounter } from "../traversal-counter";

const issue = defineEntity("issue", { title: e.string(), status: e.string() });
const user = defineEntity("user", { name: e.string() });
const project = defineEntity("project", { name: e.string() });

const schema = defineSchema({
  entities: { issue, user, project },
  relationships: {
    issue_assignee: defineRelationship({ source: issue, target: user, as: "assignee" }),
    issue_project: defineRelationship({ source: issue, target: project, as: "project" }),
  },
  version: 1,
});

type Client = ReturnType<typeof createClient<typeof schema>>;

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

const remove = (gsn: number, id: string, type: string): Action =>
  action(gsn, [
    { id: `u_${gsn}`, subject_id: id, subject_type: type, method: "delete", data: null },
  ]);

const link = (gsn: number, sourceId: string, targetId: string, as: string, type: string): Action =>
  put(gsn, `rel_${gsn}`, "relationship", {
    source_id: sourceId,
    target_id: targetId,
    field: as,
    type,
  });

/** Seed rows through the client's inbound funnel, so the replica sees them. */
const seed = async (client: Client, actions: readonly Action[]): Promise<void> => {
  for (const next of actions) await callApplyAction(client, next);
};

const ids = (rows: readonly { readonly id: string }[]): readonly string[] =>
  rows.map((row) => row.id);

/** The wire entity a direct `storage.entities.set` writes — shim-only. */
const shimIssue = (id: string, title: string): Entity => ({
  id,
  type: "issue",
  data: { fields: { title: field(title, `u_${id}`), status: field("open", `u_${id}`) } },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

describe("client.<entity>.query() — replica read path", () => {
  it("reads the replica: a shim-only row is invisible, the funneled row is returned", async () => {
    const client = makeClient();
    await client.storage.entities.set(shimIssue("issue_shim", "Shim only"));

    expect(await client.issue.query()).toEqual([]);

    await seed(client, [put(1, "issue_1", "issue", { title: "Ship", status: "open" })]);

    expect(ids(await client.issue.query())).toEqual(["issue_1"]);
  });

  it("executes a filtered list: where(field) AND where(relationship)", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "user_1", "user", { name: "Ada" }),
      put(2, "user_2", "user", { name: "Grace" }),
      put(3, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(4, "issue_2", "issue", { title: "Test", status: "done" }),
      put(5, "issue_3", "issue", { title: "Docs", status: "open" }),
      link(6, "issue_1", "user_1", "assignee", "issue"),
      link(7, "issue_2", "user_1", "assignee", "issue"),
      link(8, "issue_3", "user_2", "assignee", "issue"),
    ]);

    const out = await client.issue.query().where("status", "open").where("assignee", "user_1");

    expect(ids(out)).toEqual(["issue_1"]);
  });

  it("executes a reverse traversal: the sources pointing at a target", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "user_1", "user", { name: "Ada" }),
      put(2, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(3, "issue_2", "issue", { title: "Test", status: "done" }),
      put(4, "issue_3", "issue", { title: "Docs", status: "open" }),
      link(5, "issue_1", "user_1", "assignee", "issue"),
      link(6, "issue_2", "user_1", "assignee", "issue"),
      link(7, "issue_3", "user_2", "assignee", "issue"),
    ]);

    const out = await client.issue.query().where("assignee", "user_1");

    expect(ids(out)).toEqual(["issue_1", "issue_2"]);
  });

  it("reads adjacency from the replica: no traversal, no storage index, no scan", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(2, "issue_2", "issue", { title: "Test", status: "open" }),
      link(3, "issue_1", "user_1", "assignee", "issue"),
      link(4, "issue_2", "user_1", "assignee", "issue"),
    ]);
    // Hydrate before installing the spies so the assertion covers the
    // query path only.
    await client.issue.query();

    const byRelationship = vi.spyOn(client.storage.entities, "queryByRelationship");
    const byMembership = vi.spyOn(client.storage.entities, "queryByMembership");
    const byType = vi.spyOn(client.storage.entities, "query");
    const replicaRelationships = vi.spyOn(client.replica, "relationships");
    traversalCounter.reset();

    const out = await client.issue.query().where("assignee", "user_1");

    expect(ids(out)).toEqual(["issue_1", "issue_2"]);
    expect(traversalCounter.rowsExamined).toBe(0);
    expect(replicaRelationships).toHaveBeenCalledWith({
      as: "assignee",
      type: "issue",
      targetId: "user_1",
    });
    expect(byRelationship).not.toHaveBeenCalled();
    expect(byMembership).not.toHaveBeenCalled();
    expect(byType).not.toHaveBeenCalled();
  });

  it("reflects a replica change on the next await (delete through the funnel)", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_1", "issue", { title: "Ship", status: "open" }),
      put(2, "issue_2", "issue", { title: "Test", status: "open" }),
    ]);
    expect(ids(await client.issue.query())).toEqual(["issue_1", "issue_2"]);

    await seed(client, [remove(3, "issue_2", "issue")]);

    expect(ids(await client.issue.query())).toEqual(["issue_1"]);
  });

  it("orders by id by default and tie-breaks orderBy by id", async () => {
    const client = makeClient();
    await seed(client, [
      put(1, "issue_3", "issue", { title: "a", status: "open" }),
      put(2, "issue_2", "issue", { title: "b", status: "open" }),
      put(3, "issue_1", "issue", { title: "a", status: "open" }),
    ]);

    expect(ids(await client.issue.query())).toEqual(["issue_1", "issue_2", "issue_3"]);
    expect(ids(await client.issue.query().orderBy("title", "asc"))).toEqual([
      "issue_1",
      "issue_3",
      "issue_2",
    ]);
  });
});

describe("QueryBuilder.toQuery() — the serializable value", () => {
  const client = makeClient();

  it("lowers the chain to pure, JSON-serializable data", () => {
    const query = client.issue
      .query()
      .where("status", "open")
      .where("assignee", "user_1")
      .or("groups", "group_1")
      .orderBy("title", "desc")
      .limit(5)
      .toQuery();

    expect(query).toEqual({
      source: "issue",
      groups: [
        [
          { kind: "field", field: "status", value: "open" },
          { kind: "relationship", as: "assignee", type: "issue", anyOf: ["user_1"] },
        ],
        [{ kind: "membership", anyOf: ["group_1"] }],
      ],
      order: { field: "title", direction: "desc" },
      limit: 5,
      joins: [],
    });
    expect(JSON.parse(JSON.stringify(query))).toEqual(query);
  });

  it("names the source, relationship, and entityGroup in the planner's readTypes", () => {
    const all = client.issue
      .query()
      .where("assignee", "user_1")
      .where("groups", "group_1")
      .toQuery();
    expect(planQuery(all).readTypes).toEqual(["issue", "relationship", "entityGroup"]);

    const reverse = client.issue.query().where("assignee", "user_1").toQuery();
    expect(planQuery(reverse).readTypes).toEqual(["issue", "relationship"]);
  });

  it("a chain over materialized rows names no source type", () => {
    const seedRow = shimIssue("issue_1", "Ship");
    // A bare builder has no schema context; field predicates stay valid.
    const query = buildQueryBuilder([seedRow], issue.shape).where("status", "open").toQuery();
    expect(query.source).toBe("");
    expect(query.joins).toEqual([]);
    expect(planQuery(query).readTypes).toEqual([""]);
  });
});
