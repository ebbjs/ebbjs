/**
 * Content backfill for membership rows naming unknown entities (#475).
 *
 * The module-level tests pin the reconciliation and the log-derived
 * persistence; the client tests pin the automatic triggers — catch-up
 * for a cold member, a live `entityGroup` put for an entity moved into
 * a group.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { makeHlc, type Action, type Entity } from "@ebbjs/core";

import { createClient } from "../client";
import {
  collectBackfillCandidates,
  createBackfill,
  snapshotAction,
  toRuntimeEntity,
} from "../backfill";
import {
  callApplyAction,
  closingSseResponse,
  jsonResponse,
  openSseResponse,
  waitFor,
} from "../test-utils";

const HLC = makeHlc(1711036800000);

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        { value, update_id: `u_${key}`, hlc: HLC },
      ]),
    ),
  },
  created_hlc: HLC,
  updated_hlc: HLC,
  deleted_hlc: null,
  last_gsn: 1,
});

/** A content `put` as the server would deliver it for a peer's write. */
const putAction = (opts: {
  actionId: string;
  gsn: number;
  entityId: string;
  entityType: string;
  fields: Record<string, unknown>;
  hlc?: string;
}): Action => {
  const hlc = opts.hlc ?? HLC;
  const updateId = `u_${opts.actionId}`;
  return {
    id: opts.actionId,
    actor_id: "a_peer",
    hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: updateId,
        subject_id: opts.entityId,
        subject_type: opts.entityType,
        method: "put",
        data: {
          fields: Object.fromEntries(
            Object.entries(opts.fields).map(([key, value]) => [
              key,
              { value, update_id: `${updateId}_${key}`, hlc },
            ]),
          ),
        },
      },
    ],
  };
};

/** The g_2-scoped membership row a move delivers, without the entity. */
const membershipPut = (opts: {
  membershipId: string;
  entityId: string;
  groupId?: string;
  gsn?: number;
}): Action => {
  const updateId = `u_${opts.membershipId}`;
  return {
    id: `a_${opts.membershipId}`,
    actor_id: "a_peer",
    hlc: HLC,
    gsn: opts.gsn ?? 1,
    updates: [
      {
        id: updateId,
        subject_id: opts.membershipId,
        subject_type: "entityGroup",
        method: "put",
        data: {
          fields: {
            entity_id: { value: opts.entityId, update_id: updateId, hlc: HLC },
            group_id: { value: opts.groupId ?? "g_2", update_id: updateId, hlc: HLC },
          },
        },
      },
    ],
  };
};

/** A field `patch` delivered by a later write in the entity's new group. */
const patchAction = (opts: {
  actionId: string;
  gsn: number;
  entityId: string;
  entityType: string;
  fields: Record<string, unknown>;
  hlc?: string;
}): Action => {
  const hlc = opts.hlc ?? makeHlc(1711036800001);
  const updateId = `u_${opts.actionId}`;
  return {
    id: opts.actionId,
    actor_id: "a_peer",
    hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: updateId,
        subject_id: opts.entityId,
        subject_type: opts.entityType,
        method: "patch",
        data: {
          fields: Object.fromEntries(
            Object.entries(opts.fields).map(([key, value]) => [
              key,
              { value, update_id: `${updateId}_${key}`, hlc },
            ]),
          ),
        },
      },
    ],
  };
};

const maxGsn = (actions: readonly Action[]): number =>
  actions.reduce((max, action) => Math.max(max, action.gsn), 0);

/** Path-dispatching fetch: handshake, catch-up, live stream, entity read. */
const mkClient = (opts: {
  catchUp?: readonly Action[];
  entities?: Record<string, Entity>;
  live?: readonly string[];
}): { client: ReturnType<typeof createClient>; calls: string[] } => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/sync/handshake")) {
      return jsonResponse({
        actor_id: "a_self",
        groups: [
          {
            id: "g_2",
            permissions: ["blog_post.*", "entityGroup.*"],
            cursor_valid: true,
            reason: null,
            cursor: 0,
          },
        ],
      });
    }
    if (url.includes("/sync/groups/")) {
      const actions = opts.catchUp ?? [];
      return jsonResponse(actions, {
        "stream-next-offset": String(maxGsn(actions)),
        "stream-up-to-date": "true",
      });
    }
    if (url.includes("/sync/live")) {
      return opts.live === undefined ? openSseResponse() : closingSseResponse([...opts.live]);
    }
    if (url.includes("/entities/")) {
      const id = decodeURIComponent(url.split("/entities/")[1] ?? "");
      const entity = opts.entities?.[id];
      if (entity === undefined) return new Response("not found", { status: 404 });
      return jsonResponse(entity);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "a_self",
    fetchImpl,
  });
  return { client, calls };
};

const dataEvent = (action: Action): string => `event: data\ndata: ${JSON.stringify(action)}\n\n`;

describe("collectBackfillCandidates", () => {
  it("names referenced entities the cache does not hold", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    await storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "post_2", group_id: "g_2" }),
    );
    await storage.entities.set(mkEntity("post_2", "blog_post", { title: "known" }));
    // A tombstone is a known entity, not a backfill candidate.
    await storage.entities.set({
      ...mkEntity("post_3", "blog_post", {}),
      deleted_hlc: HLC,
    });

    expect(await collectBackfillCandidates(storage)).toEqual(["post_1"]);
  });
});

describe("createBackfill", () => {
  it("writes a fetched entity as a snapshot that survives a log replay", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    const fetches: string[] = [];
    const backfill = createBackfill({
      storage,
      fetchEntity: async (entityId) => {
        fetches.push(entityId);
        return mkEntity("post_1", "blog_post", { title: "Hello" });
      },
    });

    await backfill.run();

    expect(fetches).toEqual(["post_1"]);
    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("Hello");
    // The synthetic base sorts under every delivered Action.
    expect((await storage.actions.getForEntity("post_1"))[0]?.gsn).toBe(0);

    // Reload: drop the cache and re-derive from the durable log alone.
    await storage.entities.reset();
    await storage.dirtyTracker.mark("post_1", "blog_post");
    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("Hello");
  });

  it("leaves an absent entity absent and appends nothing", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    const backfill = createBackfill({ storage, fetchEntity: async () => null });

    await backfill.run();

    expect(await storage.entities.get("post_1")).toBeNull();
    expect(await storage.actions.getForEntity("post_1")).toEqual([]);
  });

  it("keeps a local row that lands while the read is in flight", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    let release: ((entity: Entity) => void) | undefined;
    const backfill = createBackfill({
      storage,
      fetchEntity: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const run = backfill.run();
    await waitFor(() => backfill.pending.get().includes("post_1"));
    await storage.entities.set(mkEntity("post_1", "blog_post", { title: "Local" }));
    release?.(mkEntity("post_1", "blog_post", { title: "Server" }));
    await run;

    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("Local");
    expect(await storage.actions.getForEntity("post_1")).toEqual([]);
  });

  it("treats a fetched tombstone as absent", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    const backfill = createBackfill({
      storage,
      fetchEntity: async () => ({ ...mkEntity("post_1", "blog_post", {}), deleted_hlc: HLC }),
    });

    await backfill.run();

    expect(await storage.entities.get("post_1")).toBeNull();
    expect(await storage.actions.getForEntity("post_1")).toEqual([]);
  });

  it("publishes the in-flight ids and drains them", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    let release: ((entity: Entity) => void) | undefined;
    const backfill = createBackfill({
      storage,
      fetchEntity: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const run = backfill.run();
    await waitFor(() => backfill.pending.get().includes("post_1"));
    release?.(mkEntity("post_1", "blog_post", { title: "Hello" }));
    await run;

    expect(backfill.pending.get()).toEqual([]);
    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("Hello");
  });
});

describe("snapshotAction", () => {
  it("carries the canonical envelopes verbatim under gsn 0", () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Hello" });
    const action = snapshotAction(entity);

    expect(action.gsn).toBe(0);
    expect(action.hlc).toBe(entity.updated_hlc);
    expect(action.updates[0]?.method).toBe("put");
    expect(action.updates[0]?.data?.fields).toEqual(entity.data.fields);
  });
});

describe("toRuntimeEntity", () => {
  it("stringifies the numeric HLCs the JSON endpoint emits", () => {
    const entity = toRuntimeEntity({
      id: "post_1",
      type: "blog_post",
      data: {
        fields: { title: { value: "Hi", update_id: "u_1", hlc: 1700000000001 } },
      },
      created_hlc: 1700000000001,
      updated_hlc: 1700000000002,
      deleted_hlc: null,
      last_gsn: 3,
    });

    expect(entity.updated_hlc).toBe("1700000000002");
    expect((entity.data.fields.title as { hlc?: string }).hlc).toBe("1700000000001");
  });
});

describe("client backfill (#475)", () => {
  it("backfills an entity moved into a group the member can read", async () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Hello" });
    const { client } = mkClient({ entities: { post_1: entity } });
    await callApplyAction(
      client,
      membershipPut({ membershipId: "eg_1", entityId: "post_1" }),
      "g_2",
    );
    expect(await client.readLocalEntity("post_1")).toBeNull();

    await client.backfill();

    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("Hello");
  });

  it("backfills after catch-up delivers membership rows for unknown entities", async () => {
    const entities = {
      post_1: mkEntity("post_1", "blog_post", { title: "One" }),
      post_2: mkEntity("post_2", "blog_post", { title: "Two" }),
    };
    const { client } = mkClient({
      catchUp: [
        membershipPut({ membershipId: "eg_1", entityId: "post_1", gsn: 1 }),
        membershipPut({ membershipId: "eg_2", entityId: "post_2", gsn: 2 }),
      ],
      entities,
    });

    const unsubscribe = client.subscribe(["g_2"], 0, () => undefined);
    await waitFor(async () => (await client.readLocalEntity("post_1")) !== null);
    await waitFor(async () => (await client.readLocalEntity("post_2")) !== null);

    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("One");
    expect((await client.readLocalEntity("post_2"))?.data.fields.title?.value).toBe("Two");
    unsubscribe();
  });

  it("backfills on a live membership put", async () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Live" });
    const { client } = mkClient({
      entities: { post_1: entity },
      live: [dataEvent(membershipPut({ membershipId: "eg_1", entityId: "post_1" }))],
    });

    const unsubscribe = client.subscribe(["g_2"], 0, () => undefined);
    await waitFor(async () => (await client.readLocalEntity("post_1")) !== null);

    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("Live");
    unsubscribe();
  });

  it("survives a patch delivered before the backfill read", async () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Patched" });
    const { client } = mkClient({ entities: { post_1: entity } });
    await callApplyAction(
      client,
      membershipPut({ membershipId: "eg_1", entityId: "post_1", gsn: 1 }),
      "g_2",
    );
    await callApplyAction(
      client,
      patchAction({
        actionId: "act_patch",
        gsn: 2,
        entityId: "post_1",
        entityType: "blog_post",
        fields: { title: "Patched" },
      }),
      "g_2",
    );

    await client.backfill();

    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("Patched");
  });

  it("keeps the backfilled base across a cache reset", async () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Hello" });
    const { client } = mkClient({ entities: { post_1: entity } });
    await callApplyAction(
      client,
      membershipPut({ membershipId: "eg_1", entityId: "post_1" }),
      "g_2",
    );
    await client.backfill();

    await client.storage.entities.reset();
    await client.storage.dirtyTracker.mark("post_1", "blog_post");

    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("Hello");
  });

  it("does not resurrect an entity the server reports absent", async () => {
    const { client } = mkClient({ entities: {} });
    await callApplyAction(
      client,
      membershipPut({ membershipId: "eg_1", entityId: "post_1" }),
      "g_2",
    );

    await client.backfill();

    expect(await client.readLocalEntity("post_1")).toBeNull();
    expect(await client.storage.actions.getForEntity("post_1")).toEqual([]);
  });

  it("does not re-fetch an entity that already has a local row", async () => {
    const entity = mkEntity("post_1", "blog_post", { title: "Local" });
    const { client, calls } = mkClient({ entities: { post_1: entity } });
    await callApplyAction(
      client,
      membershipPut({ membershipId: "eg_1", entityId: "post_1" }),
      "g_2",
    );
    await client.storage.entities.set(entity);

    await client.backfill();

    expect(calls.some((url) => url.includes("/entities/post_1"))).toBe(false);
    expect((await client.readLocalEntity("post_1"))?.data.fields.title?.value).toBe("Local");
  });
});

describe("snapshot content merges under later writes", () => {
  it("lets a newer patch win over the backfilled base", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "post_1", group_id: "g_2" }),
    );
    const backfill = createBackfill({
      storage,
      fetchEntity: async () => mkEntity("post_1", "blog_post", { title: "Base" }),
    });
    await backfill.run();

    const newer = putAction({
      actionId: "act_newer",
      gsn: 5,
      entityId: "post_1",
      entityType: "blog_post",
      fields: { title: "Newer" },
      hlc: makeHlc(1711036800001),
    });
    await storage.actions.append(newer);

    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("Newer");
  });
});
