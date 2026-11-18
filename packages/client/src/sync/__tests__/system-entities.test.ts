/**
 * End-to-end tests for the `group` / `membership` system drafts (#465): the
 * bootstrap `create`, the draft verbs, and the `defineAction` recipes that
 * compose a grant put with a membership put in one Action.
 *
 * The stub `fetch` records every request so the tests can decode the submitted
 * Action and assert the wire shape.
 */

import { describe, expect, it } from "vitest";
import {
  decodeSync,
  EBB_MODEL_NAME,
  isComponentUpdate,
  type Action,
  type Entity,
} from "@ebbjs/core";

import { defineModel, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { ebbModel, type GrantFields } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import { defineAction, type AnyActionDef } from "../../schema/action";
import { ActionRejectedError } from "@ebbjs/write";
import type { ActionDrafts } from "../drafts";

import { createClient } from "../client";
import {
  linkLeavesOf,
  linkTargetsOf,
  linkValue,
  platformEntity,
  rowFields,
  rowsByModel,
  seedReplicaRow,
} from "../test-utils";

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
            permissions: [
              "profile.*",
              "ebb/group.*",
              "ebb/grant.*",
              "ebb/membership.*",
              "ebb/link.*",
            ],
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

const profile = defineModel("profile", { name: e.string() });
const schema = defineSchema({
  models: { profile },
  // A platform model can own a relationship. Without one the system
  // namespaces' link / unlink verbs would have nothing to point at.
  relationships: {
    // A platform row can own a relationship; its model is `ebb` and its kind is
    // the component it carries.
    group_lead: defineRelationship({ source: ebbModel, target: profile, as: "lead" }),
  },
  version: 1,
});

/** The system drafts under test, each declared so the call site stays typed. */
const createGroup = defineAction(
  schema,
  ({ group }, params: { name: string; apps?: readonly string[] }) => group.create(params),
);

const createMembership = defineAction(schema, ({ membership }, params: GrantFields) =>
  membership.create(params),
);

const updateMembership = defineAction(
  schema,
  ({ membership }, params: { id: string; patch: Partial<GrantFields> }): void => {
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
  ({ group }, params: { id: string; apps: string[] }): void => {
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
      permissions: [
        "profile.*",
        "ebb/group.*",
        "ebb/grant.*",
        "ebb/membership.*",
        "ebb/link.*",
      ] as string[],
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

describe("draft group.create — bootstrap", () => {
  it("submits one Action with the group put and the actor's own grant put", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createGroup({ name: "Team" });

    const updates = updatesOf(seen);
    const groupRows = rowsByModel(updates, "group");
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0]![0]!.subject_id).toBe(created.id);
    expect(rowFields(groupRows[0]!)["name"]).toBe("Team");

    const memberRows = rowsByModel(updates, "grant");
    expect(memberRows).toHaveLength(1);
    expect(rowFields(memberRows[0]!)).toMatchObject({
      actor_id: "actor_1",
      group_id: created.id,
    });

    // No `membership` row for the group itself — a group is its own group.
    expect(rowsByModel(updates, "membership")).toHaveLength(0);

    // Exactly one Action reached the wire.
    expect(actionCalls(seen)).toHaveLength(1);
    expect(decodeActions(actionCalls(seen)[0]!)).toHaveLength(1);
  });

  it("grants one `<entity>.*` wildcard per registered entity", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createGroup({ name: "Team" });

    const [memberRow] = rowsByModel(updatesOf(seen), "grant");
    const permissions = rowFields(memberRow!)["permissions"] as readonly string[];
    // A grant names a model, and its wildcard covers every component under it.
    expect(permissions).toEqual(["ebb.*", "profile.*"]);
  });
});

describe("draft group.create — app scope (#732)", () => {
  it("scopes the new group to the client's app", async () => {
    const { client, seen } = await mkClientWith(systemActions, "notes");

    await client.actions.createGroup({ name: "Team" });

    const [groupRow] = rowsByModel(updatesOf(seen), "group");
    expect(rowFields(groupRow!)["apps"]).toEqual(["notes"]);
  });

  it("omits apps when the client declares no app", async () => {
    const { client, seen } = await mkClient();

    await client.actions.createGroup({ name: "Team" });

    const [groupRow] = rowsByModel(updatesOf(seen), "group");
    expect(rowFields(groupRow!)["apps"]).toBeUndefined();
  });

  it("rewrites the whole group value when the app scope changes", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(platformEntity("g_1", "group", { name: "Team" }));

    await client.actions.updateGroupApps({ id: "g_1", apps: ["issues"] });

    // An atomic value has no partial write: the patch carries the whole value,
    // so the name it did not touch survives.
    const [update] = updatesOf(seen).filter(
      (candidate) => isComponentUpdate(candidate) && candidate.component === "ebb/group",
    );
    expect(rowFields([update!])).toMatchObject({ name: "Team", apps: ["issues"] });
  });
});

describe("draft membership.create", () => {
  it("submits one Action with a single grant put and no membership row", async () => {
    const { client, seen } = await mkClient();

    const created = await client.actions.createMembership({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });

    const updates = updatesOf(seen);
    const [row] = rowsByModel(updates, "grant");
    // One atomic `ebb/grant` value, not three per-field Updates.
    expect(row).toHaveLength(1);
    expect(created.id).toMatch(/^e_/);
    expect(row![0]!.subject_id).toBe(created.id);
    expect(rowFields(row!)).toMatchObject({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });
    expect(rowsByModel(updates, "membership")).toHaveLength(0);
  });
});

describe("draft membership — last_grant refusal", () => {
  const mkMember = (id: string, permissions: readonly string[], groupId = "g_1"): Entity =>
    platformEntity(id, "grant", { group_id: groupId, actor_id: "actor_1", permissions });

  it("delete() of the group's last capable member is refused with last_grant", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["grant.*"]));

    const error = await client.actions
      .deleteMembership({ id: "gm_1" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((r) => r.reason)).toEqual(["last_grant"]);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("update() emptying the group's only permission list is refused with last_grant", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["grant.*"]));

    const error = await client.actions
      .updateMembership({ id: "gm_1", patch: { permissions: [] } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections.map((r) => r.reason)).toEqual(["last_grant"]);
    expect(actionCalls(seen)).toHaveLength(0);
  });

  it("delete() of a non-last member still submits one Action", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(mkMember("gm_1", ["grant.*"]));
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
    await storage.entities.set(platformEntity("g_1", "group", { name: "Team" }));

    await client.actions.updateGroup({ id: "g_1", name: "Renamed" });

    const [row] = rowsByModel(updatesOf(seen), "group");
    expect(row).toHaveLength(1);
    // An atomic value is written whole, so a name patch replaces it.
    expect(row![0]).toMatchObject({
      subject_id: "g_1",
      component: "ebb/group",
      method: "replace",
    });
    expect(rowFields(row!)["name"]).toBe("Renamed");
  });

  it("group.delete emits one delete Update carrying no data", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(platformEntity("g_1", "group", { name: "Team" }));

    await client.actions.deleteGroup({ id: "g_1" });

    const updates = updatesOf(seen);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ subject_id: "g_1", method: "delete", data: null });
  });

  it("group.duplicate copies the row into the requested groups", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(platformEntity("g_src", "group", { name: "Team" }));

    const copy = await client.actions.duplicateGroup({ id: "g_src", groups: ["g_1"] });

    const updates = updatesOf(seen);
    const [put] = rowsByModel(updates, "group").filter((row) => row[0]!.subject_id === copy.id);
    expect(copy.id).toMatch(/^e_/);
    expect(put!.every((update) => update.method === "replace")).toBe(true);
    expect(rowFields(put!)["name"]).toBe("Team");
    const filed = rowsByModel(updates, "membership").filter(
      (row) => rowFields(row)["entity_id"] === copy.id,
    );
    expect(filed.map((row) => rowFields(row)["group_id"])).toEqual(["g_1"]);
    expect(actionCalls(seen)).toHaveLength(1);
  });

  it("membership.duplicate copies the member row onto the handle id", async () => {
    const { client, storage, seen } = await mkClient();
    await storage.entities.set(
      platformEntity("gm_src", "grant", {
        group_id: "g_1",
        actor_id: "actor_2",
        permissions: ["profile.*"],
      }),
    );

    const copy = await client.actions.duplicateMembership({ id: "gm_src" });

    const [put] = rowsByModel(updatesOf(seen), "grant");
    expect(put![0]!.subject_id).toBe(copy.id);
    expect(put!.every((update) => update.method === "replace")).toBe(true);
    expect(rowFields(put!)).toMatchObject({
      group_id: "g_1",
      actor_id: "actor_2",
      permissions: ["profile.*"],
    });
  });

  it("group.link merges one presence key on the group row", async () => {
    const { client, seen } = await mkClient();

    await client.actions.linkGroupLead({ id: "g_1", profileId: "profile_1" });

    const [relationships] = rowsByModel(updatesOf(seen), "link");
    expect(relationships![0]).toMatchObject({ subject_id: "g_1", method: "merge" });
    // The link's `type` is the source model the declaration names (`ebb`), not
    // the logical kind.
    expect(linkTargetsOf(relationships![0]!, "lead", "ebb")).toEqual(["profile_1"]);
  });

  it("group.unlink tombstones the live key on the group row", async () => {
    const { client, storage, seen } = await mkClient();
    const group = platformEntity("g_1", "group", { name: "Team" });
    await storage.entities.set({
      ...group,
      data: {
        fields: {
          ...group.data.fields,
          link: linkValue([{ as: "lead", type: "ebb", targetId: "profile_1" }]),
        },
      },
    });

    await client.actions.unlinkGroupLead({ id: "g_1" });

    const [relationships] = rowsByModel(updatesOf(seen), "link");
    expect(relationships![0]).toMatchObject({ subject_id: "g_1", method: "merge" });
    expect(linkLeavesOf(relationships![0]!, "lead", "ebb")).toMatchObject({
      profile_1: { value: null },
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

    const [groupRow] = rowsByModel(updatesOf(seen), "group");
    expect(rowFields(groupRow!)["name"]).toBe(42);
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

    const [memberRow] = rowsByModel(updatesOf(seen), "grant");
    expect(rowFields(memberRow!)["permissions"]).toBe(42);
  });
});

describe("system namespace exposure", () => {
  it("exposes group and membership, and no raw platform namespace", async () => {
    const { client } = await mkClient();

    const drafts: ActionDrafts<typeof schema> = await client.actions.inspectDrafts();
    expect(Object.keys(drafts)).toEqual(expect.arrayContaining(["group", "membership"]));
    // The four kinds share one model, so there is no `ebb` surface to address them through.
    expect(Object.keys(drafts)).not.toContain(EBB_MODEL_NAME);

    // A membership row scoping a group or a grant is meaningless, so the
    // membership verbs are not part of the runtime surface either.
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
    expect(rowsByModel(updates, "group")).toHaveLength(1);
    expect(rowsByModel(updates, "grant")).toHaveLength(1);
    expect(rowsByModel(updates, "profile")).toHaveLength(1);

    const membership = rowsByModel(updates, "membership");
    expect(membership).toHaveLength(1);
    expect(rowFields(membership[0]!)).toEqual({
      entity_id: result.member.id,
      group_id: result.team.id,
    });
  });
});

describe("defineAction — addToWorkspace", () => {
  it("composes a grant put and a profile membership put in one Action", async () => {
    const { client, seen } = await mkClientWith({ ...systemActions, addToWorkspace });

    await client.actions.addToWorkspace({
      profileId: "profile_1",
      groupId: "g_1",
      permissions: ["profile.*"],
    });

    const updates = updatesOf(seen);
    expect(actionCalls(seen)).toHaveLength(1);
    expect(rowsByModel(updates, "grant")).toHaveLength(1);

    const membership = rowsByModel(updates, "membership");
    expect(membership).toHaveLength(1);
    expect(rowFields(membership[0]!)).toEqual({
      entity_id: "profile_1",
      group_id: "g_1",
    });
  });
});

describe("client.group read path", () => {
  it("returns null for an absent id and round-trips a stored group row", async () => {
    const { client, storage } = await mkClient();

    expect(await client.group.get("g_absent")).toBeNull();

    const groupRow = platformEntity("g_1", "group", { name: "Team" });
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
  it("rejects an undeclared field on create", async () => {
    const { client } = await mkClient();

    // Never invoked: the @ts-expect-error lines below are the assertion.
    const guard = (): void => {
      // @ts-expect-error — `bogus` is not part of the grant value.
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
