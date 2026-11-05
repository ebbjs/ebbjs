/**
 * End-to-end tests for the `group` / `membership` system drafts (#465) —
 * the bootstrap `create`, the draft verbs, and the `defineAction` recipe
 * that composes a `groupMember` put with an `entityGroup` put in one
 * Action.
 *
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action and assert the wire shape. `entityGroup` stays
 * internal: no namespace, no draft handle, and no bootstrap row for the
 * group itself.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action, type Entity } from "@ebbjs/core";
import type { TSchema } from "@sinclair/typebox/type";

import { defineEntity, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { groupSystemEntity, type GroupFields, type GroupMemberFields } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import { defineAction, type AnyActionDef } from "../../schema/action";
import { ActionRejectedError } from "@ebbjs/write";
import type { ActionDrafts } from "../drafts";
import type { WireStatic } from "../namespace";
import { createClient } from "../client";
import { seedReplicaRow } from "../test-utils";

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Stub `fetch` recording request bodies and accepting handshakes / writes. */
const mkRecordingFetch = (seen: RecordedRequest[]): typeof fetch =>
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
          {
            id: "g_1",
            permissions: ["profile.*", "group.*", "groupMember.*", "relationship.*"],
            cursor_valid: true,
            reason: null,
            cursor: 0,
          },
        ],
      });
    }
    if (url.endsWith("/sync/actions")) {
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

const profile = defineEntity("profile", { name: e.string() });
const schema = defineSchema({
  entities: { profile },
  // A system entity can own a relationship. Without one the system
  // namespaces' link / unlink verbs would have nothing to point at.
  relationships: {
    group_lead: defineRelationship({ source: groupSystemEntity, target: profile, as: "lead" }),
  },
  version: 1,
});

/** The system drafts under test, each declared so the call site stays typed. */
const createGroup = defineAction(schema, ({ group }, params: WireStatic<GroupFields>) =>
  group.create(params),
);

const createMembership = defineAction(
  schema,
  ({ membership }, params: WireStatic<GroupMemberFields>) => membership.create(params),
);

const updateMembership = defineAction(
  schema,
  ({ membership }, params: { id: string; patch: Partial<WireStatic<GroupMemberFields>> }): void => {
    membership.update(params.id, params.patch);
  },
);

const deleteMembership = defineAction(schema, ({ membership }, params: { id: string }): void => {
  membership.delete(params.id);
});

const updateGroup = defineAction(
  schema,
  ({ group }, params: { id: string; name: string }): void => {
    group.update(params.id, { name: params.name });
  },
);

const updateGroupApps = defineAction(
  schema,
  ({ group }, params: { id: string; apps: Record<string, boolean> }): void => {
    group.update(params.id, { apps: params.apps });
  },
);

const deleteGroup = defineAction(schema, ({ group }, params: { id: string }): void => {
  group.delete(params.id);
});

/**
 * A group copy and its actor's own membership, the way the bootstrap pairs
 * them: the copy is a new group, so that membership's declared grant is
 * what authorizes the group put.
 */
const duplicateGroup = defineAction(
  schema,
  ({ group, membership }, params: { id: string; groups: readonly string[] }) => {
    const copy = group.duplicate(params.id, { groups: params.groups });
    membership.create({
      group_id: copy.id,
      actor_id: "actor_1",
      permissions: ["profile.*", "group.*", "groupMember.*", "relationship.*"],
    });
    return copy;
  },
);

const duplicateMembership = defineAction(schema, ({ membership }, params: { id: string }) =>
  membership.duplicate(params.id, { groups: ["g_1"] }),
);

const linkGroupLead = defineAction(
  schema,
  ({ group }, params: { id: string; profileId: string }): void => {
    group.link(params.id, "lead", params.profileId);
  },
);

const unlinkGroupLead = defineAction(schema, ({ group }, params: { id: string }): void => {
  group.unlink(params.id, "lead");
});

/** A system create carrying a payload the schema refuses, with validation opt-in / opt-out. */
const createGroupWith = defineAction(
  schema,
  ({ group }, params: { name: number; validate: boolean }) =>
    group.create({ name: params.name } as never, { validate: params.validate }),
);

const createMembershipWith = defineAction(
  schema,
  ({ membership }, params: { permissions: number; validate: boolean }) =>
    membership.create(
      { group_id: "g_1", actor_id: "actor_1", permissions: params.permissions } as never,
      { validate: params.validate },
    ),
);

/** The bootstrap and a content create, composed into one Action. */
const createTeamWithMember = defineAction(
  schema,
  ({ group, profile: profiles }, params: { team: string; member: string }) => {
    const team = group.create({ name: params.team });
    return { team, member: profiles.create({ name: params.member }, { groups: [team] }) };
  },
);

/** Resolves the drafts the runtime hands a callback, for the surface assertions. */
const inspectDrafts = defineAction(schema, (drafts) => drafts);

const systemActions = {
  createGroup,
  createMembership,
  updateMembership,
  deleteMembership,
  updateGroup,
  updateGroupApps,
  deleteGroup,
  duplicateGroup,
  duplicateMembership,
  linkGroupLead,
  unlinkGroupLead,
  createGroupWith,
  createMembershipWith,
  createTeamWithMember,
  inspectDrafts,
};

/** #441's `addToWorkspace`: a membership put plus the profile's membership row, one Action. */
const addToWorkspace = defineAction(
  schema,
  (
    { membership, profile: profileDraft },
    params: { profileId: string; groupId: string; permissions: string[] },
  ) => {
    membership.create({
      group_id: params.groupId,
      actor_id: "actor_1",
      permissions: params.permissions,
    });
    profileDraft.addToGroup(params.profileId, params.groupId);
  },
);

const mkClientWith = async <TActions extends Record<string, AnyActionDef>>(
  actions: TActions,
  appId?: string,
) => {
  const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
  const storage = createMemoryAdapter();
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    appId,
    storage,
    schema,
    actions,
    fetchImpl: mkRecordingFetch(seen),
  });
  await client.handshake();
  return { client, storage, seen };
};

const mkClient = () => mkClientWith(systemActions);

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

const updatesOf = (seen: readonly RecordedRequest[]): Action["updates"] =>
  actionCalls(seen).flatMap((call) => decodeActions(call).flatMap((action) => action.updates));

const fieldsOf = (update: Action["updates"][number]): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(update.data?.fields ?? {}).map(([key, env]) => [key, env.value]),
  );

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

describe("draft group.create — bootstrap", () => {
  it("submits one Action with the group put and the actor's own groupMember put", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createGroup({ name: "Team" });

    const updates = updatesOf(seen);
    expect(updates.filter((u) => u.subject_type === "group")).toHaveLength(1);
    const groupPut = updates.find((u) => u.subject_type === "group")!;
    expect(groupPut.subject_id).toBe(created.id);
    expect(fieldsOf(groupPut)["name"]).toBe("Team");

    expect(updates.filter((u) => u.subject_type === "groupMember")).toHaveLength(1);
    const memberPut = updates.find((u) => u.subject_type === "groupMember")!;
    expect(fieldsOf(memberPut)).toMatchObject({
      actor_id: "actor_1",
      group_id: created.id,
    });

    // No `entityGroup` row for the group itself — a group is its own group.
    expect(updates.filter((u) => u.subject_type === "entityGroup")).toHaveLength(0);

    // Exactly one Action reached the wire.
    expect(actionCalls(seen)).toHaveLength(1);
    expect(decodeActions(actionCalls(seen)[0]!)).toHaveLength(1);
  });

  it("grants one `<entity>.*` wildcard per registered entity", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createGroup({ name: "Team" });

    const memberPut = updatesOf(seen).find((u) => u.subject_type === "groupMember")!;
    const permissions = fieldsOf(memberPut)["permissions"] as readonly string[];
    expect(permissions).toContain("profile.*");
    expect(permissions).toContain("group.*");
    expect(permissions).toContain("groupMember.*");
    expect(permissions).toContain("relationship.*");
  });
});

describe("draft group.create — app scope (#732)", () => {
  it("scopes the new group to the client's app", async () => {
    const { client, seen } = await mkClientWith(systemActions, "notes");

    await client.actions.createGroup({ name: "Team" });

    const groupPut = updatesOf(seen).find((update) => update.subject_type === "group")!;
    expect(groupPut.data!.fields!["apps"]).toEqual({
      map: { notes: { value: true, update_id: expect.any(String), hlc: expect.any(String) } },
    });
  });

  it("omits apps when the client declares no app", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createGroup({ name: "Team" });

    const groupPut = updatesOf(seen).find((update) => update.subject_type === "group")!;
    expect(groupPut.data!.fields!["apps"]).toBeUndefined();
  });

  it("writes a map envelope for a scope patch so app keys merge independently", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("g_1", "group", { name: "Team" }));

    await client.actions.updateGroupApps({ id: "g_1", apps: { issues: false } });

    const patch = updatesOf(seen)[0]!;
    expect(patch.data!.fields!["apps"]).toEqual({
      map: { issues: { value: false, update_id: expect.any(String), hlc: expect.any(String) } },
    });
  });
});

describe("draft membership.create", () => {
  it("submits one Action with a single groupMember put and no entityGroup row", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createMembership({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(created.id).toMatch(/^e_/);
    expect(updates[0]!.subject_type).toBe("groupMember");
    expect(updates[0]!.subject_id).toBe(created.id);
    expect(fieldsOf(updates[0]!)).toMatchObject({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });
    expect(updates.filter((u) => u.subject_type === "entityGroup")).toHaveLength(0);
  });
});

describe("draft membership — last_group_member refusal", () => {
  const mkMember = (id: string, permissions: readonly string[], groupId = "g_1"): Entity =>
    mkEntity(id, "groupMember", { group_id: groupId, actor_id: "actor_1", permissions });

  it("delete() of the group's last capable member is refused with last_group_member", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["groupMember.*"]));

    const error = await client.actions
      .deleteMembership({ id: "gm_1" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((r) => r.reason)).toEqual([
      "last_group_member",
    ]);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("update() emptying the group's only permission list is refused with last_group_member", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["groupMember.*"]));

    const error = await client.actions
      .updateMembership({ id: "gm_1", patch: { permissions: [] } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((r) => r.reason)).toEqual([
      "last_group_member",
    ]);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("delete() of a non-last member still submits one Action", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["groupMember.*"]));
    await storage.entities.set(mkMember("gm_2", ["profile.*"]));

    await expect(client.actions.deleteMembership({ id: "gm_1" })).resolves.toBeUndefined();
    expect(actionCalls(seen)).toHaveLength(1);
  });

  it("delete() of an uncached row defers to the server", async () => {
    const { client, seen } = await mkClient();

    await expect(client.actions.deleteMembership({ id: "gm_absent" })).resolves.toBeUndefined();
    expect(actionCalls(seen)).toHaveLength(1);
  });
});

describe("draft system — shared verbs", () => {
  it("group.update emits one patch for the named group", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("g_1", "group", { name: "Team" }));

    await client.actions.updateGroup({ id: "g_1", name: "Renamed" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "g_1",
      subject_type: "group",
      method: "patch",
    });
    expect(fieldsOf(updates[0]!)["name"]).toBe("Renamed");
  });

  it("group.delete emits one delete Update carrying no data", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("g_1", "group", { name: "Team" }));

    await client.actions.deleteGroup({ id: "g_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "g_1",
      subject_type: "group",
      method: "delete",
      data: null,
    });
  });

  it("group.duplicate copies the row into the requested groups", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkEntity("g_src", "group", { name: "Team" }));

    const copy = await client.actions.duplicateGroup({ id: "g_src", groups: ["g_1"] });

    const updates = updatesOf(seen);
    const put = updates.find(
      (update) => update.subject_type === "group" && update.subject_id === copy.id,
    )!;
    expect(copy.id).toMatch(/^e_/);
    expect(put.method).toBe("put");
    expect(fieldsOf(put)["name"]).toBe("Team");
    const filed = updates.filter(
      (update) =>
        update.subject_type === "entityGroup" && fieldsOf(update)["entity_id"] === copy.id,
    );
    expect(filed.map((update) => fieldsOf(update)["group_id"])).toEqual(["g_1"]);
    expect(actionCalls(seen)).toHaveLength(1);
  });

  it("membership.duplicate copies the member row onto the handle id", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(
      mkEntity("gm_src", "groupMember", {
        group_id: "g_1",
        actor_id: "actor_2",
        permissions: ["profile.*"],
      }),
    );

    const copy = await client.actions.duplicateMembership({ id: "gm_src" });

    const put = updatesOf(seen).find((update) => update.subject_type === "groupMember")!;
    expect(put.subject_id).toBe(copy.id);
    expect(put.method).toBe("put");
    expect(fieldsOf(put)).toMatchObject({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });
  });

  it("group.link emits one relationship put naming the group as source", async () => {
    const { client, seen } = await mkClient();

    await client.actions.linkGroupLead({ id: "g_1", profileId: "profile_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.subject_type).toBe("relationship");
    expect(updates[0]!.method).toBe("put");
    expect(fieldsOf(updates[0]!)).toMatchObject({
      source_id: "g_1",
      target_id: "profile_1",
      field: "lead",
      type: "group",
    });
  });

  it("group.unlink deletes the live edge by its row id", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "g_1",
        target_id: "profile_1",
        field: "lead",
        type: "group",
      }),
    );

    await client.actions.unlinkGroupLead({ id: "g_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      subject_id: "rel_1",
      subject_type: "relationship",
      method: "delete",
      data: null,
    });
  });
});

describe("draft system creates — validate pass-through", () => {
  it("group.create validates the payload by default", async () => {
    const { client, seen } = await mkClient();

    const error = await client.actions
      .createGroupWith({ name: 42, validate: true })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EntityValidationError);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("group.create({ validate: false }) skips local validation and submits", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createGroupWith({ name: 42, validate: false });

    const groupPut = updatesOf(seen).find((update) => update.subject_type === "group")!;
    expect(fieldsOf(groupPut)["name"]).toBe(42);
  });

  it("membership.create validates the payload by default", async () => {
    const { client, seen } = await mkClient();

    const error = await client.actions
      .createMembershipWith({ permissions: 42, validate: true })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EntityValidationError);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("membership.create({ validate: false }) skips local validation and submits", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createMembershipWith({ permissions: 42, validate: false });

    const memberPut = updatesOf(seen).find((update) => update.subject_type === "groupMember")!;
    expect(fieldsOf(memberPut)["permissions"]).toBe(42);
  });
});

describe("system namespace exposure", () => {
  it("keeps `entityGroup` internal — no namespace, no draft handle", async () => {
    const { client } = await mkClient();

    expect((client as unknown as Record<string, unknown>)["entityGroup"]).toBeUndefined();

    const drafts: ActionDrafts<typeof schema> = await client.actions.inspectDrafts();
    expect(Object.keys(drafts)).not.toContain("entityGroup");
    expect(Object.keys(drafts)).toEqual(expect.arrayContaining(["group", "membership"]));

    // An entityGroup row scoping a group or a member is meaningless, so
    // the membership verbs are not part of the runtime surface either.
    const group = client.group as unknown as Record<string, unknown>;
    expect(group["addToGroup"]).toBeUndefined();
    expect(group["removeFromGroup"]).toBeUndefined();
    expect(group["setGroups"]).toBeUndefined();
    const member = client.membership as unknown as Record<string, unknown>;
    expect(member["addToGroup"]).toBeUndefined();
  });
});

describe("system drafts — one Action", () => {
  it("composes the bootstrap with a content create into one Action", async () => {
    const { client, seen } = await mkClient();

    const result = await client.actions.createTeamWithMember({ team: "Team", member: "Drew" });

    const updates = updatesOf(seen);
    expect(actionCalls(seen)).toHaveLength(1);
    expect(updates.filter((u) => u.subject_type === "group")).toHaveLength(1);
    expect(updates.filter((u) => u.subject_type === "groupMember")).toHaveLength(1);
    expect(updates.filter((u) => u.subject_type === "profile")).toHaveLength(1);

    const membership = updates.filter((u) => u.subject_type === "entityGroup");
    expect(membership).toHaveLength(1);
    expect(fieldsOf(membership[0]!)).toEqual({
      entity_id: result.member.id,
      group_id: result.team.id,
    });
  });
});

describe("defineAction — addToWorkspace", () => {
  it("composes a groupMember put and a profile entityGroup put in one Action", async () => {
    const { client, seen } = await mkClientWith({ ...systemActions, addToWorkspace });

    await client.actions.addToWorkspace({
      profileId: "profile_1",
      groupId: "g_1",
      permissions: ["profile.*"],
    });

    const updates = updatesOf(seen);
    expect(actionCalls(seen)).toHaveLength(1);
    expect(updates).toHaveLength(2);
    expect(updates.filter((u) => u.subject_type === "groupMember")).toHaveLength(1);

    const membership = updates.filter((u) => u.subject_type === "entityGroup");
    expect(membership).toHaveLength(1);
    expect(fieldsOf(membership[0]!)).toEqual({
      entity_id: "profile_1",
      group_id: "g_1",
    });
  });
});

describe("client.group read path", () => {
  it("returns null for an absent id and round-trips a stored group row", async () => {
    const { client, storage } = await mkClient();

    expect(await client.group.get("g_absent")).toBeNull();

    const groupRow = mkEntity("g_1", "group", { name: "Team" });
    seedReplicaRow(client.replica, groupRow);
    await storage.entities.set(groupRow);
    const row = await client.group.get("g_1");
    expect(row?.id).toBe("g_1");
    expect(row?.name).toBe("Team");

    const rows = await client.group.query();
    expect(rows.map((r) => r.name)).toEqual(["Team"]);
  });
});

describe("client.membership typing", () => {
  it("exports GroupMemberFields and rejects an undeclared field on create", async () => {
    const { client } = await mkClient();

    type FieldKeys = keyof GroupMemberFields;
    const keys: FieldKeys[] = ["group_id", "actor_id", "permissions"];
    expect(keys).toHaveLength(3);
    // The field map must be a TypeBox field record.
    type IsFieldMap = GroupMemberFields extends Record<string, TSchema> ? true : false;
    const isFieldMap: IsFieldMap = true;
    expect(isFieldMap).toBe(true);

    // Never invoked: the @ts-expect-error line below is the assertion.
    const guard = (): void => {
      // @ts-expect-error — `bogus` is not declared on the groupMember shape.
      void client.actions.createMembership({ bogus: 1 });
    };
    expect(guard).toBeTypeOf("function");

    const draftGuard = (): void => {
      // @ts-expect-error — `bogus` is not declared on the group draft shape.
      void client.actions.createGroup({ bogus: 1 });
    };
    expect(draftGuard).toBeTypeOf("function");
  });
});
