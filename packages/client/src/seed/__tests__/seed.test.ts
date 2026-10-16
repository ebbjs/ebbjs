/**
 * Unit tests for the shared seed layer (`@ebbjs/client/seed`).
 *
 * The seed is plain data → one Action, submitted either through the
 * free `seed()` POST or `client.seed()`. These tests pin the wire shape
 * of `buildSeedAction` and the one rejection-tolerance policy in
 * `assertSeedAccepted`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";

import {
  SeedRejectedError,
  assertSeedAccepted,
  buildSeedAction,
  isToleratedSeedRejection,
  seed,
  TOLERATED_SEED_REJECTIONS,
  type SeedData,
} from "../../seed";
import type { Rejection } from "../../sync/types";

const rejection = (reason: string): Rejection => ({ id: "action_1", reason });

/** A representative seed exercising every row kind. */
const buildRepresentativeSeed = (): SeedData => ({
  groups: [{ id: "grp_1", name: "Group One" }],
  groupMembers: [
    {
      id: "gm_1",
      actorId: "actor_1",
      groupId: "grp_1",
      permissions: ["todo.*", "list.*"],
    },
  ],
  entities: [
    {
      id: "todo_1",
      type: "todo",
      patches: [
        {
          fields: {
            title: { value: "Ship it", hlc: "1", update_id: "u1" },
          },
        },
      ],
    },
  ],
  relationships: [
    {
      id: "rel_1",
      sourceId: "todo_1",
      targetId: "list_1",
      type: "todo",
      field: "list",
    },
  ],
  entityGroups: [{ id: "eg_1", entityId: "todo_1", groupId: "grp_1" }],
});

describe("buildSeedAction", () => {
  it("builds one Action carrying every seed row as a put Update", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.actor_id).toBe("actor_1");
    expect(action.updates).toHaveLength(5);
    for (const update of action.updates) {
      expect(update.method).toBe("put");
    }

    const group = action.updates.find((u) => u.subject_type === "group")!;
    expect(group.subject_id).toBe("grp_1");
    expect(group.data?.fields?.["name"]?.value).toBe("Group One");

    const member = action.updates.find((u) => u.subject_type === "groupMember")!;
    expect(member.subject_id).toBe("gm_1");
    expect(member.data?.fields?.["actor_id"]?.value).toBe("actor_1");
    expect(member.data?.fields?.["group_id"]?.value).toBe("grp_1");
    expect(member.data?.fields?.["permissions"]?.value).toEqual(["todo.*", "list.*"]);

    const entity = action.updates.find((u) => u.subject_type === "todo")!;
    expect(entity.subject_id).toBe("todo_1");
    expect(entity.data?.fields?.["title"]?.value).toBe("Ship it");

    const relationship = action.updates.find((u) => u.subject_type === "relationship")!;
    expect(relationship.subject_id).toBe("rel_1");
    expect(relationship.data?.fields?.["source_id"]?.value).toBe("todo_1");
    expect(relationship.data?.fields?.["target_id"]?.value).toBe("list_1");
    expect(relationship.data?.fields?.["type"]?.value).toBe("todo");
    expect(relationship.data?.fields?.["field"]?.value).toBe("list");

    const entityGroup = action.updates.find((u) => u.subject_type === "entityGroup")!;
    expect(entityGroup.subject_id).toBe("eg_1");
    expect(entityGroup.data?.fields?.["entity_id"]?.value).toBe("todo_1");
    expect(entityGroup.data?.fields?.["group_id"]?.value).toBe("grp_1");
  });

  it("stamps hand-built rows with the seed update id", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());
    const group = action.updates.find((u) => u.subject_type === "group")!;
    expect(group.data?.fields?.["name"]?.update_id).toBe("seed_update");
    expect(typeof group.data?.fields?.["name"]?.hlc).toBe("string");
  });
});

describe("assertSeedAccepted", () => {
  it("defines the tolerance policy once", () => {
    expect([...TOLERATED_SEED_REJECTIONS]).toEqual(["already_exists", "duplicate_action"]);
    expect(isToleratedSeedRejection("already_exists")).toBe(true);
    expect(isToleratedSeedRejection("duplicate_action")).toBe(true);
    expect(isToleratedSeedRejection("not_authorized")).toBe(false);
    expect(isToleratedSeedRejection(undefined)).toBe(false);
  });

  it("passes tolerated rejections through", () => {
    expect(() => assertSeedAccepted([rejection("already_exists")])).not.toThrow();
    expect(() => assertSeedAccepted([rejection("duplicate_action")])).not.toThrow();
    expect(() => assertSeedAccepted([])).not.toThrow();
  });

  it("throws SeedRejectedError carrying the fatal rejections", () => {
    let thrown: unknown;
    try {
      assertSeedAccepted([rejection("already_exists"), rejection("not_authorized")]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeedRejectedError);
    expect((thrown as SeedRejectedError).rejections).toEqual([rejection("not_authorized")]);
  });
});

describe("seed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts one msgpack Action to /sync/actions with the actor header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ rejected: [] }), { status: 200 });
    });

    await seed("http://localhost:4000", "actor_1", buildRepresentativeSeed());

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://localhost:4000/sync/actions");
    expect(seen[0]!.init.method).toBe("POST");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["x-ebb-actor-id"]).toBe("actor_1");
    expect(headers["Content-Type"]).toBe("application/msgpack");

    const actions = decodeSync<{ actions: Action[] }>(seen[0]!.init.body as Uint8Array).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actor_id).toBe("actor_1");
    expect(actions[0]!.updates).toHaveLength(5);
  });

  it("resolves when the server tolerates a duplicate", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ rejected: [rejection("already_exists")] }), { status: 200 }),
    );

    await expect(seed("http://localhost:4000", "actor_1", buildRepresentativeSeed())).resolves.toBe(
      undefined,
    );
  });

  it("rejects with SeedRejectedError when a row is refused", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ rejected: [rejection("not_authorized")] }), { status: 200 }),
    );

    await expect(
      seed("http://localhost:4000", "actor_1", buildRepresentativeSeed()),
    ).rejects.toBeInstanceOf(SeedRejectedError);
  });

  it("rejects on a non-ok response", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));

    await expect(
      seed("http://localhost:4000", "actor_1", buildRepresentativeSeed()),
    ).rejects.toThrow(/Seed failed: 500/);
  });
});
