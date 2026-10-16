/**
 * End-to-end tests for the `group` / `groupMember` system namespaces
 * (#465) — the imperative bootstrap `create`, the atomic drafts, and
 * the `defineAction` recipe that composes a `groupMember` put with an
 * `entityGroup` put in one Action.
 *
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action and assert the wire shape. `entityGroup` stays
 * internal: no namespace, no draft handle, and no bootstrap row for the
 * group itself.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action, type Entity } from "@ebbjs/core";
import type { TSchema } from "@sinclair/typebox/type";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import type { GroupMemberFields } from "../../schema/system-entities";
import { defineAction, type AnyActionDef } from "../../schema/action";
import { createClient } from "../client";

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
            permissions: ["profile.*", "group.*", "groupMember.*"],
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
const schema = defineSchema({ entities: { profile }, version: 1 });

/** #441's `addToWorkspace`: a membership put plus the profile's membership row, one Action. */
const addToWorkspace = defineAction(
  schema,
  (
    { groupMember, profile: profileDraft },
    params: { profileId: string; groupId: string; permissions: string[] },
  ) => {
    groupMember.create({
      group_id: params.groupId,
      actor_id: "actor_1",
      permissions: params.permissions,
    });
    profileDraft.addToGroup(params.profileId, params.groupId);
  },
);

const mkClient = async <TActions extends Record<string, AnyActionDef>>(actions?: TActions) => {
  const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
  const storage = createMemoryAdapter();
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema,
    actions,
    fetchImpl: mkRecordingFetch(seen),
  });
  await client.handshake();
  return { client, storage, seen };
};

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

describe("client.group.create — bootstrap", () => {
  it("submits one Action with the group put and the actor's own groupMember put", async () => {
    const { client, seen } = await mkClient();

    const created = await client.group.create({ name: "Team" });

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

    await client.group.create({ name: "Team" });

    const memberPut = updatesOf(seen).find((u) => u.subject_type === "groupMember")!;
    const permissions = fieldsOf(memberPut)["permissions"] as readonly string[];
    expect(permissions).toContain("profile.*");
    expect(permissions).toContain("group.*");
    expect(permissions).toContain("groupMember.*");
    expect(permissions).toContain("relationship.*");
  });
});

describe("client.groupMember.create", () => {
  it("submits one Action with a single groupMember put and no entityGroup row", async () => {
    const { client, seen } = await mkClient();

    const created = await client.groupMember.create({
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

describe("system namespace exposure", () => {
  it("keeps `entityGroup` internal — no namespace, no draft handle", async () => {
    const { client } = await mkClient();

    expect((client as unknown as Record<string, unknown>)["entityGroup"]).toBeUndefined();

    const drafts = await client.atomic((d) => d);
    expect(Object.keys(drafts)).not.toContain("entityGroup");
    expect(Object.keys(drafts)).toEqual(expect.arrayContaining(["group", "groupMember"]));

    // An entityGroup row scoping a group or a member is meaningless, so
    // the membership verbs are not part of the runtime surface either.
    const group = client.group as unknown as Record<string, unknown>;
    expect(group["addToGroup"]).toBeUndefined();
    expect(group["removeFromGroup"]).toBeUndefined();
    expect(group["setGroups"]).toBeUndefined();
    const member = client.groupMember as unknown as Record<string, unknown>;
    expect(member["addToGroup"]).toBeUndefined();
  });
});

describe("client.atomic — system drafts", () => {
  it("composes the bootstrap with a content create into one Action", async () => {
    const { client, seen } = await mkClient();

    const result = await client.atomic(({ group, profile: profileDraft }) => {
      const team = group.create({ name: "Team" });
      return {
        team,
        member: profileDraft.create({ name: "Drew" }, { groups: [team] }),
      };
    });

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
    const { client, seen } = await mkClient({ addToWorkspace });

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

    await storage.entities.set(mkEntity("g_1", "group", { name: "Team" }));
    const row = await client.group.get("g_1");
    expect(row?.id).toBe("g_1");
    expect(row?.name).toBe("Team");

    const rows = await client.group.query();
    expect(rows.map((r) => r.name)).toEqual(["Team"]);
  });
});

describe("client.groupMember typing", () => {
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
      // @ts-expect-error — `bogus` is not declared on groupMember.
      void client.groupMember.create({ bogus: 1 });
    };
    expect(guard).toBeTypeOf("function");

    const draftGuard = (): void => {
      // @ts-expect-error — `bogus` is not declared on the group draft shape.
      void client.atomic(({ group }) => group.create({ bogus: 1 }));
    };
    expect(draftGuard).toBeTypeOf("function");
  });
});
