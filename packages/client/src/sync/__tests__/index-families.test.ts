/**
 * One module per derived index family (#1003).
 *
 * A family owns both directions of its contract: the indices a read declares
 * and the keys a change resolves to under them. `structuralReads` composes the
 * same registered list `createIndexResolvers` serves, so a family cannot
 * declare an index the registry has no resolver for, and the registry cannot
 * serve an index no read declares.
 */

import { describe, expect, it } from "vitest";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { type ChangeDelta, type ReplicaChange } from "@ebbjs/storage/replica";

import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import type { IndexDependency, IndexResolver } from "../dependency-index";
import { createIndexResolvers, INDEX_FAMILIES, MEMBERSHIP_INDEX } from "../index-resolvers";
import type { Query } from "../query";
import { structuralReads } from "../selection";

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

const makeClient = () =>
  createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage: createMemoryAdapter(),
    schema,
  });

/** The resolver for one index name, as the dispatcher would look it up. */
const resolveFor = (
  resolvers: Readonly<Record<string, IndexResolver>>,
  index: string,
): IndexResolver => {
  const exact = resolvers[index];
  if (exact !== undefined) return exact;
  for (const [name, resolve] of Object.entries(resolvers)) {
    if (name.endsWith("*") && index.startsWith(name.slice(0, -1))) return resolve;
  }
  throw new Error(`no resolver for ${index}`);
};

const queries = (): readonly Query[] => {
  const client = makeClient();
  return [
    client.issue.query().select({}).where("assignee", "user_1").toQuery(),
    client.todo.query().select({}).has("due").toQuery(),
    client.todo.query().select({}).where("groups", "grp_1").toQuery(),
    client.issue.query().select({}).where("assignee", "user_1").where("groups", "grp_1").toQuery(),
  ];
};

/** The movement a change that moved nothing states. */
const noMovement: ChangeDelta = {
  edges: [],
  existence: { added: [], removed: [] },
  membership: { before: null, after: null },
};

/** A change that names one declared index's key, per family. */
const changeNaming = (dependency: IndexDependency): ReplicaChange => {
  if (dependency.index.startsWith("exists:")) {
    return {
      revision: 1,
      id: "todo_1",
      kind: "content",
      deleted: false,
      components: [dependency.key],
      delta: noMovement,
    };
  }
  if (dependency.index === "scope") {
    return {
      revision: 1,
      id: "todo_1",
      kind: "membership",
      deleted: false,
      membership: "entered",
      models: ["todo"],
      delta: {
        ...noMovement,
        membership: { before: null, after: { entityId: "todo_1", groupId: dependency.key } },
      },
    };
  }
  return {
    revision: 1,
    id: dependency.key,
    kind: "content",
    deleted: false,
    components: ["user/name"],
    delta: noMovement,
  };
};

describe("index families: one list drives declaration and resolution", () => {
  it("registers a resolver for every family name beside the membership resolver", () => {
    const resolvers = createIndexResolvers();

    for (const family of INDEX_FAMILIES) {
      expect(family.names.length).toBeGreaterThan(0);
      for (const name of family.names) {
        expect(resolvers[name], `no resolver registered for ${name}`).toBeTypeOf("function");
      }
    }
    expect(Object.keys(resolvers).sort()).toEqual(
      [MEMBERSHIP_INDEX, ...INDEX_FAMILIES.flatMap((family) => family.names)].sort(),
    );
  });

  it("serves every index name a read declares", () => {
    const resolvers = createIndexResolvers();

    for (const query of queries()) {
      const { indices } = structuralReads(query);
      expect(indices.length, `nothing declared for ${query.source}`).toBeGreaterThan(0);
      for (const { index, key } of indices) {
        const resolve = resolveFor(resolvers, index);
        expect(resolve(changeNaming({ index, key }), index)).toContain(key);
      }
    }
  });

  it("declares a mixed read through composition over the same families", () => {
    const client = makeClient();
    const query = client.issue
      .query()
      .select({})
      .where("assignee", "user_1")
      .where("groups", "grp_1")
      .toQuery();

    expect(structuralReads(query)).toEqual({
      rows: ["issue"],
      indices: [
        { index: "relation:assignee/issue", key: "user_1" },
        { index: "scope", key: "grp_1" },
      ],
      covered: ["ebb/link"],
    });
  });

  it("composes a read that declares all three families", () => {
    const client = makeClient();
    const query = client.issue
      .query()
      .select({})
      .where("assignee", "user_1")
      .has("title")
      .where("groups", "grp_1")
      .toQuery();

    expect(structuralReads(query)).toEqual({
      rows: ["issue"],
      indices: [
        { index: "relation:assignee/issue", key: "user_1" },
        { index: "exists:issue/title", key: "issue/title" },
        { index: "scope", key: "grp_1" },
      ],
      covered: ["ebb/link", "issue/title"],
    });
  });
});
