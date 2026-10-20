/**
 * Planner tests for the serializable query value (#498).
 *
 * The planner is pure: it turns a `Query` into an ordered op pipeline and
 * the `readTypes` invalidation record, with no registry, storage, or
 * replica in sight.
 */

import { describe, expect, it } from "vitest";

import { emptyQuery, type Query } from "../query";
import { planQuery } from "../query-plan";

const query = (overrides: Partial<Query> & Pick<Query, "groups">): Query => ({
  ...emptyQuery("todo"),
  ...overrides,
});

describe("planQuery", () => {
  it("plans a field-filtered query as scan, select, order", () => {
    const plan = planQuery(
      query({ groups: [[{ kind: "field", field: "completed", value: true }]] }),
    );

    expect(plan.ops).toEqual([
      { kind: "scan", type: "todo" },
      { kind: "select", predicates: [{ kind: "filter", field: "completed", value: true }] },
      { kind: "order", field: null, direction: "asc" },
    ]);
    expect(plan.readTypes).toEqual(["todo", "entityGroup"]);
  });

  it("pushes indexed predicates ahead of filters and records the read types", () => {
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
    expect(plan.readTypes).toEqual(["todo", "relationship", "entityGroup"]);
  });

  it("records the relationship row type, not the adjacency wire type", () => {
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

    expect(plan.readTypes).toEqual(["todo", "relationship", "entityGroup"]);
  });

  it("deduplicates read types in predicate order", () => {
    const plan = planQuery(
      query({
        groups: [
          [{ kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1"] }],
          [{ kind: "relationship", as: "reviewer", type: "todo", anyOf: ["user_2"] }],
        ],
      }),
    );

    expect(plan.readTypes).toEqual(["todo", "relationship", "entityGroup"]);
  });

  it("plans an unfiltered query as scan and the default id ordering", () => {
    expect(planQuery(emptyQuery("todo")).ops).toEqual([
      { kind: "scan", type: "todo" },
      { kind: "order", field: null, direction: "asc" },
    ]);
  });

  it("plans explicit ordering and a non-negative limit", () => {
    const plan = planQuery(
      query({ groups: [], order: { field: "title", direction: "desc" }, limit: 10 }),
    );

    expect(plan.ops.slice(1)).toEqual([
      { kind: "order", field: "title", direction: "desc" },
      { kind: "limit", limit: 10 },
    ]);
  });

  it("treats a negative limit as no limit", () => {
    const plan = planQuery(query({ groups: [], limit: -1 }));

    expect(plan.ops.map((op) => op.kind)).toEqual(["scan", "order"]);
  });
});
