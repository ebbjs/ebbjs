/**
 * Unit tests for `client.atomic(...)` — the forward-reference resolver.
 *
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action and assert the wire shape (one entity `put` per
 * created entity plus one `Relationship` `put` per resolved pointer),
 * all inside exactly one `POST /sync/actions`.
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, type Action } from "@ebbjs/core";
import type { TSchema } from "@sinclair/typebox/type";

import { defineEntity, e } from "../../schema/entity";
import type { EntityDef } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import type { RelationshipDef } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import type { Schema } from "../../schema/schema";
import { defineAction, type ActionDef, type ActionWrite } from "../../schema/action";
import { EntityValidationError } from "../../schema/entity-registry";
import { AtomicActionError, AtomicResolutionError, resolveReferences } from "../atomic";
import type { Rejection } from "../types";
import { createClient } from "../client";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** Per-action rejections the stub server should return from `POST /sync/actions`. */
interface StubWriteOptions {
  readonly rejected?: readonly Rejection[];
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
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions: ["todo.*", "list.*"],
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
      return new Response(JSON.stringify({ rejected: opts.rejected ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
};

const list = defineEntity("list", { name: e.string() });
const todo = defineEntity("todo", { title: e.string() });

const schema = defineSchema({
  entities: { todo, list },
  relationships: {
    todo_list: defineRelationship({ source: todo, target: list, as: "list" }),
  },
  version: 1,
});

const mkClient = <S extends AnySchema>(
  schemaOverride: S = schema as unknown as S,
  writeOpts: StubWriteOptions = {},
): {
  client: ReturnType<typeof createClient<S>>;
  seen: RecordedRequest[];
} => {
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    schema: schemaOverride,
    fetchImpl: mkRecordingFetch(seen, writeOpts),
  });
  return { client, seen };
};

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

describe("client.atomic — one Action, forward references", () => {
  it("emits exactly one POST with an entity Update per create and a Relationship Update per pointer", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo, list }) => {
      const today = list.create({ name: "Today" });
      const item = todo.create({ title: "Ship it", list: today });
      return { todo: item, list: today };
    });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const actions = decodeActions(calls[0]!);
    expect(actions).toHaveLength(1);
    const updates = actions[0]!.updates;
    // 2 entity puts + 1 relationship put.
    expect(updates).toHaveLength(3);

    const todoUpdate = updates.find((u) => u.subject_type === "todo")!;
    const listUpdate = updates.find((u) => u.subject_type === "list")!;
    const relUpdate = updates.find((u) => u.subject_type === "relationship")!;

    expect(todoUpdate.method).toBe("put");
    expect(todoUpdate.subject_id).toBe(created.todo.id);
    expect(todoUpdate.data?.fields?.["title"]?.value).toBe("Ship it");
    // The relationship pointer is not an entity field on the wire.
    expect(todoUpdate.data?.fields?.["list"]).toBeUndefined();

    expect(listUpdate.subject_id).toBe(created.list.id);
    expect(listUpdate.data?.fields?.["name"]?.value).toBe("Today");

    expect(relUpdate.method).toBe("put");
    expect(relUpdate.data?.fields?.["source_id"]?.value).toBe(created.todo.id);
    expect(relUpdate.data?.fields?.["target_id"]?.value).toBe(created.list.id);
    expect(relUpdate.data?.fields?.["field"]?.value).toBe("list");
    expect(relUpdate.data?.fields?.["type"]?.value).toBe("todo");
    expect(relUpdate.data?.fields?.["kind"]?.value).toBe("link");
  });

  it('emits kind: "member" when a pointer targets the group entity', async () => {
    const memberTodo = defineEntity("todo", { title: e.string() });
    const group = defineEntity("group", { name: e.string() });
    const memberSchema = defineSchema({
      entities: { todo: memberTodo, group },
      relationships: {
        todo_ownedBy: defineRelationship({ source: memberTodo, target: group, as: "ownedBy" }),
      },
      version: 1,
    });
    const { client, seen } = mkClient(memberSchema);
    await client.handshake();

    const created = await client.atomic(({ todo }) => ({
      todo: todo.create({ title: "Ship it", ownedBy: "g_1" }),
    }));

    expect(created.todo.ownedBy).toBe("g_1");
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    const relUpdate = updates.find((u) => u.subject_type === "relationship")!;
    expect(relUpdate.data?.fields?.["source_id"]?.value).toBe(created.todo.id);
    expect(relUpdate.data?.fields?.["target_id"]?.value).toBe("g_1");
    expect(relUpdate.data?.fields?.["field"]?.value).toBe("ownedBy");
    expect(relUpdate.data?.fields?.["kind"]?.value).toBe("member");
  });

  it("returns handles with ids and materialized fields, substituting refs with generated ids", async () => {
    const { client } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo, list }) => {
      const today = list.create({ name: "Today" });
      return { todo: todo.create({ title: "Ship it", list: today }), list: today };
    });

    expect(created.list.id).toMatch(/^e_[a-z0-9]+$/);
    expect(created.todo.id).toMatch(/^e_[a-z0-9]+$/);
    expect(created.list.name).toBe("Today");
    expect(created.todo.title).toBe("Ship it");
    expect(created.todo.list).toBe(created.list.id);
    expect(created.todo.id).not.toBe(created.list.id);
  });

  it("resolves nested references at arbitrary depth", async () => {
    const a = defineEntity("a", { name: e.string() });
    const b = defineEntity("b", { label: e.string() });
    const c = defineEntity("c", { tag: e.string() });
    const deepSchema = defineSchema({
      entities: { a, b, c },
      relationships: {
        b_a: defineRelationship({ source: b, target: a, as: "a" }),
        c_b: defineRelationship({ source: c, target: b, as: "b" }),
      },
      version: 1,
    });
    const { client, seen } = mkClient(deepSchema);
    await client.handshake();

    const created = await client.atomic(({ a, b, c }) => {
      const aHandle = a.create({ name: "a" });
      const bHandle = b.create({ label: "b", a: aHandle });
      const cHandle = c.create({ tag: "c", b: bHandle });
      return { a: aHandle, b: bHandle, c: cHandle };
    });

    expect(created.b.a).toBe(created.a.id);
    expect(created.c.b).toBe(created.b.id);

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const updates = decodeActions(calls[0]!)[0]!.updates;
    // 3 entity puts + 2 relationship puts.
    expect(updates).toHaveLength(5);
    const relTargets = updates
      .filter((u) => u.subject_type === "relationship")
      .map((u) => u.data?.fields?.["target_id"]?.value);
    expect(relTargets).toContain(created.a.id);
    expect(relTargets).toContain(created.b.id);
  });

  it("accepts a pre-existing string id without creating a target", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo }) => ({
      todo: todo.create({ title: "Existing list", list: "list_existing" }),
    }));

    expect(created.todo.list).toBe("list_existing");
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    expect(updates).toHaveLength(2);
    const relUpdate = updates.find((u) => u.subject_type === "relationship")!;
    expect(relUpdate.data?.fields?.["target_id"]?.value).toBe("list_existing");
  });

  it("emits N Relationship Updates for a many-cardinality pointer and carries the FK set", async () => {
    const taggedTodo = defineEntity("todo", {
      title: e.string(),
      tags: Type.Array(Type.String()),
    });
    const label = defineEntity("label", { name: e.string() });
    const manySchema = defineSchema({
      entities: { todo: taggedTodo, label },
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

    const created = await client.atomic(({ todo, label }) => {
      const a = label.create({ name: "a" });
      const b = label.create({ name: "b" });
      return { todo: todo.create({ title: "Tagged", tags: [a, b] }), a, b };
    });

    expect(created.todo.tags).toEqual([created.a.id, created.b.id]);
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    // 3 entity puts + 2 relationship puts.
    expect(updates).toHaveLength(5);
    const todoUpdate = updates.find((u) => u.subject_type === "todo")!;
    expect(todoUpdate.data?.fields?.["tags"]?.value).toEqual([created.a.id, created.b.id]);
  });

  it("rejects an array for a one-cardinality pointer", async () => {
    const { client } = mkClient();
    await client.handshake();

    await expect(
      client.atomic(({ todo, list }) => {
        const a = list.create({ name: "a" });
        const b = list.create({ name: "b" });
        return { todo: todo.create({ title: "Ship", list: [a, b] }) };
      }),
    ).rejects.toBeInstanceOf(AtomicResolutionError);
  });

  it("creates every write collected during the callback, even when not returned", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    await client.atomic(({ todo, list }) => {
      list.create({ name: "Orphan" });
      return { todo: todo.create({ title: "Returned" }) };
    });

    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    const entityUpdates = updates.filter((u) => u.subject_type !== "relationship");
    expect(entityUpdates).toHaveLength(2);
  });

  it("rejects an undeclared field before any network call", async () => {
    const { client, seen } = mkClient();
    await client.handshake();
    const before = seen.length;

    await expect(
      client.atomic(({ todo }) => ({
        todo: todo.create({ title: "Ship", bogus: 1 } as never),
      })),
    ).rejects.toBeInstanceOf(EntityValidationError);

    expect(seen.length).toBe(before);
  });

  it("tags a `group` target as kind=member and every other target as kind=link", async () => {
    const group = defineEntity("group", { name: e.string() });
    const kindSchema = defineSchema({
      entities: { todo, group, list },
      relationships: {
        todo_ownedBy: defineRelationship({
          source: todo,
          target: group,
          as: "ownedBy",
          sourceCardinality: "many",
        }),
        todo_list: defineRelationship({
          source: todo,
          target: list,
          as: "list",
          sourceCardinality: "many",
        }),
      },
      version: 1,
    });
    const { client, seen } = mkClient(kindSchema);
    await client.handshake();

    const created = await client.atomic(({ todo, group, list }) => {
      const team = group.create({ name: "Team" });
      const today = list.create({ name: "Today" });
      return { todo: todo.create({ title: "Ship", ownedBy: team, list: today }), team, today };
    });

    const relUpdates = decodeActions(actionCalls(seen)[0]!)[0]!.updates.filter(
      (u) => u.subject_type === "relationship",
    );
    const memberUpdate = relUpdates.find((u) => u.data?.fields?.["field"]?.value === "ownedBy")!;
    expect(memberUpdate.data?.fields?.["kind"]?.value).toBe("member");
    expect(memberUpdate.data?.fields?.["target_id"]?.value).toBe(created.team.id);

    const linkUpdate = relUpdates.find((u) => u.data?.fields?.["field"]?.value === "list")!;
    expect(linkUpdate.data?.fields?.["kind"]?.value).toBe("link");
    expect(linkUpdate.data?.fields?.["target_id"]?.value).toBe(created.today.id);
  });
});

describe("client.atomic — ActionDef form", () => {
  const todoList = defineRelationship({ source: todo, target: list, as: "list" });

  const sharedAction = defineAction({
    writes: [todo, list, todoList],
    values: { todo: { title: "Ship it" }, list: { name: "Today" } },
  });

  /** Wire-shape projection that drops volatile ids (update ids, HLCs, minted entity/relationship ids). */
  const canonicalAction = (action: Action, handles: Record<string, { id: string }>): unknown => {
    const label = new Map(Object.entries(handles).map(([name, handle]) => [handle.id, name]));
    const relationshipLabels = new Map<string, string>();
    return action.updates.map((update) => {
      const subject =
        label.get(update.subject_id) ??
        relationshipLabels.get(update.subject_id) ??
        `relationship#${relationshipLabels.size}`;
      relationshipLabels.set(update.subject_id, subject);
      return {
        subject_type: update.subject_type,
        subject,
        method: update.method,
        fields:
          update.data === null
            ? null
            : Object.fromEntries(
                Object.entries(update.data.fields).map(([key, entry]) => [
                  key,
                  label.get(String(entry.value)) ?? entry.value,
                ]),
              ),
      };
    });
  };

  it("composes the same single Action as the equivalent callback", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const fromCallback = await client.atomic(({ todo, list }) => {
      const today = list.create({ name: "Today" });
      const item = todo.create({ title: "Ship it", list: today });
      return { todo: item, list: today };
    });
    const callbackAction = decodeActions(actionCalls(seen).at(-1)!)[0]!;

    const fromActionDef = await client.atomic(sharedAction);
    const defAction = decodeActions(actionCalls(seen).at(-1)!)[0]!;

    expect(canonicalAction(callbackAction, fromCallback)).toEqual(
      canonicalAction(defAction, fromActionDef),
    );
    expect(actionCalls(seen)).toHaveLength(2);
  });

  it("returns materialized handles keyed by entity name", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(sharedAction);

    expect(created.todo.id).toMatch(/^e_/);
    expect(created.list.id).toMatch(/^e_/);
    expect(created.todo.title).toBe("Ship it");
    expect(created.list.name).toBe("Today");
    expect(created.todo.list).toBe(created.list.id);
    expect(actionCalls(seen)).toHaveLength(1);
    expect(decodeActions(actionCalls(seen)[0]!)).toHaveLength(1);
  });

  it("auto-wires the declared relationship edge", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(sharedAction);

    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    const relUpdate = updates.find((u) => u.subject_type === "relationship")!;
    expect(relUpdate.data?.fields?.["source_id"]?.value).toBe(created.todo.id);
    expect(relUpdate.data?.fields?.["target_id"]?.value).toBe(created.list.id);
    expect(relUpdate.data?.fields?.["field"]?.value).toBe("list");
    expect(relUpdate.data?.fields?.["type"]?.value).toBe("todo");
    expect(relUpdate.data?.fields?.["kind"]?.value).toBe("link");
  });

  it("rejects a non-callback, non-ActionDef argument with a clear error", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    await expect(client.atomic(undefined as never)).rejects.toBeInstanceOf(AtomicResolutionError);
    await expect(client.atomic(undefined as never)).rejects.toThrow(
      /expected a callback or an ActionDef with a "writes" field/,
    );
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("rejects a relationship whose endpoint has no values entry", async () => {
    const { client } = mkClient();
    await client.handshake();

    const broken = {
      writes: [todo, list, todoList],
      values: { todo: { title: "Ship it" } },
    } as unknown as ActionDef<readonly ActionWrite[]>;

    await expect(client.atomic(broken)).rejects.toBeInstanceOf(AtomicResolutionError);
  });

  it("rejects a cyclic relationship declaration", async () => {
    const a = defineEntity("a", { name: e.string() });
    const b = defineEntity("b", { name: e.string() });
    const aToB = defineRelationship({ source: a, target: b, as: "b" });
    const bToA = defineRelationship({ source: b, target: a, as: "a" });
    const cyclicSchema = defineSchema({
      entities: { a, b },
      relationships: { aToB, bToA },
      version: 1,
    });
    const { client } = mkClient(cyclicSchema);
    await client.handshake();

    const cyclic = defineAction({
      writes: [a, b, aToB, bToA],
      values: { a: { name: "a" }, b: { name: "b" } },
    });

    await expect(client.atomic(cyclic)).rejects.toBeInstanceOf(AtomicResolutionError);
  });

  it("rejects an entity that is not registered on the schema", async () => {
    const { client } = mkClient();
    await client.handshake();

    const stray = defineEntity("stray", { name: e.string() });
    const strayRel = defineRelationship({ source: todo, target: stray, as: "stray" });
    const strayAction = defineAction({
      writes: [todo, stray, strayRel],
      values: { todo: { title: "x" }, stray: { name: "y" } },
    });

    await expect(client.atomic(strayAction)).rejects.toBeInstanceOf(AtomicResolutionError);
  });

  it("links a pre-existing target when values supplies an explicit pointer", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const action = defineAction({
      writes: [todo, todoList],
      values: { todo: { title: "Ship it", list: "list_existing" } },
    });

    const fromCallback = await client.atomic(({ todo }) => ({
      todo: todo.create({ title: "Ship it", list: "list_existing" }),
    }));
    const callbackAction = decodeActions(actionCalls(seen).at(-1)!)[0]!;

    const fromActionDef = await client.atomic(action);
    const defAction = decodeActions(actionCalls(seen).at(-1)!)[0]!;

    expect(canonicalAction(callbackAction, fromCallback)).toEqual(
      canonicalAction(defAction, fromActionDef),
    );
    expect(defAction.updates).toHaveLength(2);
    const relUpdate = defAction.updates.find((u) => u.subject_type === "relationship")!;
    expect(relUpdate.data?.fields?.["target_id"]?.value).toBe("list_existing");
  });

  it("auto-wires a many-cardinality edge and carries the FK set", async () => {
    const taggedTodo = defineEntity("todo", {
      title: e.string(),
      tags: Type.Array(Type.String()),
    });
    const label = defineEntity("label", { name: e.string() });
    const tagsRel = defineRelationship({
      source: taggedTodo,
      target: label,
      as: "tags",
      sourceCardinality: "many",
    });
    const manySchema = defineSchema({
      entities: { todo: taggedTodo, label },
      relationships: { tagsRel },
      version: 1,
    });
    const { client, seen } = mkClient(manySchema);
    await client.handshake();

    const created = await client.atomic(
      defineAction({
        writes: [taggedTodo, label, tagsRel],
        values: { todo: { title: "Tagged" }, label: { name: "a" } },
      }),
    );

    expect(created.todo.tags).toEqual([created.label.id]);
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    const todoUpdate = updates.find((u) => u.subject_type === "todo")!;
    expect(todoUpdate.data?.fields?.["tags"]?.value).toEqual([created.label.id]);
    expect(updates.filter((u) => u.subject_type === "relationship")).toHaveLength(1);
  });
});

describe("client.atomic — permission coherence (#233)", () => {
  const group = defineEntity("group", { name: e.string() });
  const coherentTodo = defineEntity("todo", { title: e.string() });
  const coherentList = defineEntity("list", { name: e.string() });
  // Membership is a `kind: "member"` edge to the `group` entity; the
  // check reads the group set off those edges, not off the accessor
  // name, so `memberOf` stands in for the injected `groups` edge #244
  // will add.
  const memberOf = defineRelationship({
    source: coherentTodo,
    target: group,
    as: "memberOf",
    sourceCardinality: "many",
  });
  const listMemberOf = defineRelationship({
    source: coherentList,
    target: group,
    as: "memberOf",
    sourceCardinality: "many",
  });
  const coherenceSchema = defineSchema({
    entities: { todo: coherentTodo, list: coherentList, group },
    relationships: { memberOf, listMemberOf },
    version: 1,
  });

  it("accepts an Action whose writes all carry the same group set", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();

    const created = await client.atomic(({ todo, list }) => {
      const today = list.create({ name: "Today", memberOf: ["g_1"] });
      return { todo: todo.create({ title: "Ship it", memberOf: ["g_1"] }), list: today };
    });

    expect(created.todo.memberOf).toEqual(["g_1"]);
    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const updates = decodeActions(calls[0]!)[0]!.updates;
    expect(updates.filter((u) => u.subject_type === "relationship")).toHaveLength(2);
    for (const rel of updates.filter((u) => u.subject_type === "relationship")) {
      expect(rel.data?.fields?.["kind"]?.value).toBe("member");
      expect(rel.data?.fields?.["target_id"]?.value).toBe("g_1");
    }
  });

  it("accepts an Action whose writes share a multi-group membership set", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();

    await client.atomic(({ todo, list }) => ({
      todo: todo.create({ title: "Ship it", memberOf: ["g_2", "g_1"] }),
      list: list.create({ name: "Today", memberOf: ["g_1", "g_2"] }),
    }));

    // Two member edges per write, in one Action.
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    expect(updates.filter((u) => u.subject_type === "relationship")).toHaveLength(4);
  });

  it("refuses a cross-group Action before any write is submitted", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();
    const requestsBefore = seen.length;

    const error = await client
      .atomic(({ todo, list }) => ({
        list: list.create({ name: "Today", memberOf: ["g_1"] }),
        todo: todo.create({ title: "Ship it", memberOf: ["g_2"] }),
      }))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AtomicActionError);
    expect(actionCalls(seen)).toHaveLength(0);
    expect(seen.length).toBe(requestsBefore);
  });

  it("counts membership edges in the check and names every subject whose set differs", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();

    let handles: Record<string, { id: string }> = {};
    const error = (await client
      .atomic(({ todo, list }) => {
        handles = {
          todo: todo.create({ title: "Ship it", memberOf: ["g_1"] }),
          list: list.create({ name: "Today", memberOf: ["g_2"] }),
        };
        return handles;
      })
      .catch((err: unknown) => err)) as AtomicActionError;

    expect(actionCalls(seen)).toHaveLength(0);
    expect(error.rejections).toHaveLength(2);
    expect(error.rejections.map((r) => r.id).sort()).toEqual(
      [handles.todo!.id, handles.list!.id].sort(),
    );
    expect(error.rejections.map((r) => r.subjectType)).toEqual(["todo", "list"]);
    for (const rejection of error.rejections) {
      expect(rejection.reason).toBe("group_mismatch");
      expect(rejection.details).toContain("g_1");
      expect(rejection.details).toContain("g_2");
    }
    expect(error.message).toContain(handles.todo!.id);
    expect(error.message).toContain(handles.list!.id);
    expect(error.message.split("\n")).toHaveLength(3);
  });

  it("names a write whose membership is a strict subset of the Action's group set", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();

    let handles: Record<string, { id: string }> = {};
    const error = (await client
      .atomic(({ todo, list }) => {
        handles = {
          todo: todo.create({ title: "Ship it", memberOf: ["g_1", "g_2"] }),
          list: list.create({ name: "Today", memberOf: ["g_1"] }),
        };
        return handles;
      })
      .catch((err: unknown) => err)) as AtomicActionError;

    expect(actionCalls(seen)).toHaveLength(0);
    expect(error.rejections).toHaveLength(1);
    expect(error.rejections[0]).toMatchObject({
      id: handles.list!.id,
      subjectType: "list",
      reason: "group_mismatch",
    });
  });

  it("refuses a cross-group ActionDef on the shared resolver path", async () => {
    const { client, seen } = mkClient(coherenceSchema);
    await client.handshake();

    const crossGroup = defineAction({
      writes: [coherentTodo, coherentList, memberOf, listMemberOf],
      values: {
        todo: { title: "Ship it", memberOf: ["g_2"] },
        list: { name: "Today", memberOf: ["g_1"] },
      },
    });

    await expect(client.atomic(crossGroup)).rejects.toBeInstanceOf(AtomicActionError);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("raises AtomicActionError populated from the server's rejected[]", async () => {
    const rejection: Rejection = {
      id: "act_1",
      reason: "not_authorized",
      details: "actor lacks todo.put in group g_1",
    };
    const { client, seen } = mkClient(coherenceSchema, { rejected: [rejection] });
    await client.handshake();

    const error = (await client
      .atomic(({ todo }) => ({ todo: todo.create({ title: "Ship it", memberOf: ["g_1"] }) }))
      .catch((err: unknown) => err)) as AtomicActionError;

    expect(actionCalls(seen)).toHaveLength(1);
    expect(error).toBeInstanceOf(AtomicActionError);
    expect(error.rejections).toEqual([rejection]);
    expect(error.message).toContain("not_authorized");
    expect(error.message).toContain("actor lacks todo.put in group g_1");
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
    expect(() => resolveReferences(cyclic)).toThrow(AtomicResolutionError);
  });

  it("rejects a cycle reached through an array", () => {
    const cyclic: Record<string, unknown> = { items: [] };
    (cyclic["items"] as unknown[]).push({ back: cyclic });
    expect(() => resolveReferences(cyclic)).toThrow(AtomicResolutionError);
  });

  it("rejects a self-referential array", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => resolveReferences(cyclic)).toThrow(AtomicResolutionError);
  });

  it("allows a shared (non-cyclic) reference", () => {
    const shared = { value: 1 };
    expect(resolveReferences({ a: shared, b: shared })).toEqual({
      a: { value: 1 },
      b: { value: 1 },
    });
  });
});
