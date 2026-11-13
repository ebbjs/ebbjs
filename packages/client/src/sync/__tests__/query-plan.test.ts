/**
 * Planner tests for the serializable query value (#498).
 *
 * The planner is pure: it turns a `Query` into an ordered op pipeline and a
 * component-read record, with no registry, storage, or replica in sight.
 */

import { describe, expect, it } from "vitest";

import { emptyQuery, type Query } from "../query";
import {
  compileReadComponents,
  planQuery,
  readComponentsFor,
  rowReadComponentsFor,
} from "../query-plan";

const query = (overrides: Partial<Query> & Pick<Query, "groups">): Query => ({
  ...emptyQuery("todo"),
  ...overrides,
});

describe("planQuery", () => {
  it("plans a field-filtered query as scan, select, order", () => {
    const filtered = query({ groups: [[{ kind: "field", field: "completed", value: true }]] });
    const plan = planQuery(filtered);

    expect(plan.ops).toEqual([
      { kind: "scan", type: "todo" },
      { kind: "select", predicates: [{ kind: "filter", field: "completed", value: true }] },
      { kind: "order", field: null, direction: "asc" },
    ]);
    expect(plan.readComponents).toEqual(["todo/completed"]);
    expect(rowReadComponentsFor(filtered)).toEqual(["todo/completed", "todo/*", "ebb/membership"]);
  });

  it("pushes indexed predicates ahead of filters and records the read components", () => {
    const plan = planQuery(
      query({
        groups: [
          [
            { kind: "field", field: "completed", value: true },
            { kind: "membership", anyOf: ["group_1"] },
            { kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1"] },
          ],
        ],
      }),
    );

    expect(plan.ops[1]).toEqual({
      kind: "select",
      predicates: [
        { kind: "membership", anyOf: ["group_1"] },
        { kind: "adjacency", as: "owner", type: "todo", anyOf: ["user_1"] },
        { kind: "filter", field: "completed", value: true },
      ],
    });
    expect(plan.readComponents).toEqual(["todo/completed", "ebb/link", "ebb/membership"]);
  });

  it("reads the link component, not the adjacency wire type", () => {
    const plan = planQuery(
      query({
        groups: [
          [{ kind: "relationship", as: "owner", type: "todo_owner", anyOf: ["user_1"] }],
          [{ kind: "relationship", as: "reviewer", type: "todo_reviewer", anyOf: ["user_2"] }],
          [
            { kind: "membership", anyOf: ["group_1"] },
            { kind: "relationship", as: "tags", type: "todo_tags", anyOf: null },
          ],
        ],
      }),
    );

    // No branch names a source component, so the source is read whole.
    expect(plan.readComponents).toEqual(["todo/*", "ebb/link", "ebb/membership"]);
  });

  it("deduplicates read components across branches", () => {
    const plan = planQuery(
      query({
        groups: [
          [{ kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1"] }],
          [{ kind: "relationship", as: "reviewer", type: "todo", anyOf: ["user_2"] }],
        ],
      }),
    );

    expect(plan.readComponents).toEqual(["todo/*", "ebb/link"]);
  });

  it("plans an existence predicate as an index op ahead of filters", () => {
    const plan = planQuery(
      query({
        groups: [
          [
            { kind: "field", field: "title", value: "Ship" },
            { kind: "existence", component: "todo/draft", present: true },
            { kind: "existence", component: "todo/body", present: false },
          ],
        ],
      }),
    );

    expect(plan.ops[1]).toEqual({
      kind: "select",
      predicates: [
        { kind: "existence", component: "todo/draft", present: true },
        { kind: "existence", component: "todo/body", present: false },
        { kind: "filter", field: "title", value: "Ship" },
      ],
    });
    // Existence and equality both read the component they name; the field
    // equality is what makes the source readable per component.
    expect(plan.readComponents).toEqual(["todo/title", "todo/draft", "todo/body"]);
  });

  it("plans explicit ordering and a non-negative limit", () => {
    const plan = planQuery(
      query({ groups: [], order: { field: "title", direction: "desc" }, limit: 10 }),
    );

    expect(plan.ops.slice(1)).toEqual([
      { kind: "order", field: "title", direction: "desc" },
      { kind: "limit", limit: 10 },
    ]);
    expect(plan.readComponents).toEqual(["todo/*"]);
  });

  it("treats a negative limit as no limit", () => {
    const plan = planQuery(query({ groups: [], limit: -1 }));

    expect(plan.ops.map((op) => op.kind)).toEqual(["scan", "order"]);
  });

  it("reads the source whole when a branch only excludes", () => {
    // A `hasNot`, a null equality ("no live value"), and a membership each
    // admit a row that carries none of the components the query names.
    const hasNot = query({
      groups: [[{ kind: "existence", component: "todo/draft", present: false }]],
    });
    const nullEquality = query({ groups: [[{ kind: "field", field: "status", value: null }]] });
    const membership = query({ groups: [[{ kind: "membership", anyOf: ["group_1"] }]] });

    expect(readComponentsFor(hasNot)).toEqual(["todo/*"]);
    expect(readComponentsFor(nullEquality)).toEqual(["todo/*"]);
    expect(readComponentsFor(membership)).toEqual(["todo/*", "ebb/membership"]);
  });

  it("adds membership to a projected row even when no predicate reads it", () => {
    const filtered = query({ groups: [[{ kind: "field", field: "status", value: "open" }]] });

    expect(rowReadComponentsFor(filtered)).toContain("ebb/membership");
  });

  it("adds each joined model whole to a projected row", () => {
    const joined: Query = {
      ...emptyQuery("issue"),
      groups: [[{ kind: "field", field: "title", value: "Ship" }]],
      joins: [
        {
          kind: "relationship",
          as: "assignee",
          type: "issue",
          target: "user",
          direction: "forward",
          cardinality: "one",
        },
        { kind: "membership", as: "groups", target: "ebb", cardinality: "many" },
      ],
    };
    const plan = planQuery(joined);

    expect(plan.readComponents).toEqual(["issue/title", "ebb/link", "ebb/membership"]);
    expect(rowReadComponentsFor(joined)).toEqual([
      "issue/title",
      "ebb/link",
      "ebb/membership",
      "issue/*",
      "user/*",
      "ebb/group",
    ]);
  });

  it("splits a read set into exact components and whole models", () => {
    const compiled = compileReadComponents(["todo/status", "todo/*", "ebb/*", "todo/status"]);

    expect([...compiled.components]).toEqual(["todo/status"]);
    expect([...compiled.models].sort()).toEqual(["ebb", "todo"]);
  });

  it("reads nothing for a candidate chain", () => {
    const query = emptyQuery("");
    expect(readComponentsFor(query)).toEqual([]);
    expect(rowReadComponentsFor(query)).toEqual([]);
  });
});
