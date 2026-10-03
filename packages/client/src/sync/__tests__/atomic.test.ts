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
import { EntityValidationError } from "../../schema/entity-registry";
import { AtomicResolutionError, resolveReferences } from "../atomic";
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

/** Stub `fetch` recording request bodies and accepting handshakes / writes. */
const mkRecordingFetch = (seen: RecordedRequest[]): typeof fetch => {
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
      return new Response(JSON.stringify({ rejected: [] }), {
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
): {
  client: ReturnType<typeof createClient<S>>;
  seen: RecordedRequest[];
} => {
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    schema: schemaOverride,
    fetchImpl: mkRecordingFetch(seen),
  });
  return { client, seen };
};

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

describe("client.atomic — one Action, forward references", () => {
  /** Membership option every `create` in this block carries (#244). */
  const groups = { groups: ["g_1"] } as const;

  it("emits exactly one POST with an entity Update per create and a membership edge per group", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo, list }) => {
      const today = list.create({ name: "Today" }, groups);
      const item = todo.create({ title: "Ship it", list: today }, groups);
      return { todo: item, list: today };
    });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const actions = decodeActions(calls[0]!);
    expect(actions).toHaveLength(1);
    const updates = actions[0]!.updates;
    // 2 entity puts + 2 membership edges + 1 domain relationship put.
    expect(updates).toHaveLength(5);

    const todoUpdate = updates.find((u) => u.subject_type === "todo")!;
    const listUpdate = updates.find((u) => u.subject_type === "list")!;

    const domainRel = updates.find(
      (u) => u.subject_type === "relationship" && u.data?.fields?.["field"]?.value === "list",
    )!;
    const membershipRels = updates.filter(
      (u) => u.subject_type === "relationship" && u.data?.fields?.["field"]?.value === "groups",
    );
    expect(membershipRels).toHaveLength(2);

    expect(todoUpdate.method).toBe("put");
    expect(todoUpdate.subject_id).toBe(created.todo.id);
    expect(todoUpdate.data?.fields?.["title"]?.value).toBe("Ship it");
    // The relationship pointer is not an entity field on the wire.
    expect(todoUpdate.data?.fields?.["list"]).toBeUndefined();

    expect(listUpdate.subject_id).toBe(created.list.id);
    expect(listUpdate.data?.fields?.["name"]?.value).toBe("Today");

    expect(domainRel.method).toBe("put");
    expect(domainRel.data?.fields?.["source_id"]?.value).toBe(created.todo.id);
    expect(domainRel.data?.fields?.["target_id"]?.value).toBe(created.list.id);
    expect(domainRel.data?.fields?.["type"]?.value).toBe("todo");
    expect(domainRel.data?.fields?.["kind"]?.value).toBe("link");

    for (const rel of membershipRels) {
      expect(rel.method).toBe("put");
      expect(rel.data?.fields?.["target_id"]?.value).toBe("g_1");
      expect(rel.data?.fields?.["kind"]?.value).toBe("member");
    }
    const membershipTypes = membershipRels.map((r) => r.data?.fields?.["type"]?.value).sort();
    expect(membershipTypes).toEqual(["list", "todo"]);
  });

  it("emits one kind:member edge per group into the same Action", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo }) =>
      todo.create({ title: "Ship" }, { groups: ["g_1", "g_2"] }),
    );

    const actions = actionCalls(seen);
    expect(actions).toHaveLength(1);
    const membershipRels = decodeActions(actions[0]!)[0]!.updates.filter(
      (u) => u.subject_type === "relationship",
    );
    expect(membershipRels).toHaveLength(2);
    for (const rel of membershipRels) {
      expect(rel.data?.fields?.["source_id"]?.value).toBe(created.id);
      expect(rel.data?.fields?.["field"]?.value).toBe("groups");
      expect(rel.data?.fields?.["type"]?.value).toBe("todo");
      expect(rel.data?.fields?.["kind"]?.value).toBe("member");
    }
    expect(membershipRels.map((r) => r.data?.fields?.["target_id"]?.value).sort()).toEqual([
      "g_1",
      "g_2",
    ]);
  });

  it("rejects a missing groups option before any network call", async () => {
    const { client, seen } = mkClient();
    await client.handshake();
    const before = seen.length;

    await expect(
      client.atomic(({ todo }) => todo.create({ title: "Ship" }, undefined as never)),
    ).rejects.toBeInstanceOf(EntityValidationError);
    expect(seen.length).toBe(before);
  });

  it("returns handles with ids and materialized fields, substituting refs with generated ids", async () => {
    const { client } = mkClient();
    await client.handshake();

    const created = await client.atomic(({ todo, list }) => {
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
    // 3 entity puts + 3 membership edges + 2 domain relationship puts.
    expect(updates).toHaveLength(8);
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
      todo: todo.create({ title: "Existing list", list: "list_existing" }, groups),
    }));

    expect(created.todo.list).toBe("list_existing");
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    // 1 entity put + 1 membership edge + 1 domain relationship put.
    expect(updates).toHaveLength(3);
    const relUpdate = updates.find(
      (u) => u.subject_type === "relationship" && u.data?.fields?.["field"]?.value === "list",
    )!;
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
      const a = label.create({ name: "a" }, groups);
      const b = label.create({ name: "b" }, groups);
      return { todo: todo.create({ title: "Tagged", tags: [a, b] }, groups), a, b };
    });

    expect(created.todo.tags).toEqual([created.a.id, created.b.id]);
    const updates = decodeActions(actionCalls(seen)[0]!)[0]!.updates;
    // 3 entity puts + 3 membership edges + 2 domain relationship puts.
    expect(updates).toHaveLength(8);
    const todoUpdate = updates.find((u) => u.subject_type === "todo")!;
    expect(todoUpdate.data?.fields?.["tags"]?.value).toEqual([created.a.id, created.b.id]);
  });

  it("rejects an array for a one-cardinality pointer", async () => {
    const { client } = mkClient();
    await client.handshake();

    await expect(
      client.atomic(({ todo, list }) => {
        const a = list.create({ name: "a" }, groups);
        const b = list.create({ name: "b" }, groups);
        return { todo: todo.create({ title: "Ship", list: [a, b] }, groups) };
      }),
    ).rejects.toBeInstanceOf(AtomicResolutionError);
  });

  it("creates every write collected during the callback, even when not returned", async () => {
    const { client, seen } = mkClient();
    await client.handshake();

    await client.atomic(({ todo, list }) => {
      list.create({ name: "Orphan" }, groups);
      return { todo: todo.create({ title: "Returned" }, groups) };
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
        todo: todo.create({ title: "Ship", bogus: 1 } as never, groups),
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
