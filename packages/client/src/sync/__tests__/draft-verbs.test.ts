/**
 * The draft verbs a mounted Action reaches (#692): the entity verbs plus the
 * system `membership.update` / `delete` pair.
 *
 * Every test drives `client.actions.<name>`, so the callback, the ordered
 * planner, the committer and the wire shape run as one path; the stub `fetch`
 * records the submitted Action so a test can assert its Updates and their order.
 */

import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, makeHlc, type Action, type Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { defineAction } from "../../schema/action";
import { EntityValidationError } from "@ebbjs/schema";
import { entityGroupId } from "@ebbjs/write";
import { ActionRejectedError } from "@ebbjs/write";
import type { ActionDrafts } from "../drafts";
import { createClient } from "../client";
import type { Conflict } from "../conflicts";
import type { Rejection } from "../types";

const list = defineEntity("list", { name: e.string() });
const label = defineEntity("label", { name: e.string() });
const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  tags: Type.Array(Type.String()),
});
const profile = defineEntity("profile", { name: e.string() });

const schema = defineSchema({
  entities: { todo, list, label, profile },
  relationships: {
    todo_list: defineRelationship({ source: todo, target: list, as: "list" }),
    todo_tags: defineRelationship({
      source: todo,
      target: label,
      as: "tags",
      sourceCardinality: "many",
    }),
  },
  version: 1,
});

const patchTodo = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; title: string }): void => {
    todos.update(params.id, { title: params.title });
  },
);

const deleteTodo = defineAction(schema, ({ todo: todos }, params: { id: string }): void => {
  todos.delete(params.id);
});

const duplicateTodo = defineAction(
  schema,
  (
    { todo: todos },
    params: { id: string; at?: "current" | "preSync"; groups?: readonly string[] },
  ) => todos.duplicate(params.id, { at: params.at, groups: params.groups }),
);

const linkTodoList = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; targetId: string }): void => {
    todos.link(params.id, "list", params.targetId);
  },
);

const unlinkTodoList = defineAction(schema, ({ todo: todos }, params: { id: string }): void => {
  todos.unlink(params.id, "list");
});

const setTodoLabels = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; labels: readonly string[] }): void => {
    todos.setLinks(params.id, "tags", { replace: params.labels });
  },
);

const shareTodo = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; groupId: string }): void => {
    todos.addToGroup(params.id, params.groupId);
  },
);

const unshareTodo = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; groupId: string }): void => {
    todos.removeFromGroup(params.id, params.groupId);
  },
);

const setTodoGroups = defineAction(
  schema,
  ({ todo: todos }, params: { id: string; groupIds: readonly string[] }): void => {
    todos.setGroups(params.id, params.groupIds);
  },
);

/** A create and a later patch of the same handle in one callback. */
const createThenPatch = defineAction(schema, ({ todo: todos }) => {
  const created = todos.create({ title: "first", completed: false, tags: [] }, { groups: ["g_1"] });
  todos.update(created.id, { title: "second" });
  return created;
});

/** A create and a later share of the same handle in one callback. */
const createThenShare = defineAction(schema, ({ todo: todos }, params: { groupId: string }) => {
  const created = todos.create(
    { title: "shared", completed: false, tags: [] },
    { groups: ["g_1"] },
  );
  todos.addToGroup(created.id, params.groupId);
  return created;
});

/** #692: leaving a workspace as one Action — the profile unshare plus the member delete. */
const leaveWorkspace = defineAction(
  schema,
  (
    { profile: profiles, membership },
    params: { profileId: string; groupId: string; memberId: string },
  ): void => {
    profiles.removeFromGroup(params.profileId, params.groupId);
    membership.delete(params.memberId);
  },
);

const demoteMember = defineAction(schema, ({ membership }, params: { memberId: string }): void => {
  membership.update(params.memberId, { permissions: [] });
});

const removeMember = defineAction(schema, ({ membership }, params: { memberId: string }): void => {
  membership.delete(params.memberId);
});

const actions = {
  patchTodo,
  deleteTodo,
  duplicateTodo,
  linkTodoList,
  unlinkTodoList,
  setTodoLabels,
  shareTodo,
  unshareTodo,
  setTodoGroups,
  createThenPatch,
  createThenShare,
  leaveWorkspace,
  demoteMember,
  removeMember,
} as const;

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** Rejections the stub server returns from `POST /sync/actions`. */
interface StubWriteOptions {
  readonly rejectFor?: (submitted: readonly Action[]) => readonly Rejection[];
}

const PERMISSIONS = ["todo.*", "list.*", "label.*", "profile.*", "groupMember.*", "relationship.*"];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Stub `fetch` recording request bodies and accepting handshakes / writes. */
const mkFetch = (seen: RecordedRequest[], opts: StubWriteOptions): typeof fetch =>
  (async (url: string, init: RequestInit): Promise<Response> => {
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : undefined;
    seen.push({ url, body });
    if (url.endsWith("/sync/handshake")) {
      return jsonResponse({
        actor_id: "actor_1",
        groups: [
          { id: "g_1", permissions: PERMISSIONS, cursor_valid: true, reason: null, cursor: 0 },
          { id: "g_2", permissions: PERMISSIONS, cursor_valid: true, reason: null, cursor: 0 },
          { id: "g_3", permissions: PERMISSIONS, cursor_valid: true, reason: null, cursor: 0 },
          {
            id: "g_personal",
            permissions: PERMISSIONS,
            cursor_valid: true,
            reason: null,
            cursor: 0,
          },
        ],
      });
    }
    if (url.endsWith("/sync/actions")) {
      const submitted = body === undefined ? [] : decodeSync<{ actions: Action[] }>(body).actions;
      return jsonResponse({ rejected: opts.rejectFor?.(submitted) ?? [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

const mkClient = async (opts: StubWriteOptions = {}) => {
  const storage = createMemoryAdapter();
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema,
    actions,
    fetchImpl: mkFetch(seen, opts),
  });
  await client.handshake();
  return { client, storage, seen };
};

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((request) => request.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

const submittedActions = (seen: readonly RecordedRequest[]): readonly Action[] =>
  actionCalls(seen).flatMap((request) => decodeActions(request));

const updatesOf = (seen: readonly RecordedRequest[]): Action["updates"] =>
  submittedActions(seen).flatMap((action) => action.updates);

const fieldsOf = (update: Action["updates"][number]): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(update.data?.fields ?? {}).map(([key, envelope]) => [key, envelope.value]),
  );

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        { value, update_id: "u_src", hlc: makeHlc(5) },
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

const mkMember = (id: string, groupId: string, permissions: readonly string[]): Entity =>
  mkEntity(id, "groupMember", { group_id: groupId, actor_id: "actor_1", permissions });

const mkRelationship = (id: string, sourceId: string, targetId: string): Entity =>
  mkEntity(id, "relationship", {
    source_id: sourceId,
    target_id: targetId,
    field: "list",
    type: "todo",
  });

/** Seed a `todo` row plus its `entityGroup` memberships. */
const seedTodo = async (
  storage: ReturnType<typeof createMemoryAdapter>,
  id: string,
  fields: Record<string, unknown>,
  groups: readonly string[] = ["g_1"],
): Promise<void> => {
  await storage.entities.set(mkEntity(id, "todo", { tags: [], ...fields }));
  for (const [index, groupId] of groups.entries()) {
    await storage.entities.set(mkMembership(`eg_${id}_${index}`, id, groupId));
  }
};

describe("drafts — update / delete", () => {
  it("update emits one patch Update for the named entity", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.patchTodo({ id: "todo_1", title: "Renamed" });

    expect(actionCalls(seen)).toHaveLength(1);
    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "todo_1",
      subject_type: "todo",
      method: "patch",
    });
    expect(fieldsOf(updates[0]!)["title"]).toBe("Renamed");
  });

  it("delete emits one delete Update carrying no data", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.deleteTodo({ id: "todo_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "todo_1",
      subject_type: "todo",
      method: "delete",
      data: null,
    });
  });
});

describe("drafts — duplicate", () => {
  it("copies the live row onto the handle id and defaults to the source's groups", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: true }, ["g_1", "g_2"]);

    const copy = await client.actions.duplicateTodo({ id: "todo_1" });

    expect(actionCalls(seen)).toHaveLength(1);
    const updates = updatesOf(seen);
    const put = updates.find((update) => update.subject_type === "todo")!;
    expect(copy.id).toMatch(/^e_/);
    expect(put.subject_id).toBe(copy.id);
    expect(put.method).toBe("put");
    expect(fieldsOf(put)).toMatchObject({ title: "Ship", completed: true, tags: [] });
    // Verbatim stamps: the copy is a snapshot of the source's merge state,
    // not a re-stamped write.
    expect(put.data?.fields?.["title"]?.update_id).toBe("u_src");

    const memberships = updates.filter((update) => update.subject_type === "entityGroup");
    expect(memberships).toHaveLength(2);
    expect(memberships.every((row) => fieldsOf(row)["entity_id"] === copy.id)).toBe(true);
    expect(memberships.map((row) => fieldsOf(row)["group_id"]).sort()).toEqual(["g_1", "g_2"]);
  });

  it("honors explicit groups over the source's live set", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.duplicateTodo({ id: "todo_1", groups: ["g_2"] });

    const memberships = updatesOf(seen).filter((update) => update.subject_type === "entityGroup");
    expect(memberships.map((row) => fieldsOf(row)["group_id"])).toEqual(["g_2"]);
  });

  it("copies the unresolved conflict's before row for at: preSync", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "merged", completed: false });

    const before = mkEntity("todo_1", "todo", {
      title: "mine",
      completed: true,
      tags: [],
    });
    vi.spyOn(client.conflicts, "list").mockResolvedValue([mkConflict(before)]);

    const copy = await client.actions.duplicateTodo({ id: "todo_1", at: "preSync" });

    const put = updatesOf(seen).find((update) => update.subject_type === "todo")!;
    expect(put.subject_id).toBe(copy.id);
    expect(fieldsOf(put)).toMatchObject({ title: "mine", completed: true });
  });
});

describe("drafts — link / unlink / setLinks", () => {
  it("link emits one relationship put naming the source's field and target", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.linkTodoList({ id: "todo_1", targetId: "list_9" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.subject_type).toBe("relationship");
    expect(updates[0]!.method).toBe("put");
    expect(fieldsOf(updates[0]!)).toMatchObject({
      source_id: "todo_1",
      target_id: "list_9",
      field: "list",
      type: "todo",
    });
  });

  it("unlink deletes the live relationship row by its id", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });
    await storage.entities.set(mkRelationship("rel_1", "todo_1", "list_1"));

    await client.actions.unlinkTodoList({ id: "todo_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "rel_1",
      subject_type: "relationship",
      method: "delete",
      data: null,
    });
  });

  it("unlink with no live edge is a no-op with no submitted Action", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.unlinkTodoList({ id: "todo_1" });

    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("setLinks replaces the canonical FK set and emits one relationship put per target", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    await client.actions.setTodoLabels({ id: "todo_1", labels: ["label_1", "label_2"] });

    const updates = updatesOf(seen);
    const entityPut = updates.find((update) => update.subject_type === "todo")!;
    expect(fieldsOf(entityPut)["tags"]).toEqual(["label_1", "label_2"]);

    const relationships = updates.filter((update) => update.subject_type === "relationship");
    expect(relationships).toHaveLength(2);
    expect(relationships.map((update) => fieldsOf(update)["target_id"]).sort()).toEqual([
      "label_1",
      "label_2",
    ]);
  });
});

describe("drafts — addToGroup / removeFromGroup / setGroups", () => {
  it("addToGroup of a group the entity already holds emits nothing", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false }, ["g_1"]);

    await client.actions.shareTodo({ id: "todo_1", groupId: "g_1" });

    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("removeFromGroup without a local membership row refuses before the wire", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false }, ["g_1"]);

    const error = await client.actions
      .unshareTodo({ id: "todo_1", groupId: "g_2" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EntityValidationError);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("setGroups emits only the delta: one put per added group, one delete per dropped row", async () => {
    const { client, storage, seen } = await mkClient();
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false }, ["g_1", "g_2"]);

    await client.actions.setTodoGroups({ id: "todo_1", groupIds: ["g_2", "g_3"] });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(2);
    const put = updates.find((update) => update.method === "put")!;
    expect(put.subject_id).toBe(entityGroupId("todo_1", "g_3"));
    expect(fieldsOf(put)).toMatchObject({ entity_id: "todo_1", group_id: "g_3" });
    const deleted = updates.find((update) => update.method === "delete")!;
    // The row the local view knows, not the derived id: the delete names
    // the row to remove.
    expect(deleted.subject_id).toBe("eg_todo_1_0");
  });
});

describe("drafts — membership.update / membership.delete", () => {
  it("patches a member row while another capable member remains", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", "g_1", ["profile.*"]));
    await storage.entities.set(mkMember("gm_2", "g_1", ["groupMember.*"]));

    await client.actions.demoteMember({ memberId: "gm_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "gm_1",
      subject_type: "groupMember",
      method: "patch",
    });
    expect(fieldsOf(updates[0]!)["permissions"]).toEqual([]);
  });

  it("leaveWorkspace removes the profile membership and the member row in one Action", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("profile_1", "profile", { name: "Drew" }));
    await storage.entities.set(mkMembership("eg_personal", "profile_1", "g_personal"));
    await storage.entities.set(mkMembership("eg_workspace", "profile_1", "g_1"));
    await storage.entities.set(mkMember("gm_1", "g_1", ["profile.*"]));
    await storage.entities.set(mkMember("gm_2", "g_1", ["groupMember.*"]));

    await client.actions.leaveWorkspace({
      profileId: "profile_1",
      groupId: "g_1",
      memberId: "gm_1",
    });

    expect(actionCalls(seen)).toHaveLength(1);
    const updates = updatesOf(seen);
    const membershipDelete = updates.find(
      (update) => update.subject_type === "entityGroup" && update.method === "delete",
    )!;
    const memberDelete = updates.find((update) => update.subject_type === "groupMember")!;
    expect(membershipDelete.subject_id).toBe("eg_workspace");
    expect(memberDelete).toMatchObject({ subject_id: "gm_1", method: "delete", data: null });
    // Call order carries onto the wire: the unshare precedes the delete.
    expect(updates.indexOf(membershipDelete)).toBeLessThan(updates.indexOf(memberDelete));
  });

  it("membership.update refuses the group's last capable member locally", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", "g_1", ["groupMember.*"]));

    const error = await client.actions
      .demoteMember({ memberId: "gm_1" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((rejection) => rejection.reason)).toEqual([
      "last_group_member",
    ]);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("membership.delete refuses the group's last capable member locally", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", "g_1", ["groupMember.*"]));

    const error = await client.actions
      .removeMember({ memberId: "gm_1" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((rejection) => rejection.reason)).toEqual([
      "last_group_member",
    ]);
    expect(actionCalls(seen)).toHaveLength(0);
  });
});

describe("drafts — call order is wire order", () => {
  it("keeps a created entity's put ahead of its later patch", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createThenPatch();

    expect(actionCalls(seen)).toHaveLength(1);
    const updates = updatesOf(seen);
    const todoPuts = updates.filter((update) => update.subject_type === "todo");
    expect(todoPuts).toHaveLength(2);
    expect(todoPuts[0]!.subject_id).toBe(created.id);
    expect(fieldsOf(todoPuts[0]!)["title"]).toBe("first");
    expect(todoPuts[1]!.subject_id).toBe(created.id);
    expect(fieldsOf(todoPuts[1]!)["title"]).toBe("second");

    // The create's membership row lands before the patch, not after the batch.
    const patchIndex = updates.indexOf(todoPuts[1]!);
    expect(
      updates
        .slice(0, patchIndex)
        .some(
          (update) =>
            update.subject_type === "entityGroup" && fieldsOf(update)["entity_id"] === created.id,
        ),
    ).toBe(true);
  });

  it("keeps a created entity's put ahead of its later share", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createThenShare({ groupId: "g_2" });

    const updates = updatesOf(seen);
    expect(updates[0]).toMatchObject({
      subject_id: created.id,
      subject_type: "todo",
      method: "put",
    });
    const memberships = updates.filter((update) => update.subject_type === "entityGroup");
    expect(memberships.map((update) => fieldsOf(update)["group_id"])).toEqual(["g_1", "g_2"]);
    expect(memberships[1]!.subject_id).toBe(entityGroupId(created.id, "g_2"));
  });

  it("skips a share of the group the batch's own create already filed", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createThenShare({ groupId: "g_1" });

    const updates = updatesOf(seen);
    expect(updates.filter((update) => update.subject_type === "entityGroup")).toHaveLength(1);
    expect(
      updates.filter((update) => update.subject_id === created.id && update.method === "put"),
    ).toHaveLength(1);
  });
});

describe("drafts — typed create input", () => {
  it("accepts the wire fields plus relationship pointers", () => {
    const typecheck: () => void = () => {
      const drafts = null as unknown as ActionDrafts<typeof schema>;
      void drafts.todo.create(
        { title: "Ship", completed: false, tags: [], list: "list_1" },
        { groups: ["g_1"] },
      );
    };
    expect(typecheck).toBeTypeOf("function");
  });

  it("rejects a wrong field type and a missing required field", () => {
    const typecheck: () => void = () => {
      const drafts = null as unknown as ActionDrafts<typeof schema>;
      // @ts-expect-error — `title` is a string on the wire.
      void drafts.todo.create({ title: 123, completed: false, tags: [] }, { groups: ["g_1"] });
      // @ts-expect-error — `completed` is a required wire field.
      void drafts.todo.create({ title: "Ship", tags: [] }, { groups: ["g_1"] });
    };
    expect(typecheck).toBeTypeOf("function");
  });
  it("keeps the membership verbs off the system namespaces", () => {
    const typecheck: () => void = () => {
      const drafts = null as unknown as ActionDrafts<typeof schema>;
      // @ts-expect-error — an `entityGroup` row scoping a group is meaningless.
      void drafts.group.addToGroup("g_1", "g_2");
      // @ts-expect-error — same for a `groupMember`.
      void drafts.membership.setGroups("gm_1", ["g_1"]);
    };
    expect(typecheck).toBeTypeOf("function");
  });
});

describe("drafts — rejection", () => {
  it("surfaces a server rejection as ActionRejectedError", async () => {
    const { client, storage, seen } = await mkClient({
      rejectFor: (submitted) => [
        {
          id: submitted[0]!.id,
          reason: "not_authorized",
          details: "actor lacks todo.update in group g_1",
        },
      ],
    });
    await seedTodo(storage, "todo_1", { title: "Ship", completed: false });

    const error = await client.actions
      .patchTodo({ id: "todo_1", title: "Renamed" })
      .catch((err: unknown) => err);

    expect(actionCalls(seen)).toHaveLength(1);
    const submitted = submittedActions(seen)[0]!;
    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).name).toBe("ActionRejectedError");
    expect((error as ActionRejectedError).rejections).toEqual([
      {
        id: submitted.id,
        reason: "not_authorized",
        details: "actor lacks todo.update in group g_1",
      },
    ]);
  });
});

/** A conflict carrying one subject's `before` row, as detection writes it. */
const mkConflict = (before: Entity): Conflict => ({
  id: "c_1",
  subjects: [before.id],
  subjectStates: [
    {
      subjectId: before.id,
      subjectType: before.type,
      before,
      after: mkEntity(before.id, before.type, { title: "merged", completed: false, tags: [] }),
      diff: [],
    },
  ],
  entries: [],
  remoteWins: () => true,
});
