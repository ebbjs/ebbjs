/**
 * `unset` writes absence: the draft surface carries the marker, the
 * planner compiles it to a tombstone, and validation refuses `null` as
 * the instruction. The schema has no default and admits no `Null`, so the
 * only way to clear a field is the marker.
 */

import { describe, expect, it } from "vitest";
import { unset } from "@ebbjs/core";
import { defineModel, defineSchema, e } from "@ebbjs/schema";

import { defineAction } from "../../schema/action";
import { createClient } from "../client";
import type { EntityFields, EntityPatch } from "../namespace";

const task = defineModel("task", {
  title: e.string(),
  dueDate: e.string().default(""),
  tags: e.map(e.string()).default({}),
});

const schema = defineSchema({ models: { task }, version: 1 });

const updateTask = defineAction(
  schema,
  (
    { task: tasks },
    params: { id: string; patch: EntityPatch<EntityFields<typeof task>> },
  ): void => {
    tasks.update(params.id, params.patch);
  },
);

const createTask = defineAction(
  schema,
  (
    { task: tasks },
    params: { input: Record<string, unknown>; groups: readonly string[] },
  ): { readonly id: string } => tasks.create(params.input as never, { groups: params.groups }),
);

/** Handshake + actions stub: accepts everything, records nothing. */
const okFetch = (async (url: string): Promise<Response> => {
  if (url.endsWith("/sync/handshake")) {
    return new Response(
      JSON.stringify({
        actor_id: "actor_1",
        groups: [
          { id: "g_1", permissions: ["task.*"], cursor_valid: true, reason: null, cursor: 0 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ rejected: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

const mkClient = async () => {
  const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
  const storage = createMemoryAdapter();
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema,
    actions: { updateTask, createTask },
    fetchImpl: okFetch,
  });
  await client.handshake();
  return { client, storage };
};

describe("unset — draft update", () => {
  it("the patch type accepts the marker per field and per map key", () => {
    // Compile-time proof only: both spellings must typecheck against the
    // entity's field map, which is what a caller writing an unset sees.
    const typecheck: () => EntityPatch<EntityFields<typeof task>> = () => ({
      title: unset,
      dueDate: unset,
      tags: { a: unset, b: "kept" },
    });
    expect(typecheck).toBeTypeOf("function");
  });

  it("clears a scalar field to a tombstone", async () => {
    const { client } = await mkClient();
    const { id } = await client.actions.createTask({
      input: { title: "Ship", dueDate: "soon" },
      groups: ["g_1"],
    });

    await client.actions.updateTask({ id, patch: { dueDate: unset } });

    const row = await client.readLocalEntity(id);
    expect(row?.data?.fields.dueDate).toMatchObject({ value: null });
    // The other fields are untouched.
    expect(row?.data?.fields.title).toMatchObject({ value: "Ship" });
  });

  it("clears one map key without touching its siblings", async () => {
    const { client } = await mkClient();
    const { id } = await client.actions.createTask({
      input: { title: "Ship", tags: { a: "x", b: "y" } },
      groups: ["g_1"],
    });

    await client.actions.updateTask({ id, patch: { tags: { a: unset } } });

    const tags = (await client.readLocalEntity(id))?.data?.fields.tags as {
      map: Record<string, { value: unknown }>;
    };
    expect(tags.map.a?.value).toBeNull();
    expect(tags.map.b?.value).toBe("y");
  });

  it("rejects a literal null patch with a message naming unset", async () => {
    const { client } = await mkClient();
    await expect(
      client.actions.updateTask({ id: "t1", patch: { dueDate: null } as never }),
    ).rejects.toMatchObject({ violations: [{ message: expect.stringContaining("unset") }] });
  });
});
