/**
 * Tests for the draft `duplicate(id, opts)` verb — the user-facing
 * backup operation (#397), reached through a mounted action. A duplicate
 * is a new row of the same type carrying the source's field values
 * verbatim, written through the normal entity path as one `put` plus the
 * caller's membership rows.
 */

import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, makeHlc, type Action, type Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineModel, e } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import { defineAction } from "../../schema/action";
import type { DuplicateAt } from "../drafts";
import { createClient } from "../client";
import type { Conflict } from "../conflicts";
import { jsonResponse, openSseResponse, updateModel } from "../test-utils";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const runSchema = Type.Object({ text: Type.String() });
const doc = defineModel("doc", {
  content: e.map(runSchema),
});

const duplicateSchema = defineSchema({ models: { todo, doc }, version: 1 });

/** The definitions under test: one duplicate per entity, so the call site is typed. */
const duplicateTodo = defineAction(
  duplicateSchema,
  (
    { todo: todos },
    params: { id: string; at?: DuplicateAt; groups?: readonly string[]; validate?: boolean },
  ) =>
    todos.duplicate(params.id, { at: params.at, groups: params.groups, validate: params.validate }),
);

const duplicateDoc = defineAction(duplicateSchema, ({ doc: docs }, params: { id: string }) =>
  docs.duplicate(params.id),
);

const actions = { duplicateTodo, duplicateDoc };

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
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
});

const mkMembership = (id: string, entityId: string, groupId: string): Entity =>
  mkEntity(id, "entityGroup", { entity_id: entityId, group_id: groupId });

const storageOf = () => createMemoryAdapter();

const mkClient = async () => {
  const storage = storageOf();
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema: duplicateSchema,
    actions,
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

/** The Updates of one model, grouped into one list per subject row. */
const rowsOf = (
  updates: readonly Action["updates"][number][],
  model: string,
): readonly (readonly Action["updates"][number][])[] => {
  const bySubject = new Map<string, Action["updates"][number][]>();
  for (const update of updates) {
    if (updateModel(update) !== model) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/** One component's value on a row. */
const componentOf = (row: readonly Action["updates"][number][], field: string): unknown => {
  const update = row.find(
    (candidate) =>
      candidate.method !== "drop" &&
      candidate.method !== "delete" &&
      candidate.component === `todo/${field}`,
  );
  return update === undefined || update.method === "drop" || update.method === "delete"
    ? undefined
    : update.data.value;
};

const decodeFirstAction = (request: RecordedRequest): Action =>
  decodeSync<{ actions: Action[] }>(request.body!).actions[0]!;

describe("duplicate — field copy", () => {
  it("creates a new row with the same field values and leaves the original untouched", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "Ship", completed: false });

    const { id } = await client.actions.duplicateTodo({ id: "t_1" });

    expect(id).not.toBe("t_1");
    const [put] = rowsOf(decodeFirstAction(actionRequests(seen)[0]!).updates, "todo");
    expect(put!.every((update) => update.method === "replace")).toBe(true);
    expect(put![0]!.subject_id).toBe(id);
    expect(componentOf(put!, "title")).toBe("Ship");
    expect(componentOf(put!, "completed")).toBe(false);

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

    const { id } = await client.actions.duplicateDoc({ id: "doc_1" });

    const [put] = rowsOf(decodeFirstAction(actionRequests(seen)[0]!).updates, "doc");
    const content = put!.find(
      (update) => update.method !== "delete" && update.component === "doc/content",
    )!;
    expect(content.data).toEqual({ map: { run_1: runField } });

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

    const { id } = await client.actions.duplicateTodo({ id: "t_1" });

    const copy = await storage.entities.get(id);
    expect(copy?.data?.fields?.["title"]?.value).toBe("gone");
    expect(copy?.deleted_hlc).toBeNull();
  });

  it("throws when the source id names another entity type", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("d_1", "doc", {}));
    await expect(client.actions.duplicateTodo({ id: "d_1" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("throws for an unknown id before any network call", async () => {
    const { client, seen } = await mkClient();
    await expect(client.actions.duplicateTodo({ id: "missing" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("validates the copied row like create and refuses a non-conforming source", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: 42, completed: false }));
    await expect(client.actions.duplicateTodo({ id: "t_1" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("refuses an undeclared field on the source", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: "T", completed: false, bogus: 1 }));
    await expect(client.actions.duplicateTodo({ id: "t_1" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("duplicate({ validate: false }) skips validation and submits", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: 42, completed: false });
    await client.actions.duplicateTodo({ id: "t_1", validate: false });
    expect(actionRequests(seen)).toHaveLength(1);
  });
});

describe("duplicate — memberships", () => {
  it("defaults to the source's live groups", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "T", completed: false }, ["g_1", "g_2"]);

    const { id } = await client.actions.duplicateTodo({ id: "t_1" });

    const memberships = rowsOf(decodeFirstAction(actionRequests(seen)[0]!).updates, "entityGroup");
    expect(memberships).toHaveLength(2);
    const valueOfComponent = (
      row: readonly Action["updates"][number][],
      component: string,
    ): unknown => {
      const update = row.find(
        (candidate) => candidate.method !== "delete" && candidate.component === component,
      );
      return update === undefined || update.method === "delete"
        ? undefined
        : (update.data as { value: unknown }).value;
    };
    for (const membership of memberships) {
      expect(valueOfComponent(membership, "entityGroup/entity_id")).toBe(id);
    }
    expect(memberships.map((row) => valueOfComponent(row, "entityGroup/group_id")).sort()).toEqual([
      "g_1",
      "g_2",
    ]);
  });

  it("honors an explicit groups option over the source's", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "T", completed: false });

    await client.actions.duplicateTodo({ id: "t_1", groups: ["g_2"] });

    const memberships = rowsOf(decodeFirstAction(actionRequests(seen)[0]!).updates, "entityGroup");
    expect(
      memberships.map((row) => {
        const update = row.find(
          (candidate) =>
            candidate.method !== "delete" && candidate.component === "entityGroup/group_id",
        );
        return update === undefined || update.method === "delete"
          ? undefined
          : (update.data as { value: unknown }).value;
      }),
    ).toEqual(["g_2"]);
  });

  it("refuses an empty groups option before any network call", async () => {
    const { client, seen } = await mkClient();
    await expect(client.actions.duplicateTodo({ id: "t_1", groups: [] })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("throws when the source has no live groups and none are given", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("t_1", "todo", { title: "T", completed: false }));
    await expect(client.actions.duplicateTodo({ id: "t_1" })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });
});

/** A conflict carrying one subject's `before` row, as detection writes it. */
const mkConflict = (before: Entity): Conflict => ({
  id: "c_1",
  scope: "field",
  subjects: [before.id],
  holds: [{ kind: "subject", subjectId: before.id }],
  subjectStates: [
    {
      subjectId: before.id,
      model: before.type,
      before,
      after: mkEntity(before.id, before.type, { title: "merged", completed: false }),
      diff: [],
    },
  ],
  entries: [],
  remoteActions: [],
});

describe("duplicate — at: preSync", () => {
  it("copies the unresolved conflict's before row instead of the live row", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "merged", completed: false });

    const before = mkEntity("t_1", "todo", { title: "mine", completed: true });
    vi.spyOn(client.conflicts, "list").mockResolvedValue([mkConflict(before)]);

    const { id } = await client.actions.duplicateTodo({ id: "t_1", at: "preSync" });

    const [put] = rowsOf(decodeFirstAction(actionRequests(seen)[0]!).updates, "todo");
    expect(componentOf(put!, "title")).toBe("mine");
    expect(componentOf(put!, "completed")).toBe(true);
    expect((await storage.entities.get(id))?.data?.fields?.["title"]?.value).toBe("mine");
  });

  it("throws when no unresolved conflict references the id", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "t_1", { title: "merged", completed: false });
    await expect(client.actions.duplicateTodo({ id: "t_1", at: "preSync" })).rejects.toThrow(
      'duplicate: no unresolved conflict for "t_1"',
    );
    expect(actionRequests(seen)).toHaveLength(0);
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
        id: `${opts.updateId}_0`,
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace",
        data: { value: opts.title, update_id: opts.updateId, hlc: opts.hlc },
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
      actions,
      fetchImpl,
    });
    await client.outbox.enqueue(local);
    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});

    await waitFor(async () => (await client.conflicts.list()).length > 0);
    await waitFor(async () => (await client.storage.entities.get("todo_1")) !== null);

    const { id } = await client.actions.duplicateTodo({
      id: "todo_1",
      at: "preSync",
      groups: ["grp_1"],
    });
    expect(id).not.toBe("todo_1");
    expect((await client.todo.get(id))?.title).toBe("Local edit");
    // The merged source stays merged — the backup never rewrites it.
    expect((await client.todo.get("todo_1"))?.title).toBe("Remote edit");

    unsubscribe();
  });
});
