/**
 * Tests for `client.<entity>.duplicate(id, opts)` — the user-facing
 * backup operation (#397). A duplicate is a new row of the same type
 * carrying the source's field values verbatim, written through the
 * normal entity path as one `put` plus the caller's membership rows.
 */

import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, makeHlc, type Action, type Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { EntityValidationError } from "../../schema/entity-registry";
import { createClient } from "../client";
import { jsonResponse, openSseResponse } from "../test-utils";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const runSchema = Type.Object({ text: Type.String() });
const doc = defineEntity("doc", {
  content: e.map(runSchema),
});

const duplicateSchema = defineSchema({ entities: { todo, doc }, version: 1 });

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

const mkFetch = (seen: RecordedRequest[]): typeof fetch =>
  (async (url: string, init: RequestInit): Promise<Response> => {
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
              permissions: ["todo.*", "doc.*"],
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
            {
              id: "g_2",
              permissions: ["todo.*", "doc.*"],
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

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        { value: v, update_id: "u_src", hlc: makeHlc(5) },
      ]),
    ),
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
});

const mkMembership = (id: string, entityId: string, groupId: string): Entity =>
  mkEntity(id, "entityGroup", { entity_id: entityId, group_id: groupId });

const storageOf = () => createMemoryAdapter();

const mkClient = async (): Promise<{
  client: ReturnType<typeof createClient<typeof duplicateSchema>>;
  storage: ReturnType<typeof storageOf>;
  seen: RecordedRequest[];
}> => {
  const storage = storageOf();
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema: duplicateSchema,
    fetchImpl: mkFetch(seen),
  });
  await client.handshake();
  return { client, storage, seen };
};

/** Seed a `todo` row plus its `entityGroup` memberships. */
const seedTodo = async (
  storage: ReturnType<typeof storageOf>,
  id: string,
  fields: Record<string, unknown>,
  groups: readonly string[] = ["g_1"],
): Promise<void> => {
  await storage.entities.set(mkEntity(id, "todo", fields));
  for (const [index, groupId] of groups.entries()) {
    await storage.entities.set(mkMembership(`eg_${id}_${index}`, id, groupId));
  }
};

const actionRequests = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeFirstAction = (request: RecordedRequest): Action =>
  decodeSync<{ actions: Action[] }>(request.body!).actions[0]!;

describe("client.<entity>.duplicate — field copy", () => {
  it("creates a new row with the same field values and leaves the original untouched", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "Ship", completed: false });

    const { id } = await client.todo.duplicate("t_1");

    expect(id).not.toBe("t_1");
    const put = decodeFirstAction(actionRequests(seen)[0]!).updates.find(
      (u) => u.subject_type === "todo",
    )!;
    expect(put.method).toBe("put");
    expect(put.subject_id).toBe(id);
    expect(put.data?.fields?.["title"]?.value).toBe("Ship");
    expect(put.data?.fields?.["completed"]?.value).toBe(false);

    // Local materialization: the backup is readable immediately.
    const copy = await storage.entities.get(id);
    expect(copy?.data?.fields?.["title"]?.value).toBe("Ship");
    // The source row is untouched.
    expect((await storage.entities.get("t_1"))?.data?.fields?.["title"]?.value).toBe("Ship");
  });

  it("preserves nested map values verbatim — run ids and field HLCs included", async () => {
    const { client, storage, seen } = await mkClient();
    const runField = {
      value: { text: "hello" },
      update_id: "u_run",
      hlc: makeHlc(9),
    };
    await storage.entities.set({
      ...mkEntity("doc_1", "doc", {}),
      data: { fields: { content: { map: { run_1: runField } } } },
    });
    await storage.entities.set(mkMembership("eg_1", "doc_1", "g_1"));

    const { id } = await client.doc.duplicate("doc_1");

    const put = decodeFirstAction(actionRequests(seen)[0]!).updates.find(
      (u) => u.subject_type === "doc",
    )!;
    const content = put.data?.fields?.["content"];
    expect(content && "map" in content ? content.map : undefined).toEqual({ run_1: runField });

    // The copy is an independent object graph, not an alias of the source.
    const copied = await storage.entities.get(id);
    const copiedContent = copied?.data?.fields?.["content"];
    const copiedRun =
      copiedContent && "map" in copiedContent ? copiedContent.map["run_1"] : undefined;
    expect(copiedRun).toEqual(runField);
    expect(copiedRun).not.toBe(runField);
    expect(copiedRun && "value" in copiedRun ? copiedRun.value : undefined).not.toBe(
      runField.value,
    );
  });

  it("copies a soft-deleted source row — the copy is live", async () => {
    const { client, storage } = await mkClient();
    await seedTodo(storage, "t_1", { title: "gone", completed: false });
    await storage.entities.set({
      ...(await storage.entities.get("t_1"))!,
      deleted_hlc: makeHlc(7),
    });

    const { id } = await client.todo.duplicate("t_1");

    const copy = await storage.entities.get(id);
    expect(copy?.data?.fields?.["title"]?.value).toBe("gone");
    expect(copy?.deleted_hlc).toBeNull();
  });

  it("throws when the source id names another entity type", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("d_1", "doc", {}));
    await expect(client.todo.duplicate("d_1")).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("throws for an unknown id before any network call", async () => {
    const { client, seen } = await mkClient();
    await expect(client.todo.duplicate("missing")).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("validates the copied row like create and refuses a non-conforming source", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: 42, completed: false }));
    await expect(client.todo.duplicate("t_1")).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("refuses an undeclared field on the source", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: "T", completed: false, bogus: 1 }));
    await expect(client.todo.duplicate("t_1")).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("duplicate({ validate: false }) skips validation and submits", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: 42, completed: false });
    await client.todo.duplicate("t_1", { validate: false });
    expect(actionRequests(seen)).toHaveLength(1);
  });
});

describe("client.<entity>.duplicate — memberships", () => {
  it("defaults to the source's live groups", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "T", completed: false }, ["g_1", "g_2"]);

    const { id } = await client.todo.duplicate("t_1");

    const memberships = decodeFirstAction(actionRequests(seen)[0]!).updates.filter(
      (u) => u.subject_type === "entityGroup",
    );
    expect(memberships).toHaveLength(2);
    for (const membership of memberships) {
      expect(membership.data?.fields?.["entity_id"]?.value).toBe(id);
    }
    expect(memberships.map((m) => m.data?.fields?.["group_id"]?.value).sort()).toEqual([
      "g_1",
      "g_2",
    ]);
  });

  it("honors an explicit groups option over the source's", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "T", completed: false });

    await client.todo.duplicate("t_1", { groups: ["g_2"] });

    const memberships = decodeFirstAction(actionRequests(seen)[0]!).updates.filter(
      (u) => u.subject_type === "entityGroup",
    );
    expect(memberships.map((m) => m.data?.fields?.["group_id"]?.value)).toEqual(["g_2"]);
  });

  it("refuses an empty groups option before any network call", async () => {
    const { client, seen } = await mkClient();
    await expect(client.todo.duplicate("t_1", { groups: [] })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("throws when the source has no live groups and none are given", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: "T", completed: false }));
    await expect(client.todo.duplicate("t_1")).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });
});

describe("client.<entity>.duplicate — at: preSync", () => {
  it("copies the captured pre-sync row instead of the live row", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "merged", completed: false });

    const preSync = mkEntity("t_1", "todo", { title: "mine", completed: true });
    vi.spyOn(client.snapshots, "get").mockResolvedValue(preSync);

    const { id } = await client.todo.duplicate("t_1", { at: "preSync" });

    const put = decodeFirstAction(actionRequests(seen)[0]!).updates.find(
      (u) => u.subject_type === "todo",
    )!;
    expect(put.data?.fields?.["title"]?.value).toBe("mine");
    expect(put.data?.fields?.["completed"]?.value).toBe(true);
    expect((await storage.entities.get(id))?.data?.fields?.["title"]?.value).toBe("mine");
  });

  it("throws when no pre-sync capture exists", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "merged", completed: false });
    await expect(client.todo.duplicate("t_1", { at: "preSync" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("returns the new id, typed as a create-like result", async () => {
    const { client, storage } = await mkClient();
    await seedTodo(storage, "t_1", { title: "T", completed: false });
    const typecheck: () => Promise<void> = async () => {
      const result: { readonly id: string; readonly rejected: readonly unknown[] } =
        await client.todo.duplicate("t_1");
      void result.id;
    };
    await typecheck();
  });
});

describe("duplicate({ at: preSync }) after an offline merge (#397)", () => {
  const waitFor = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
    const started = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - started > 2_000) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const putAction = (opts: {
    id: string;
    gsn: number;
    hlc: string;
    updateId: string;
    title: string;
  }): Action => ({
    id: opts.id,
    actor_id: "a_peer",
    hlc: opts.hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: opts.updateId,
        subject_id: "todo_1",
        subject_type: "todo",
        method: "put",
        data: {
          fields: { title: { value: opts.title, update_id: opts.updateId, hlc: opts.hlc } },
        },
      },
    ],
  });

  it("copies the user's pre-catch-up row, not the merged one", async () => {
    const local = putAction({
      id: "act_local",
      gsn: 0,
      hlc: makeHlc(1711036800000),
      updateId: "u_local",
      title: "Local edit",
    });
    const remote = putAction({
      id: "act_remote",
      gsn: 3,
      hlc: makeHlc(1711036800000, 1),
      updateId: "u_remote",
      title: "Remote edit",
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sync/actions")) return jsonResponse({ rejected: [] });
      if (url.includes("/sync/groups/")) {
        return jsonResponse([remote], { "stream-next-offset": "3", "stream-up-to-date": "true" });
      }
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      schema: duplicateSchema,
      fetchImpl,
    });
    await client.outbox.enqueue(local);
    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(async () => (await client.snapshots.get("todo_1")) !== null);
    await waitFor(async () => (await client.storage.entities.get("todo_1")) !== null);

    const { id } = await client.todo.duplicate("todo_1", { at: "preSync", groups: ["grp_1"] });
    expect(id).not.toBe("todo_1");
    expect((await client.todo.get(id))?.title).toBe("Local edit");
    // The merged source stays merged — the backup never rewrites it.
    expect((await client.todo.get("todo_1"))?.title).toBe("Remote edit");

    unsubscribe();
  });
});
