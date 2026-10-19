/**
 * Executor tests for the synchronous query pipeline (#498).
 *
 * The executor reads a {@link Plan} over the replica's materialized rows
 * and adjacency indices. It is fully synchronous — the acceptance
 * criterion is a `readonly Entity[]` with no `await` — and it never
 * scans a type per accessor: an indexed predicate reads
 * `replica.relationships` / `replica.memberships` directly.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";

import { emptyQuery, type Predicate, type Query } from "../query";
import { planQuery } from "../query-plan";
import { createReplicaExecutor, createRowsExecutor, executePlan } from "../query-execute";
import { traversalCounter } from "../traversal-counter";

const field = (value: unknown, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const put = (gsn: number, id: string, type: string, fields: Record<string, unknown>): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `u_${id}`,
      subject_id: id,
      subject_type: type,
      method: "put",
      data: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, field(value, `u_${id}`)]),
        ),
      },
    },
  ],
});

const remove = (gsn: number, id: string, type: string): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    { id: `u_${id}_del`, subject_id: id, subject_type: type, method: "delete", data: null },
  ],
});

/** A materialized row, as a relationship accessor chain would hold it. */
const row = (id: string, fields: Record<string, unknown>): Entity => ({
  id,
  type: "todo",
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, field(value, `u_${id}`)]),
    ),
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
});

const seed = (actions: readonly Action[]) => {
  const replica = createReplica();
  actions.forEach((action, i) => replica.ingest(action, action.updates, i + 1));
  return replica;
};

const query = (overrides: Partial<Query> & Pick<Query, "groups">): Query => ({
  ...emptyQuery("todo"),
  ...overrides,
});

const run = (predicates: readonly Predicate[]): readonly string[] =>
  executePlan(
    planQuery(query({ groups: [predicates] })),
    createReplicaExecutor(
      seed([
        put(1, "todo_1", "todo", { title: "Ship", completed: true }),
        put(2, "todo_2", "todo", { title: "Test", completed: false }),
        put(3, "todo_3", "todo", { title: "Ship", completed: false }),
      ]),
    ),
  ).map((row) => row.id);

describe("executePlan", () => {
  it("executes a field-filtered query over the replica", () => {
    expect(run([{ kind: "field", field: "completed", value: true }])).toEqual(["todo_1"]);
  });

  it("executes a reverse-traversal query from the adjacency index", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship" }),
      put(2, "todo_2", "todo", { title: "Test" }),
      put(3, "todo_3", "todo", { title: "Elsewhere" }),
      put(4, "user_1", "user", { name: "Ada" }),
      put(5, "user_2", "user", { name: "Grace" }),
      put(6, "rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "user_1",
        field: "owner",
        type: "todo",
      }),
      put(7, "rel_2", "relationship", {
        source_id: "todo_2",
        target_id: "user_1",
        field: "owner",
        type: "todo",
      }),
      put(8, "rel_3", "relationship", {
        source_id: "todo_3",
        target_id: "user_2",
        field: "owner",
        type: "todo",
      }),
    ]);
    const relationships = vi.spyOn(replica, "relationships");
    const iterate = vi.spyOn(replica, "iterate");
    const plan = planQuery(
      query({
        groups: [[{ kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1"] }]],
      }),
    );

    traversalCounter.reset();
    const rows: readonly Entity[] = executePlan(plan, createReplicaExecutor(replica));

    expect(rows.map((row) => row.id)).toEqual(["todo_1", "todo_2"]);
    expect(traversalCounter.rowsExamined).toBe(0);
    expect(relationships).toHaveBeenCalledWith({ as: "owner", type: "todo", targetId: "user_1" });
    // One scan, of the source type: the only whole-type read a plan makes.
    expect(iterate).toHaveBeenCalledTimes(1);
    expect(iterate).toHaveBeenCalledWith("todo");
  });

  it("unions DNF groups and dedupes rows that match more than one", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship", completed: true }),
      put(2, "todo_2", "todo", { title: "Ship", completed: false }),
      put(3, "todo_3", "todo", { title: "Test", completed: false }),
    ]);
    const plan = planQuery(
      query({
        groups: [
          [{ kind: "field", field: "completed", value: true }],
          [{ kind: "field", field: "title", value: "Ship" }],
        ],
      }),
    );

    const rows = executePlan(plan, createReplicaExecutor(replica));

    expect(rows.map((row) => row.id)).toEqual(["todo_1", "todo_2"]);
  });

  it("hides tombstones", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship" }),
      put(2, "todo_2", "todo", { title: "Test" }),
      remove(3, "todo_1", "todo"),
    ]);

    const rows = executePlan(planQuery(emptyQuery("todo")), createReplicaExecutor(replica));

    expect(rows.map((row) => row.id)).toEqual(["todo_2"]);
  });

  it("matches nothing for an anyOf that names no live edge or group", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship" }),
      put(2, "rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "user_1",
        field: "owner",
        type: "todo",
      }),
      put(3, "eg_1", "entityGroup", { entity_id: "todo_1", group_id: "group_1" }),
    ]);
    const executor = createReplicaExecutor(replica);

    const byEdge = executePlan(
      planQuery(
        query({ groups: [[{ kind: "relationship", as: "owner", type: "todo", anyOf: null }]] }),
      ),
      executor,
    );
    const byGroup = executePlan(
      planQuery(query({ groups: [[{ kind: "membership", anyOf: null }]] })),
      executor,
    );

    expect(byEdge).toEqual([]);
    expect(byGroup).toEqual([]);
  });

  it("unions the index hits for a multi-target anyOf", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship" }),
      put(2, "todo_2", "todo", { title: "Test" }),
      put(3, "todo_3", "todo", { title: "Elsewhere" }),
      put(4, "rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "user_1",
        field: "owner",
        type: "todo",
      }),
      put(5, "rel_2", "relationship", {
        source_id: "todo_2",
        target_id: "user_2",
        field: "owner",
        type: "todo",
      }),
    ]);

    const rows = executePlan(
      planQuery(
        query({
          groups: [
            [{ kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1", "user_2"] }],
          ],
        }),
      ),
      createReplicaExecutor(replica),
    );

    expect(rows.map((row) => row.id)).toEqual(["todo_1", "todo_2"]);
  });

  it("filters by membership", () => {
    const replica = seed([
      put(1, "todo_1", "todo", { title: "Ship" }),
      put(2, "todo_2", "todo", { title: "Test" }),
      put(3, "eg_1", "entityGroup", { entity_id: "todo_1", group_id: "group_1" }),
      put(4, "eg_2", "entityGroup", { entity_id: "todo_2", group_id: "group_2" }),
    ]);

    const rows = executePlan(
      planQuery(query({ groups: [[{ kind: "membership", anyOf: ["group_1"] }]] })),
      createReplicaExecutor(replica),
    );

    expect(rows.map((row) => row.id)).toEqual(["todo_1"]);
  });

  it("orders by field and tie-breaks by entity id ascending", () => {
    const replica = seed([
      put(1, "todo_2", "todo", { title: "Same" }),
      put(2, "todo_10", "todo", { title: "Same" }),
      put(3, "todo_1", "todo", { title: "Same" }),
      put(4, "todo_3", "todo", { title: "Alpha" }),
    ]);
    const executor = createReplicaExecutor(replica);

    const ascending = executePlan(
      planQuery(query({ groups: [], order: { field: "title", direction: "asc" } })),
      executor,
    );
    const descending = executePlan(
      planQuery(query({ groups: [], order: { field: "title", direction: "desc" } })),
      executor,
    );

    expect(ascending.map((row) => row.id)).toEqual(["todo_3", "todo_1", "todo_10", "todo_2"]);
    expect(descending.map((row) => row.id)).toEqual(["todo_1", "todo_10", "todo_2", "todo_3"]);
  });

  it("puts rows with a missing field last and slices after ordering", () => {
    const replica = seed([
      put(1, "todo_3", "todo", { title: "Zeta" }),
      put(2, "todo_1", "todo", { title: "Alpha" }),
      put(3, "todo_2", "todo", {}),
    ]);

    const rows = executePlan(
      planQuery(query({ groups: [], order: { field: "title", direction: "asc" }, limit: 2 })),
      createReplicaExecutor(replica),
    );

    expect(rows.map((row) => row.id)).toEqual(["todo_1", "todo_3"]);
  });

  it("limits the default id ordering", () => {
    const replica = seed([
      put(1, "todo_b", "todo", { title: "B" }),
      put(2, "todo_a", "todo", { title: "A" }),
      put(3, "todo_c", "todo", { title: "C" }),
    ]);

    const rows = executePlan(
      planQuery(query({ groups: [], limit: 2 })),
      createReplicaExecutor(replica),
    );

    expect(rows.map((row) => row.id)).toEqual(["todo_a", "todo_b"]);
  });

  it("executes a candidate-only chain and rejects an indexed predicate there", () => {
    const rows: readonly Entity[] = [
      row("todo_1", { title: "Ship" }),
      row("todo_2", { title: "Test" }),
    ];
    const executor = createRowsExecutor(rows);

    const selected = executePlan(
      planQuery(query({ groups: [[{ kind: "field", field: "title", value: "Test" }]] })),
      executor,
    );

    expect(selected.map((entity) => entity.id)).toEqual(["todo_2"]);
    expect(() => executor.relationships({ as: "owner", type: "todo", targetId: "user_1" })).toThrow(
      /candidate-only/,
    );
    expect(() => executor.memberships({ groupId: "group_1" })).toThrow(/candidate-only/);
  });
});
