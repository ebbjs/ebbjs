/**
 * Unit tests for the draft planner's forward-reference resolver: an
 * Action callback's drafts mint ids synchronously, so a later draft can
 * point at an entity created earlier in the same callback.
 *
 * Every test drives a mounted `run` action, so the callback, the ordered
 * resolver, the committer, and the wire shape are exercised as one path.
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action and assert its Updates (one entity `put` per created
 * entity plus one `Relationship` `put` per resolved pointer), all inside
 * exactly one `POST /sync/actions`.
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, type Action, type Update } from "@ebbjs/core";
import type { TSchema } from "@sinclair/typebox/type";

import { defineModel, e } from "@ebbjs/schema";
import type { ModelDef } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import type { RelationshipDef } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import type { Schema } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import { entityGroupId } from "@ebbjs/write";
import { ActionRejectedError, ActionResolutionError, resolveReferences } from "../drafts";
import type { Rejection } from "../types";
import { createClient } from "../client";
import { testActions } from "./test-actions";
import { updateModel } from "../test-utils";

/** The Updates of one model, grouped into one list per subject row. */
const rowsOf = (updates: readonly Update[], model: string): readonly (readonly Update[])[] => {
  const bySubject = new Map<string, Update[]>();
  for (const update of updates) {
    if (updateModel(update) !== model) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/** A component's value on a row, or `undefined` when absent or dropped. */
const valueOf = (row: readonly Update[], field: string): unknown => {
  const update = row.find(
    (candidate) =>
      candidate.method !== "drop" &&
      candidate.method !== "delete" &&
      candidate.component.endsWith(`/${field}`),
  );
  if (update === undefined || update.method === "drop" || update.method === "delete") {
    return undefined;
  }
  return update.data.value;
};

type AnyModelDef = ModelDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;
type AnySchema = Schema<
  Record<string, AnyModelDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/**
 * Rejections the stub server returns from `POST /sync/actions`. Receives
 * the decoded Actions so a test can attribute a rejection to the Action
 * it submitted — or deliberately to a different one.
 */
interface StubWriteOptions {
  readonly rejectFor?: (actions: readonly Action[]) => readonly Rejection[];
}

/** Stub `fetch` recording request bodies and accepting handshakes / writes. */
const mkRecordingFetch = (seen: RecordedRequest[], opts: StubWriteOptions = {}): typeof fetch => {
  return (async (url: string, init: RequestInit): Promise<Response> => {
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : undefined;
    seen.push({ url, body });
    if (url.endsWith("/sync/handshake")) {
      const permissions = ["todo.*", "list.*", "label.*", "a.*", "b.*", "c.*"];
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions,
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
            {
              id: "g_2",
              permissions,
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/sync/actions")) {
      const actions = body === undefined ? [] : decodeSync<{ actions: Action[] }>(body).actions;
      return new Response(JSON.stringify({ rejected: opts.rejectFor?.(actions) ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
};

const list = defineModel("list", { name: e.string() });
const todo = defineModel("todo", { title: e.string() });

const schema = defineSchema({
  models: { todo, list },
  relationships: {
    todo_list: defineRelationship({ source: todo, target: list, as: "list" }),
  },
  version: 1,
});

const mkClient = <S extends AnySchema>(
  schemaOverride: S = schema as unknown as S,
  writeOpts: StubWriteOptions = {},
) => {
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    schema: schemaOverride,
    actions: testActions(schemaOverride),
    fetchImpl: mkRecordingFetch(seen, writeOpts),
  });
  return { client, seen };
};

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

describe("drafts — one Action, forward references", () => {
  /** Membership option every `create` in this block carries (#244). */
  const groups = { groups: ["g_1"] } as const;

  it("emits exactly one POST with an entity Update per create and an entityGroup row per group", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.actions.run(({ todo, list }) => {
      const today = list.create({ name: "Today" }, groups);
      const item = todo.create({ title: "Ship it", list: today }, groups);
      return { todo: item, list: today };
    });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const actions = decodeActions(calls[0]!);
    expect(actions).toHaveLength(1);
    const updates = actions[0]!.updates;
    // 2 entity rows + 2 membership rows + 1 domain relationship row.
    expect(rowsOf(updates, "todo")).toHaveLength(1);
    expect(rowsOf(updates, "list")).toHaveLength(1);
    expect(rowsOf(updates, "entityGroup")).toHaveLength(2);
    expect(rowsOf(updates, "relationship")).toHaveLength(1);

    const [todoRow] = rowsOf(updates, "todo");
    const [listRow] = rowsOf(updates, "list");
    const [domainRel] = rowsOf(updates, "relationship");
    const membershipRows = rowsOf(updates, "entityGroup");

    for (const update of todoRow!) expect(update.method).toBe("replace");
    expect(todoRow![0]!.subject_id).toBe(created.todo.id);
    expect(valueOf(todoRow!, "title")).toBe("Ship it");
    // The relationship pointer is not an entity component on the wire.
    expect(valueOf(todoRow!, "list")).toBeUndefined();

    expect(listRow![0]!.subject_id).toBe(created.list.id);
    expect(valueOf(listRow!, "name")).toBe("Today");

    expect(valueOf(domainRel!, "source_id")).toBe(created.todo.id);
    expect(valueOf(domainRel!, "target_id")).toBe(created.list.id);
    expect(valueOf(domainRel!, "type")).toBe("todo");

    for (const row of membershipRows) expect(valueOf(row, "group_id")).toBe("g_1");
    expect(membershipRows.map((row) => valueOf(row, "entity_id")).sort()).toEqual(
      [created.list.id, created.todo.id].sort(),
    );
  });

  it("emits one entityGroup row per distinct group into the same Action", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.actions.run(({ todo }) =>
      // A handle shape and a bare id naming one group collapse to one row.
      todo.create({ title: "Ship" }, { groups: ["g_1", { id: "g_1" }, { id: "g_2" }] }),
    );

    const actions = actionCalls(seen);
    expect(actions).toHaveLength(1);
    const membershipRows = rowsOf(decodeActions(actions[0]!)[0]!.updates, "entityGroup");
    expect(membershipRows).toHaveLength(2);
    // Each membership row is two Updates; a repeated id filing the group twice
    // would add a third pair under the same subject.
    expect(membershipRows.flat()).toHaveLength(4);
    for (const row of membershipRows) {
      expect(valueOf(row, "entity_id")).toBe(created.id);
    }
    expect(membershipRows.map((row) => valueOf(row, "group_id")).sort()).toEqual(["g_1", "g_2"]);
  });

  it("rejects a missing, empty, or malformed groups option before any network call", async () => {
    const { client, seen } = mkClient();
    await client.handshake();
    const before = seen.length;

    for (const opts of [undefined, { groups: [] }, { groups: [42] }] as const) {
      await expect(
        client.actions.run(({ todo }) => todo.create({ title: "Ship" }, opts as never)),
      ).rejects.toBeInstanceOf(EntityValidationError);
    }
    expect(seen.length).toBe(before);
  });

  it("returns handles with ids and materialized fields, substituting refs with generated ids", async () => {
    const { client } = mkClient();
    await client.handshake();

    const created = await client.actions.run(({ todo, list }) => {
      const today = list.create({ name: "Today" }, groups);
      return { todo: todo.create({ title: "Ship it", list: today }, groups), list: today };
    });

    expect(created.list.id).toMatch(/^e_[a-z0-9]+$/);
    expect(created.todo.id).toMatch(/^e_[a-z0-9]+$/);
    expect(created.list.name).toBe("Today");
    expect(created.todo.title).toBe("Ship it");
    expect(created.todo.list).toBe(created.list.id);
    expect(created.todo.id).not.toBe(created.list.id);
  });

  it("resolves nested references at arbitrary depth", async () => {
    const a = defineModel("a", { name: e.string() });
    const b = defineModel("b", { label: e.string() });
    const c = defineModel("c", { tag: e.string() });
    const deepSchema = defineSchema({
      models: { a, b, c },
      relationships: {
        b_a: defineRelationship({ source: b, target: a, as: "a" }),
        c_b: defineRelationship({ source: c, target: b, as: "b" }),
      },
      version: 1,
    });
    const { client, seen } = mkClient(deepSchema);
    await client.handshake();

    const created = await client.actions.run(({ a, b, c }) => {
      const aHandle = a.create({ name: "a" }, groups);
      const bHandle = b.create({ label: "b", a: aHandle }, groups);
      const cHandle = c.create({ tag: "c", b: bHandle }, groups);
      return { a: aHandle, b: bHandle, c: cHandle };
    });

    expect(created.b.a).toBe(created.a.id);
    expect(created.c.b).toBe(created.b.id);

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const updates = decodeActions(calls[0]!)[0]!.updates;
    // 3 entity rows + 3 membership rows + 2 domain relationship rows.
    expect(rowsOf(updates, "entityGroup")).toHaveLength(3);
    const relTargets = rowsOf(updates, "relationship").map((row) => valueOf(row, "target_id"));
    expect(relTargets).toContain(created.a.id);
    expect(relTargets).toContain(created.b.id);
  });

  it("accepts a pre-existing string id without creating a target", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.actions.run(({ todo }) => ({
      todo: todo.create({ title: "Existing list", list: "list_existing" }, groups),
    }));

    expect(created.todo.list).toBe("list_existing");
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    // 1 entity row + 1 membership row + 1 domain relationship row.
    expect(rowsOf(updates, "entityGroup")).toHaveLength(1);
    expect(rowsOf(updates, "todo")).toHaveLength(1);
    const [relRow] = rowsOf(updates, "relationship");
    expect(valueOf(relRow!, "field")).toBe("list");
    expect(valueOf(relRow!, "target_id")).toBe("list_existing");
  });

  it("emits N Relationship Updates for a many-cardinality pointer and carries the FK set", async () => {
    const taggedTodo = defineModel("todo", {
      title: e.string(),
      tags: Type.Array(Type.String()),
    });
    const label = defineModel("label", { name: e.string() });
    const manySchema = defineSchema({
      models: { todo: taggedTodo, label },
      relationships: {
        todo_tags: defineRelationship({
          source: taggedTodo,
          target: label,
          as: "tags",
          sourceCardinality: "many",
        }),
      },
      version: 1,
    });
    const { client, seen } = mkClient(manySchema);
    await client.handshake();

    const created = await client.actions.run(({ todo, label }) => {
      const a = label.create({ name: "a" }, groups);
      const b = label.create({ name: "b" }, groups);
      return { todo: todo.create({ title: "Tagged", tags: [a, b] }, groups), a, b };
    });

    expect(created.todo.tags).toEqual([created.a.id, created.b.id]);
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    // 3 entity rows + 3 membership rows + 2 domain relationship rows.
    expect(rowsOf(updates, "entityGroup")).toHaveLength(3);
    const [todoRow] = rowsOf(updates, "todo");
    expect(valueOf(todoRow!, "tags")).toEqual([created.a.id, created.b.id]);
  });

  it("rejects an array for a one-cardinality pointer", async () => {
    const { client } = mkClient();
    await client.handshake();

    await expect(
      client.actions.run(({ todo, list }) => {
        const a = list.create({ name: "a" }, groups);
        const b = list.create({ name: "b" }, groups);
        return { todo: todo.create({ title: "Ship", list: [a, b] }, groups) };
      }),
    ).rejects.toBeInstanceOf(ActionResolutionError);
  });

  it("creates every write collected during the callback, even when not returned", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    await client.actions.run(({ todo, list }) => {
      list.create({ name: "Orphan" }, groups);
      return { todo: todo.create({ title: "Returned" }, groups) };
    });

    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    const entityRows = rowsOf(updates, "todo").concat(rowsOf(updates, "list"));
    expect(entityRows).toHaveLength(2);
  });

  it("rejects an undeclared field before any network call", async () => {
    const { client, seen } = mkClient();
    await client.handshake();
    const before = seen.length;

    await expect(
      client.actions.run(({ todo }) => ({
        todo: todo.create({ title: "Ship", bogus: 1 } as never, groups),
      })),
    ).rejects.toBeInstanceOf(EntityValidationError);

    expect(seen.length).toBe(before);
  });
});

describe("drafts — per-Update delivery (#473)", () => {
  // Group sets come from the required per-create `groups` option (#244),
  // which also emits the `entityGroup` rows.
  const deliveryTodo = defineModel("todo", { title: e.string() });
  const deliveryList = defineModel("list", { name: e.string() });
  const deliverySchema = defineSchema({
    models: { todo: deliveryTodo, list: deliveryList },
    version: 1,
  });

  it("submits a narrow write alongside a wider write in the same Action", async () => {
    const { client, seen } = mkClient(deliverySchema);
    await client.handshake();

    let handles: Record<string, { id: string }> = {};
    await client.actions.run(({ todo, list }) => {
      handles = {
        todo: todo.create({ title: "Ship it" }, { groups: ["g_1", "g_2"] }),
        list: list.create({ name: "Today" }, { groups: ["g_1"] }),
      };
      return handles;
    });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const membershipRows = rowsOf(decodeActions(calls[0]!)[0]!.updates, "entityGroup");
    const rowsFor = (entityId: string) =>
      membershipRows
        .filter((row) => valueOf(row, "entity_id") === entityId)
        .map((row) => valueOf(row, "group_id"))
        .sort();
    // The wide write carries both groups; the narrow write only g_1.
    expect(rowsFor(handles.todo!.id)).toEqual(["g_1", "g_2"]);
    expect(rowsFor(handles.list!.id)).toEqual(["g_1"]);
  });

  it("raises ActionRejectedError populated from the server's rejected[] for the submitted Action", async () => {
    const { client, seen } = mkClient(deliverySchema, {
      rejectFor: (actions) => [
        {
          id: actions[0]!.id,
          reason: "not_authorized",
          details: "actor lacks todo.put in group g_1",
        },
      ],
    });
    await client.handshake();

    const error = (await client.actions
      .run(({ todo }) => ({
        todo: todo.create({ title: "Ship it" }, { groups: ["g_1"] }),
      }))
      .catch((err: unknown) => err)) as ActionRejectedError;

    expect(actionCalls(seen)).toHaveLength(1);
    const submitted = decodeActions(actionCalls(seen)[0]!)[0]!;
    expect(error).toBeInstanceOf(ActionRejectedError);
    expect(error.rejections).toEqual([
      {
        id: submitted.id,
        reason: "not_authorized",
        details: "actor lacks todo.put in group g_1",
      },
    ]);
    expect(error.message).toContain("not_authorized");
    expect(error.message).toContain("actor lacks todo.put in group g_1");
  });

  it("resolves when the server rejects a different queued Action, not the submitted one", async () => {
    const { client, seen } = mkClient(deliverySchema, {
      rejectFor: () => [{ id: "act_someone_else", reason: "not_authorized" }],
    });
    await client.handshake();

    const created = await client.actions.run(({ todo }) => ({
      todo: todo.create({ title: "Ship it" }, { groups: ["g_1"] }),
    }));

    expect(actionCalls(seen)).toHaveLength(1);
    expect(created.todo.id).toMatch(/^e_/);
  });

  it("raises only for a rejection attributed to the submitted Action", async () => {
    const { client, seen } = mkClient(deliverySchema, {
      rejectFor: (actions) => [
        { id: "act_someone_else", reason: "not_authorized" },
        { id: actions[0]!.id, reason: "permission_denied" },
      ],
    });
    await client.handshake();

    const error = (await client.actions
      .run(({ todo }) => ({
        todo: todo.create({ title: "Ship it" }, { groups: ["g_1"] }),
      }))
      .catch((err: unknown) => err)) as ActionRejectedError;

    const submitted = decodeActions(actionCalls(seen)[0]!)[0]!;
    expect(error.rejections).toEqual([{ id: submitted.id, reason: "permission_denied" }]);
  });
});

describe("drafts — setGroups delta", () => {
  it("deletes only the membership rows the new set drops", async () => {
    const { client, seen } = mkClient();
    await client.handshake();
    const created = await client.actions.create({
      entity: "todo",
      input: { title: "Ship" },
      groups: ["g_1", "g_2"],
    });
    const before = actionCalls(seen).length;

    await client.actions.setGroups({ entity: "todo", id: created.id, groups: ["g_2"] });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(before + 1);
    const updates = decodeActions(calls.at(-1)!)[0]!.updates;
    // g_2 survives the swap, so only g_1's row may be deleted.
    expect(
      updates.filter((update) => update.method === "delete").map((update) => update.subject_id),
    ).toEqual([entityGroupId(created.id, "g_1")]);
    expect(rowsOf(updates, "entityGroup")).toEqual([]);
  });
});

describe("resolveReferences", () => {
  it("walks arrays and nested objects, preserving structure", () => {
    const input = { a: [{ b: 1 }, 2], c: { d: "e" } };
    expect(resolveReferences(input)).toEqual(input);
  });

  it("rejects a self-referential object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => resolveReferences(cyclic)).toThrow(ActionResolutionError);
  });

  it("rejects a cycle reached through an array", () => {
    const cyclic: Record<string, unknown> = { items: [] };
    (cyclic["items"] as unknown[]).push({ back: cyclic });
    expect(() => resolveReferences(cyclic)).toThrow(ActionResolutionError);
  });

  it("allows a shared (non-cyclic) reference", () => {
    const shared = { value: 1 };
    expect(resolveReferences({ a: shared, b: shared })).toEqual({
      a: { value: 1 },
      b: { value: 1 },
    });
  });
});
