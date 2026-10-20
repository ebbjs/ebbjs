/**
 * Group listing seed (#476).
 *
 * The module tests pin the page mechanics: batching, the pinned watermark,
 * the resume marker, and the unsupported-server fallback. The client tests
 * pin what the seed is for — a group's view that the log alone cannot
 * describe — and the seams it has to respect: the tail's re-delivery guard,
 * the reset on an invalidated cursor, and the re-applied outbox.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { createClient } from "./client";
import { createGroupListing, listingSeedActionId, needsGroupListing } from "./group-listing";
import {
  callApplyAction,
  emptyCatchUpResponse,
  isListingRequest,
  jsonResponse,
  openSseResponse,
  waitFor,
} from "./test-utils";
import type { EntityResponse, GroupListingResponse } from "./types";

const HLC = makeHlc(1711036800000);
const NEWER = makeHlc(1711036800001);

/** A wire row as `GET /entities/:id` and the listing both return it. */
const wire = (opts: {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  lastGsn: number;
  hlc?: string;
}): EntityResponse => {
  const hlc = opts.hlc ?? HLC;
  return {
    id: opts.id,
    type: opts.type,
    data: {
      fields: Object.fromEntries(
        Object.entries(opts.fields).map(([key, value]) => [
          key,
          { value, update_id: `u_${opts.id}_${key}`, hlc },
        ]),
      ),
    },
    created_hlc: hlc,
    updated_hlc: hlc,
    deleted_hlc: null,
    last_gsn: opts.lastGsn,
  };
};

const membership = (
  id: string,
  entityId: string,
  groupId: string,
  lastGsn: number,
): EntityResponse =>
  wire({ id, type: "entityGroup", fields: { entity_id: entityId, group_id: groupId }, lastGsn });

/** One listing page, served by token (page 1 has no token). */
interface Page {
  readonly watermark: number;
  readonly entities: readonly EntityResponse[];
  /** Whether the server says another page follows; inferred from `pages`. */
  readonly hasMore?: boolean;
  /** Answer this page with a failure instead. */
  readonly status?: number;
}

/**
 * A path-dispatching fetch for one listing: token `"1"` is page 2, and so
 * on. Records the tokens it was asked for so a test can assert the redo
 * resumed at the pinned page rather than page 1.
 */
const listingFetch = (
  pages: readonly Page[],
  opts: { readonly failPage?: number } = {},
): { fetchImpl: typeof fetch; tokens: (string | null)[] } => {
  const tokens: (string | null)[] = [];
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!isListingRequest(url)) return jsonResponse({});
    const token = new URL(url).searchParams.get("cursor");
    tokens.push(token);
    const index = token === null ? 0 : Number(token);
    if (opts.failPage === index) throw new Error("boom");
    const page = pages[index];
    if (page === undefined) return jsonResponse({}, {});
    if (page.status !== undefined) return new Response("nope", { status: page.status });
    const last = index === pages.length - 1;
    const body: GroupListingResponse = {
      group_id: "g_1",
      watermark: page.watermark,
      cursor: last ? null : String(index + 1),
      has_more: page.hasMore ?? !last,
      entities: [...page.entities],
    };
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, tokens };
};

const mkListing = (
  storage: StorageAdapter,
  fetchImpl: typeof fetch,
  onAppended?: (count: number) => void,
) =>
  createGroupListing({
    serverUrl: "http://localhost:4000",
    actorId: "a_self",
    fetchImpl,
    storage,
    pageLimit: 2,
    onAppended: (entries) => onAppended?.(entries.length),
    // A deliberate failure is asserted by the test, not reported.
    onError: () => {},
  });

describe("needsGroupListing", () => {
  it("triggers on no cursor and on a seed in flight", () => {
    expect(needsGroupListing(null)).toBe(true);
    expect(needsGroupListing({})).toBe(true);
    expect(needsGroupListing({ seed: { group_id: "g_1" } })).toBe(true);
    expect(needsGroupListing({ cursor: 0 })).toBe(false);
    expect(needsGroupListing({ cursor: 5, through: 9 })).toBe(false);
    expect(needsGroupListing({ cursor: 5, seed: { group_id: "g_1", w: 5 } })).toBe(true);
  });
});

describe("bootstrapGroupListing", () => {
  it("seeds a page as one batch and completes the view at the watermark", async () => {
    const storage = createMemoryAdapter();
    const { fetchImpl } = listingFetch([
      {
        watermark: 40,
        entities: [
          wire({ id: "post_1", type: "blog_post", fields: { title: "One" }, lastGsn: 4 }),
          wire({ id: "post_2", type: "blog_post", fields: { title: "Two" }, lastGsn: 7 }),
        ],
      },
    ]);
    const batches: number[] = [];

    const result = await mkListing(storage, fetchImpl, (count) => batches.push(count)).bootstrap(
      "g_1",
    );

    expect(result).toEqual({ seeded: true, cursor: 40, supported: true, through: 7 });
    expect(batches).toEqual([2]);
    // One page, one append: the page is the unit that lands whole.
    const actions = await storage.actions.getAll();
    expect(actions.map((action) => action.id)).toEqual([
      listingSeedActionId("g_1", "post_1"),
      listingSeedActionId("g_1", "post_2"),
    ]);
    // The base sits at the row's own log position, not at W.
    expect(actions.map((action) => action.gsn)).toEqual([4, 7]);
    expect((await storage.entities.get("post_1"))?.data.fields.title?.value).toBe("One");
    // `cursor(G) = W` means the view is complete as of W; the marker is gone.
    expect(await storage.cursors.getRecord("g_1")).toEqual({ cursor: 40, through: 7 });
  });

  it("leaves a group whose view is already complete alone", async () => {
    const storage = createMemoryAdapter();
    await storage.cursors.set("g_1", 12);
    const { fetchImpl, tokens } = listingFetch([]);

    const result = await mkListing(storage, fetchImpl).bootstrap("g_1");

    expect(result).toEqual({ seeded: false, cursor: 12, supported: true, through: 0 });
    expect(tokens).toEqual([]);
  });

  it("pages with the server's token and keeps one watermark", async () => {
    const storage = createMemoryAdapter();
    const { fetchImpl, tokens } = listingFetch([
      {
        watermark: 40,
        entities: [wire({ id: "post_1", type: "blog_post", fields: { title: "One" }, lastGsn: 4 })],
      },
      {
        watermark: 40,
        entities: [wire({ id: "post_2", type: "blog_post", fields: { title: "Two" }, lastGsn: 9 })],
      },
    ]);

    const result = await mkListing(storage, fetchImpl).bootstrap("g_1");

    expect(tokens).toEqual([null, "1"]);
    expect(result).toMatchObject({ cursor: 40, through: 9 });
    expect(await storage.cursors.getRecord("g_1")).toEqual({ cursor: 40, through: 9 });
  });

  it("skips tombstoned rows the server should not have sent", async () => {
    const storage = createMemoryAdapter();
    const { fetchImpl } = listingFetch([
      {
        watermark: 40,
        entities: [
          {
            ...wire({ id: "post_1", type: "blog_post", fields: {}, lastGsn: 4 }),
            deleted_hlc: HLC,
          },
          wire({ id: "post_2", type: "blog_post", fields: { title: "Two" }, lastGsn: 7 }),
        ],
      },
    ]);

    await mkListing(storage, fetchImpl).bootstrap("g_1");

    expect((await storage.actions.getAll()).map((action) => action.id)).toEqual([
      listingSeedActionId("g_1", "post_2"),
    ]);
  });

  it("redoes from the marker's page at the pinned watermark", async () => {
    const storage = createMemoryAdapter();
    // A previous attempt seeded page 1 at W=40 and died before page 2.
    await storage.cursors.setRecord("g_1", {
      seed: { group_id: "g_1", w: 40, token: "1" },
    });
    // The server has moved on: a newer watermark, and page 2 at the old one.
    const { fetchImpl, tokens } = listingFetch([
      {
        watermark: 400,
        entities: [
          wire({ id: "post_1", type: "blog_post", fields: { title: "Moved" }, lastGsn: 4 }),
        ],
      },
      {
        watermark: 40,
        entities: [wire({ id: "post_2", type: "blog_post", fields: { title: "Two" }, lastGsn: 9 })],
      },
    ]);

    const result = await mkListing(storage, fetchImpl).bootstrap("g_1");

    // It resumed at page 2 and did not re-list page 1 at the new watermark:
    // a delete in (40, 400] must reach it through the tail.
    expect(tokens).toEqual(["1"]);
    expect(result.cursor).toBe(40);
    expect(await storage.cursors.getRecord("g_1")).toEqual({ cursor: 40, through: 9 });
  });

  it("keeps the marker and its folded bound when a page read fails mid-seed", async () => {
    const storage = createMemoryAdapter();
    const { fetchImpl } = listingFetch(
      [
        {
          watermark: 40,
          entities: [
            wire({ id: "post_1", type: "blog_post", fields: { title: "One" }, lastGsn: 4 }),
          ],
        },
        { watermark: 40, entities: [] },
      ],
      { failPage: 1 },
    );

    await expect(mkListing(storage, fetchImpl).bootstrap("g_1")).rejects.toThrow(/boom/);

    // Page 1's rows are durable and the marker pins the same W for the redo.
    // The folded bound is part of the marker: the page 1 rows it covers must
    // stay guarded after the redo resumes at page 2.
    expect(await storage.cursors.getRecord("g_1")).toEqual({
      seed: { group_id: "g_1", w: 40, token: "1" },
      through: 4,
    });
    expect((await storage.actions.getAll()).map((action) => action.id)).toEqual([
      listingSeedActionId("g_1", "post_1"),
    ]);
  });

  it("keeps the folded bound of pages seeded before a crash", async () => {
    const storage = createMemoryAdapter();
    const pages = [
      {
        watermark: 40,
        entities: [
          // Materialized after W, so its position is above the watermark.
          wire({ id: "post_1", type: "blog_post", fields: { title: "One" }, lastGsn: 100 }),
        ],
      },
      {
        watermark: 40,
        entities: [wire({ id: "post_2", type: "blog_post", fields: { title: "Two" }, lastGsn: 7 })],
      },
    ];

    await expect(
      mkListing(storage, listingFetch(pages, { failPage: 1 }).fetchImpl).bootstrap("g_1"),
    ).rejects.toThrow(/boom/);

    const result = await mkListing(storage, listingFetch(pages).fetchImpl).bootstrap("g_1");

    // Page 2's lower position must not lower the bound page 1 already set.
    expect(result.through).toBe(100);
    expect(await storage.cursors.getRecord("g_1")).toEqual({ cursor: 40, through: 100 });
  });

  it("does not claim a window it never pinned", async () => {
    const storage = createMemoryAdapter();
    // An earlier attempt died before it learned a watermark.
    await storage.cursors.setRecord("g_1", { seed: { group_id: "g_1" } });
    const { fetchImpl } = listingFetch([
      {
        watermark: 400,
        entities: [
          wire({ id: "post_1", type: "blog_post", fields: { title: "Late" }, lastGsn: 4 }),
        ],
      },
    ]);

    const result = await mkListing(storage, fetchImpl).bootstrap("g_1");

    // The rows are seeded, but the cursor stays at 0: the tail still covers
    // the window the lost attempt may have covered.
    expect(result.cursor).toBe(0);
    expect(await storage.cursors.getRecord("g_1")).toEqual({ cursor: 0, through: 4 });
  });

  it("falls back to the log path when the server has no listing endpoint", async () => {
    const storage = createMemoryAdapter();
    const { fetchImpl } = listingFetch([{ watermark: 40, entities: [], status: 404 }]);

    const result = await mkListing(storage, fetchImpl).bootstrap("g_1");

    expect(result.supported).toBe(false);
    expect(await storage.cursors.getRecord("g_1")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Client seams
// ---------------------------------------------------------------------------

interface ServerOptions {
  readonly groups?: readonly {
    id: string;
    cursorValid?: boolean;
    cursor?: number;
    permissions?: readonly string[];
  }[];
  readonly listing?: (groupId: string, token: string | null) => Response;
  readonly catchUp?: (groupId: string, offset: number) => Response;
  readonly live?: readonly string[];
  readonly entities?: Record<string, EntityResponse>;
}

/** A path-dispatching server mock that records what the client asked for. */
const mkServer = (opts: ServerOptions = {}) => {
  const calls: string[] = [];
  const listingTokens: { groupId: string; token: string | null }[] = [];
  const catchUpOffsets: { groupId: string; offset: number }[] = [];
  const handshakeBodies: { cursors?: Record<string, number> }[] = [];
  const groups = opts.groups ?? [{ id: "g_1" }];

  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.endsWith("/sync/handshake")) {
      handshakeBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as { cursors?: Record<string, number> },
      );
      return jsonResponse({
        actor_id: "a_self",
        groups: groups.map((group) => ({
          id: group.id,
          permissions: [...(group.permissions ?? ["blog_post.*", "entityGroup.*"])],
          cursor_valid: group.cursorValid ?? true,
          reason: group.cursorValid === false ? "behind_watermark" : null,
          cursor: group.cursor ?? 0,
        })),
      });
    }
    if (isListingRequest(url)) {
      const parsed = new URL(url);
      const groupId = parsed.pathname.split("/")[3] ?? "";
      const token = parsed.searchParams.get("cursor");
      listingTokens.push({ groupId, token });
      return opts.listing?.(groupId, token) ?? listingPage({ watermark: 0, entities: [] });
    }
    if (url.includes("/sync/groups/")) {
      const parsed = new URL(url);
      const groupId = parsed.pathname.split("/")[3] ?? "";
      const offset = Number(parsed.searchParams.get("offset") ?? "0");
      catchUpOffsets.push({ groupId, offset });
      return opts.catchUp?.(groupId, offset) ?? emptyCatchUpResponse();
    }
    if (url.includes("/sync/live")) {
      return opts.live === undefined ? openSseResponse() : closingResponse(opts.live);
    }
    if (url.includes("/sync/actions")) return jsonResponse({ rejected: [] });
    if (url.includes("/entities/")) {
      const id = decodeURIComponent(url.split("/entities/")[1] ?? "");
      const entity = opts.entities?.[id];
      return entity === undefined
        ? new Response("not found", { status: 404 })
        : jsonResponse(entity);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, listingTokens, catchUpOffsets, handshakeBodies };
};

const listingPage = (opts: {
  watermark: number;
  entities: readonly EntityResponse[];
  hasMore?: boolean;
  cursor?: string | null;
}): Response =>
  jsonResponse({
    group_id: "g_1",
    watermark: opts.watermark,
    cursor: opts.cursor ?? null,
    has_more: opts.hasMore ?? false,
    entities: [...opts.entities],
  });

const closingResponse = (chunks: readonly string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const mkClient = (server: ReturnType<typeof mkServer>, storage?: StorageAdapter) =>
  createClient({
    serverUrl: "http://localhost:4000",
    actorId: "a_self",
    fetchImpl: server.fetchImpl,
    storage,
  });

const catchUpActions = (actions: readonly Action[]): Response =>
  jsonResponse(actions, {
    "stream-next-offset": String(actions.reduce((max, action) => Math.max(max, action.gsn), 0)),
    "stream-up-to-date": "true",
  });

const putAction = (opts: {
  id: string;
  gsn: number;
  entityId: string;
  entityType?: string;
  fields: Record<string, unknown>;
  hlc?: string;
}): Action => {
  const hlc = opts.hlc ?? HLC;
  return {
    id: opts.id,
    actor_id: "a_peer",
    hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: `u_${opts.id}`,
        subject_id: opts.entityId,
        subject_type: opts.entityType ?? "blog_post",
        method: "put",
        data: {
          fields: Object.fromEntries(
            Object.entries(opts.fields).map(([key, value]) => [
              key,
              { value, update_id: `u_${opts.id}_${key}`, hlc },
            ]),
          ),
        },
      },
    ],
  };
};

const deleteAction = (opts: { id: string; gsn: number; entityId: string }): Action => ({
  id: opts.id,
  actor_id: "a_peer",
  hlc: NEWER,
  gsn: opts.gsn,
  updates: [
    {
      id: `u_${opts.id}`,
      subject_id: opts.entityId,
      subject_type: "blog_post",
      method: "delete",
      data: null,
    },
  ],
});

const titleOf = (
  row: { data?: { fields?: Record<string, unknown> } } | null | undefined,
): unknown => (row?.data?.fields?.title as { value?: unknown } | undefined)?.value;

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("SyncClient group listing", () => {
  it("seeds a cold group before catch-up and starts the tail at the watermark", async () => {
    const server = mkServer({
      listing: () =>
        listingPage({
          watermark: 40,
          entities: [
            wire({ id: "post_1", type: "blog_post", fields: { title: "Old" }, lastGsn: 3 }),
          ],
        }),
    });
    const client = mkClient(server);

    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(async () => (await client.readLocalEntity("post_1")) !== null);

    // Content that predates the entity's membership is exactly what the log
    // cannot supply; the seed is where it comes from.
    expect(titleOf(await client.readLocalEntity("post_1"))).toBe("Old");
    expect(server.catchUpOffsets).toEqual([{ groupId: "g_1", offset: 40 }]);
    expect(await client.storage.cursors.get("g_1")).toBe(40);
    // The replica carries the row without waiting for a log replay.
    expect(titleOf(client.replica.get("post_1"))).toBe("Old");

    unsubscribe();
    client.close();
  });

  it("converges with a full log replay on the rows both paths can derive", async () => {
    const ahead = [
      putAction({ id: "act_put", gsn: 45, entityId: "post_2", fields: { title: "V1" } }),
      {
        ...putAction({ id: "act_patch", gsn: 60, entityId: "post_2", fields: { title: "V2" } }),
        updates: [
          {
            id: "u_act_patch",
            subject_id: "post_2",
            subject_type: "blog_post",
            method: "patch" as const,
            data: {
              fields: { title: { value: "V2", update_id: "u_act_patch_title", hlc: NEWER } },
            },
          },
        ],
      },
    ];
    const server = mkServer({
      listing: () =>
        listingPage({
          watermark: 40,
          entities: [
            // Content predating membership: in the seed, never in the log.
            wire({ id: "post_1", type: "blog_post", fields: { title: "Old" }, lastGsn: 3 }),
            membership("eg_2", "post_2", "g_1", 4),
          ],
        }),
      catchUp: () => catchUpActions(ahead),
    });
    const seeded = mkClient(server);
    // A client whose base is complete as of 0 replays the whole tail instead.
    const replayedStorage = createMemoryAdapter();
    await replayedStorage.cursors.set("g_1", 0);
    const replayed = mkClient(server, replayedStorage);

    const unsubSeeded = seeded.subscribe(["g_1"], () => {});
    const unsubReplayed = replayed.subscribe(["g_1"], () => {});
    await waitFor(async () => (await seeded.storage.cursors.get("g_1")) === 60);
    await waitFor(async () => (await replayed.storage.cursors.get("g_1")) === 60);
    await tick();

    // Seed at W + tail equals the full replay for everything the group's
    // history carries; the seed adds only the pre-membership content.
    expect(seeded.replica.get("post_2")).toEqual(replayed.replica.get("post_2"));
    expect(titleOf(seeded.replica.get("post_1"))).toBe("Old");
    expect(replayed.replica.get("post_1")).toBeUndefined();

    unsubSeeded();
    unsubReplayed();
    seeded.close();
    replayed.close();
  });

  it("redoes a crashed seed at its pinned watermark, so a delete is not resurrected", async () => {
    const storage = createMemoryAdapter();
    // First attempt: page 1 committed, page 2 never returned.
    const crashed = listingFetch(
      [
        {
          watermark: 40,
          entities: [
            membership("eg_1", "post_1", "g_1", 4),
            wire({
              id: "post_1",
              type: "blog_post",
              fields: { title: "Live" },
              lastGsn: 3,
            }),
          ],
        },
        { watermark: 40, entities: [] },
      ],
      { failPage: 1 },
    );
    await expect(mkListing(storage, crashed.fetchImpl).bootstrap("g_1")).rejects.toThrow(/boom/);

    // The server has since deleted the entity and moved its watermark on.
    const server = mkServer({
      listing: () =>
        listingPage({ watermark: 400, entities: [membership("eg_2", "post_2", "g_1", 30)] }),
      catchUp: (_groupId, offset) =>
        offset === 40
          ? catchUpActions([deleteAction({ id: "act_delete", gsn: 45, entityId: "post_1" })])
          : emptyCatchUpResponse(),
    });
    const client = mkClient(server, storage);

    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(async () => (await client.storage.cursors.get("g_1")) === 45);
    await tick();

    // The redo resumed at page 2 with the pinned W, so the tail covered the
    // delete. A newer W would have skipped it and left the seeded row live.
    expect(server.catchUpOffsets).toContainEqual({ groupId: "g_1", offset: 40 });
    expect(titleOf(client.replica.get("post_1"))).toBe("Live");
    expect(client.replica.get("post_1")?.deleted_hlc).toBeTruthy();

    unsubscribe();
    client.close();
  });

  it("does not list a group whose view is already complete", async () => {
    const server = mkServer();
    const storage = createMemoryAdapter();
    await storage.cursors.set("g_1", 12);
    const client = mkClient(server, storage);

    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(() => server.catchUpOffsets.length > 0);

    expect(server.listingTokens).toEqual([]);
    expect(server.catchUpOffsets).toEqual([{ groupId: "g_1", offset: 12 }]);

    unsubscribe();
    client.close();
  });

  it("keeps a seeded row from regressing when the tail re-delivers it", async () => {
    const seeded = wire({
      id: "post_1",
      type: "blog_post",
      fields: { title: "Server state" },
      lastGsn: 100,
    });
    const server = mkServer({
      listing: () => listingPage({ watermark: 40, entities: [seeded] }),
      // The tail re-delivers an Action the seed already folded: folding it
      // would rewrite the row with an older state.
      catchUp: (_groupId, offset) =>
        offset === 40
          ? catchUpActions([
              putAction({ id: "act_old", gsn: 60, entityId: "post_1", fields: { title: "Older" } }),
            ])
          : emptyCatchUpResponse(),
    });
    const client = mkClient(server);

    const unsubscribe = client.subscribe(["g_1"], () => {});
    // The tail drained up to the re-delivered Action's GSN.
    await waitFor(async () => (await client.storage.cursors.get("g_1")) === 60);
    await tick();

    expect(titleOf(await client.readLocalEntity("post_1"))).toBe("Server state");
    expect(titleOf(client.replica.get("post_1"))).toBe("Server state");
    // The stale Action is not even logged: the row already holds it.
    expect((await client.storage.actions.getAll()).map((action) => action.id)).not.toContain(
      "act_old",
    );

    unsubscribe();
    client.close();
  });

  it("guards a row seeded by another group", async () => {
    const storage = createMemoryAdapter();
    // g_1 already had a complete view, so only g_2 is listed.
    await storage.cursors.set("g_1", 10);
    const seeded = wire({
      id: "post_1",
      type: "blog_post",
      fields: { title: "Server state" },
      lastGsn: 100,
    });
    const server = mkServer({
      listing: (groupId) =>
        groupId === "g_2"
          ? listingPage({ watermark: 40, entities: [seeded] })
          : listingPage({ watermark: 0, entities: [] }),
      // g_1's catch-up re-delivers a stale `put` for the shared row that g_2's
      // seed already folded. The delivering group has no seed bound.
      catchUp: (groupId, offset) =>
        groupId === "g_1" && offset === 10
          ? catchUpActions([
              putAction({ id: "act_old", gsn: 60, entityId: "post_1", fields: { title: "Older" } }),
            ])
          : emptyCatchUpResponse(),
    });
    const client = mkClient(server, storage);

    const unsubscribe = client.subscribe(["g_1", "g_2"], () => {});
    await waitFor(async () => (await storage.cursors.get("g_1")) === 60);
    await tick();

    expect(titleOf(await client.readLocalEntity("post_1"))).toBe("Server state");
    expect(titleOf(client.replica.get("post_1"))).toBe("Server state");

    unsubscribe();
    client.close();
  });

  it("guards a row seeded by a later group when the stream names another", async () => {
    const storage = createMemoryAdapter();
    await storage.cursors.set("g_1", 10);
    const seeded = wire({
      id: "post_1",
      type: "blog_post",
      fields: { title: "Server state" },
      lastGsn: 100,
    });
    const server = mkServer({
      listing: (groupId) =>
        groupId === "g_2"
          ? listingPage({ watermark: 40, entities: [seeded] })
          : listingPage({ watermark: 0, entities: [] }),
    });
    const client = mkClient(server, storage);

    const unsubscribe = client.subscribe(["g_1", "g_2"], () => {});
    await waitFor(async () => (await storage.cursors.get("g_2")) === 40);

    // The SSE path attributes an Action to the first subscribed group; the
    // seed that folded the row belongs to the second.
    await callApplyAction(
      client,
      putAction({ id: "act_old", gsn: 60, entityId: "post_1", fields: { title: "Older" } }),
      "g_1",
    );

    expect(titleOf(client.replica.get("post_1"))).toBe("Server state");

    unsubscribe();
    client.close();
  });

  it("keeps the re-delivery guard across a restart", async () => {
    const storage = createMemoryAdapter();
    const seeded = wire({
      id: "post_1",
      type: "blog_post",
      fields: { title: "Server state" },
      lastGsn: 100,
    });
    const first = mkClient(
      mkServer({ listing: () => listingPage({ watermark: 40, entities: [seeded] }) }),
      storage,
    );

    const unsubscribeFirst = first.subscribe(["g_1"], () => {});
    await waitFor(async () => (await storage.cursors.get("g_1")) === 40);
    unsubscribeFirst();
    // The seed persisted both the row and the bound the guard needs.
    await waitFor(async () => (await storage.replica.load()) !== null);
    first.close();

    const second = mkClient(
      mkServer({
        catchUp: () =>
          catchUpActions([
            putAction({ id: "act_old", gsn: 60, entityId: "post_1", fields: { title: "Older" } }),
          ]),
      }),
      storage,
    );
    // Driven through the plain catch-up surface, so the guard comes from the
    // hydrated resume record rather than from a bootstrap in this session.
    await second.catchUp("g_1");

    expect(await second.storage.cursors.get("g_1")).toBe(60);
    expect(titleOf(second.replica.get("post_1"))).toBe("Server state");

    second.close();
  });

  it("applies a delete that lands mid-pagination", async () => {
    let page = 0;
    const server = mkServer({
      listing: () => {
        page += 1;
        return page === 1
          ? listingPage({
              watermark: 40,
              cursor: "1",
              hasMore: true,
              entities: [
                membership("eg_1", "post_1", "g_1", 4),
                wire({ id: "post_1", type: "blog_post", fields: { title: "Live" }, lastGsn: 3 }),
              ],
            })
          : // The entity was deleted between the pages, so its row and its
            // membership are gone from the server's state.
            listingPage({ watermark: 40, entities: [] });
      },
      catchUp: (_groupId, offset) =>
        offset === 40
          ? catchUpActions([deleteAction({ id: "act_delete", gsn: 45, entityId: "post_1" })])
          : emptyCatchUpResponse(),
    });
    const client = mkClient(server);

    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(async () => (await client.storage.cursors.get("g_1")) === 45);
    await tick();

    // The delete is above W, so the tail owns it and the seeded row ends
    // deleted rather than resurrected by the listing.
    expect(await client.storage.cursors.get("g_1")).toBe(45);
    expect(client.replica.get("post_1")?.deleted_hlc).toBeTruthy();

    unsubscribe();
    client.close();
  });

  it("seeds an entity that belongs to several groups once per group", async () => {
    const shared = wire({
      id: "post_1",
      type: "blog_post",
      fields: { title: "Shared" },
      lastGsn: 100,
    });
    const server = mkServer({
      groups: [{ id: "g_1" }, { id: "g_2" }],
      listing: (groupId) =>
        listingPage({
          watermark: 40,
          entities: [membership(`eg_${groupId}`, "post_1", groupId, 4), shared],
        }),
    });
    const client = mkClient(server);

    const unsubscribe = client.subscribe(["g_1", "g_2"], () => {});
    await waitFor(() => server.catchUpOffsets.length === 2);
    await tick();

    expect(server.listingTokens.map((call) => call.groupId).sort()).toEqual(["g_1", "g_2"]);
    expect(titleOf(client.replica.get("post_1"))).toBe("Shared");
    // One membership per group in the local index: the entity is visible in
    // both groups, and the second seed's put is the same content.
    expect(client.replica.memberships({ entityId: "post_1" })).toEqual(["g_1", "g_2"]);

    unsubscribe();
    client.close();
  });

  it("keeps a cross-group Action's per-group copies merged in the log", async () => {
    const server = mkServer({
      groups: [{ id: "g_1" }, { id: "g_2" }],
      listing: (groupId) =>
        listingPage({
          watermark: 40,
          entities: [wire({ id: `${groupId}_doc`, type: "blog_post", fields: {}, lastGsn: 2 })],
        }),
      // #473: one Action, delivered once per group with only that group's
      // Updates.
      catchUp: (groupId, offset) =>
        offset === 40
          ? catchUpActions([
              {
                id: "act_cross",
                actor_id: "a_peer",
                hlc: HLC,
                gsn: 50,
                updates: [
                  {
                    id: `u_cross_${groupId}`,
                    subject_id: `${groupId}_doc`,
                    subject_type: "blog_post",
                    method: "patch",
                    data: { fields: { title: { value: groupId, update_id: "u_1", hlc: HLC } } },
                  },
                ],
              },
            ])
          : emptyCatchUpResponse(),
    });
    const client = mkClient(server);

    const unsubscribe = client.subscribe(["g_1", "g_2"], () => {});
    await waitFor(() => server.catchUpOffsets.length === 2);
    await tick();

    const cross = (await client.storage.actions.getAll()).filter(
      (action) => action.id === "act_cross",
    );
    expect(cross).toHaveLength(1);
    expect(cross[0]!.updates.map((update) => update.subject_id).sort()).toEqual([
      "g_1_doc",
      "g_2_doc",
    ]);
    expect(titleOf(client.replica.get("g_1_doc"))).toBe("g_1");
    expect(titleOf(client.replica.get("g_2_doc"))).toBe("g_2");

    unsubscribe();
    client.close();
  });

  it("keeps optimistic writes through the seed and the re-apply", async () => {
    const server = mkServer({
      listing: () =>
        listingPage({
          watermark: 40,
          entities: [
            wire({ id: "post_1", type: "blog_post", fields: { title: "Server" }, lastGsn: 30 }),
          ],
        }),
    });
    const storage = createMemoryAdapter();
    const client = mkClient(server, storage);
    await client.outbox.enqueue(
      putAction({
        id: "act_local",
        gsn: 0,
        entityId: "post_1",
        fields: { title: "Mine" },
        hlc: NEWER,
      }),
    );

    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(async () => (await client.readLocalEntity("post_1")) !== null);
    await tick();

    // The base landed, and the optimistic row sits on top of it in both the
    // replica and the async `entities` shim.
    expect((await client.storage.actions.getAll()).map((action) => action.id)).toContain(
      listingSeedActionId("g_1", "post_1"),
    );
    expect(titleOf(client.replica.get("post_1"))).toBe("Mine");
    expect(titleOf(await client.readLocalEntity("post_1"))).toBe("Mine");
    expect(await client.outbox.size("pending")).toBe(0);

    unsubscribe();
    client.close();
  });

  it("resets the local base and re-seeds every group on an invalid cursor", async () => {
    const storage = createMemoryAdapter();
    await storage.actions.append(
      putAction({ id: "act_stale", gsn: 900, entityId: "post_old", fields: { title: "Stale" } }),
    );
    await storage.cursors.set("g_1", 900);
    await storage.entities.get("post_old");
    const client = mkClient(
      mkServer({
        groups: [{ id: "g_1", cursorValid: false, cursor: 3 }],
        listing: () =>
          listingPage({
            watermark: 40,
            entities: [
              wire({ id: "post_1", type: "blog_post", fields: { title: "Fresh" }, lastGsn: 4 }),
            ],
          }),
      }),
      storage,
    );
    await client.outbox.enqueue(
      putAction({
        id: "act_local",
        gsn: 0,
        entityId: "post_1",
        fields: { title: "Mine" },
        hlc: NEWER,
      }),
    );

    await client.handshake();

    // Everything the old base held is gone; the user's write is kept.
    expect(await storage.actions.getAll()).toEqual([]);
    expect(await storage.cursors.get("g_1")).toBe(null);
    expect(replicaIds(client)).toEqual([]);
    expect((await storage.outbox.list()).map((entry) => entry.action.id)).toEqual(["act_local"]);

    // The next subscribe re-seeds the group from the listing.
    await client.subscribe(["g_1"], () => {});
    await waitFor(async () => (await client.readLocalEntity("post_1")) !== null);
    await tick();

    expect(await client.storage.cursors.get("g_1")).toBe(40);
    expect(titleOf(client.replica.get("post_1"))).toBe("Mine");

    client.close();
  });

  it("sends the persisted cursors with the handshake", async () => {
    const server = mkServer();
    const storage = createMemoryAdapter();
    await storage.cursors.set("g_1", 12);
    await storage.cursors.setRecord("g_2", { seed: { group_id: "g_2", w: 3 } });
    const client = mkClient(server, storage);

    await client.handshake();

    // A group mid-seed has no cursor yet: sending 0 would claim a view the
    // client never had.
    expect(server.handshakeBodies[0]?.cursors).toEqual({ g_1: 12 });

    client.close();
  });
});

const replicaIds = (client: ReturnType<typeof createClient>): string[] => {
  const ids: string[] = [];
  for (const type of Object.keys(client.replicaStats.byType)) {
    for (const row of client.replica.iterate(type)) ids.push(row.id);
  }
  return ids.sort();
};
