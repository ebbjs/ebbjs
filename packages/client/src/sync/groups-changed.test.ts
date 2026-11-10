/**
 * Live membership reconcile (#734).
 *
 * The server pushes `event: control` with `{"groups_changed": true,
 * "reason": "membership"}` and no delta. The client re-handshakes for the
 * authoritative set and reconciles the live subscription: a gained group is
 * seeded and followed, a lost group leaves and its rows are evicted, an
 * unchanged membership leaves an explicitly chosen subset alone, and an
 * event lost with the dropped stream is still reconciled on reconnect.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";

import { createClient } from "./client";
import type { EntityResponse, SSEEvent } from "./types";
import { isListingRequest, jsonResponse, waitFor } from "./test-utils";

const HLC = makeHlc(1711036800000);

/** The control event the server pushes on a membership change. */
const groupsChangedChunk = (): string =>
  `event: control\ndata: ${JSON.stringify({ groups_changed: true, reason: "membership" })}\n\n`;

const behindWatermarkChunk = (catchUpFrom: number): string =>
  `event: control\ndata: ${JSON.stringify({
    reconnect: true,
    reason: "behind_watermark",
    catchUpFrom,
  })}\n\n`;

/** A wire row as the group listing returns it. */
const wire = (opts: {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  lastGsn: number;
}): EntityResponse => ({
  id: opts.id,
  type: opts.type,
  data: {
    fields: Object.fromEntries(
      Object.entries(opts.fields).map(([key, value]) => [
        key,
        { value, update_id: `u_${opts.id}_${key}`, hlc: HLC },
      ]),
    ),
  },
  created_hlc: HLC,
  updated_hlc: HLC,
  deleted_hlc: null,
  last_gsn: opts.lastGsn,
});

const membership = (
  id: string,
  entityId: string,
  groupId: string,
  lastGsn: number,
): EntityResponse =>
  wire({ id, type: "entityGroup", fields: { entity_id: entityId, group_id: groupId }, lastGsn });

const listingPage = (opts: {
  groupId: string;
  watermark: number;
  entities: readonly EntityResponse[];
}): Response =>
  jsonResponse({
    group_id: opts.groupId,
    watermark: opts.watermark,
    cursor: null,
    has_more: false,
    entities: [...opts.entities],
  });

const putAction = (opts: { id: string; gsn: number; entityId: string; title: string }): Action => {
  const hlc = makeHlc(1711036800000, opts.gsn);
  return {
    id: opts.id,
    actor_id: "a_peer",
    hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: `${`u_${opts.id}`}_0`,
        subject_id: opts.entityId,
        component: "blog_post/title",
        method: "replace",
        data: { value: opts.title, update_id: `u_${opts.id}_title`, hlc },
      },
    ],
  };
};

interface ServerOptions {
  readonly groups?: readonly string[];
  readonly cursor?: number;
  readonly listing?: (groupId: string) => Response;
  readonly catchUp?: (groupId: string, offset: number) => Response;
}

/**
 * A path-dispatching server mock. `groups` is mutable so a test can change
 * the actor's membership between the handshake and the control event, and
 * every `/sync/live` response is an open stream the test pushes into.
 */
const mkServer = (opts: ServerOptions = {}) => {
  const encoder = new TextEncoder();
  const state = { groups: [...(opts.groups ?? ["g_1"])] };
  const handshakeBodies: { cursors?: Record<string, number> }[] = [];
  const listingGroups: string[] = [];
  const catchUpOffsets: { groupId: string; offset: number }[] = [];
  const liveUrls: string[] = [];
  const liveControllers: ReadableStreamDefaultController<Uint8Array>[] = [];

  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/sync/handshake")) {
      handshakeBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as { cursors?: Record<string, number> },
      );
      return jsonResponse({
        actor_id: "a_self",
        groups: state.groups.map((id) => ({
          id,
          apps: null,
          permissions: ["blog_post.*", "entityGroup.*"],
          cursor_valid: true,
          reason: null,
          cursor: opts.cursor ?? 0,
        })),
      });
    }
    if (isListingRequest(url)) {
      const parsed = new URL(url);
      const groupId = parsed.pathname.split("/")[3] ?? "";
      listingGroups.push(groupId);
      return opts.listing?.(groupId) ?? listingPage({ groupId, watermark: 0, entities: [] });
    }
    if (url.includes("/sync/groups/")) {
      const parsed = new URL(url);
      const groupId = parsed.pathname.split("/")[3] ?? "";
      const offset = Number(parsed.searchParams.get("offset") ?? "0");
      catchUpOffsets.push({ groupId, offset });
      return opts.catchUp?.(groupId, offset) ?? jsonResponse([], { "stream-up-to-date": "true" });
    }
    if (url.includes("/sync/live")) {
      liveUrls.push(url);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            liveControllers.push(controller);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.includes("/sync/actions")) return jsonResponse({ rejected: [] });
    if (url.includes("/entities/")) return new Response("not found", { status: 404 });
    return jsonResponse({});
  }) as unknown as typeof fetch;

  const push = (index: number, chunk: string): void => {
    const controller = liveControllers[index];
    if (controller === undefined) throw new Error(`no live stream ${index}`);
    controller.enqueue(encoder.encode(chunk));
  };

  return {
    state,
    fetchImpl,
    handshakeBodies,
    listingGroups,
    catchUpOffsets,
    liveUrls,
    liveControllers,
    push,
  };
};

const mkClient = (server: ReturnType<typeof mkServer>) =>
  createClient({
    serverUrl: "http://localhost:4000",
    actorId: "a_self",
    fetchImpl: server.fetchImpl,
    reconnectInitialMs: 1,
    reconnectMaxMs: 5,
    replicaSaveIntervalMs: 0,
  });

const activeGroups = (client: ReturnType<typeof createClient>): string[] =>
  (client as unknown as { activeSub: { groupIds: string[] } | null }).activeSub?.groupIds ?? [];

const replicaScope = (client: ReturnType<typeof createClient>): string[] => [
  ...(client as unknown as { replicaScope: Set<string> }).replicaScope,
];

const titleOf = (
  row: { data?: { fields?: Record<string, unknown> } } | null | undefined,
): unknown => (row?.data?.fields?.title as { value?: unknown } | undefined)?.value;

describe("groups_changed control event (#734)", () => {
  it("seeds a gained group and keeps receiving its Actions without a reload", async () => {
    let liveActions: Action[] = [];
    const server = mkServer({
      groups: ["g_1"],
      listing: (groupId) =>
        groupId === "g_new"
          ? listingPage({
              groupId,
              watermark: 40,
              entities: [
                membership("eg_new", "post_new", "g_new", 4),
                wire({
                  id: "post_new",
                  type: "blog_post",
                  fields: { title: "Seeded" },
                  lastGsn: 3,
                }),
              ],
            })
          : listingPage({ groupId, watermark: 0, entities: [] }),
      catchUp: (groupId, offset) => {
        const actions = groupId === "g_new" && offset === 40 ? liveActions : [];
        return jsonResponse(actions, {
          "stream-next-offset": String(actions.reduce((max, a) => Math.max(max, a.gsn), 0)),
          "stream-up-to-date": "true",
        });
      },
    });
    const client = mkClient(server);
    const events: SSEEvent[] = [];

    await client.handshake();
    const unsubscribe = client.subscribe(["g_1"], (event) => events.push(event));
    await waitFor(() => server.liveUrls.length === 1);
    await waitFor(() => client.state === "live");

    server.state.groups = ["g_1", "g_new"];
    server.push(0, groupsChangedChunk());

    // The client re-handshakes and the reconcile makes the gained group part
    // of the subscription, so the reconnect loop seeds it from the listing.
    await waitFor(() => server.listingGroups.includes("g_new"));
    await waitFor(async () => titleOf(await client.readLocalEntity("post_new")) === "Seeded");
    await waitFor(() => server.liveUrls.length === 2);

    expect(server.liveUrls[1]).toContain("g_new");
    expect(activeGroups(client)).toEqual(["g_1", "g_new"]);
    expect(replicaScope(client).sort()).toEqual(["g_1", "g_new"]);
    expect(events.some((event) => event.type === "control")).toBe(true);

    // The wider stream keeps delivering the gained group's Actions.
    server.push(
      1,
      `event: data\ndata: ${JSON.stringify(
        putAction({ id: "act_new", gsn: 45, entityId: "post_new", title: "Live" }),
      )}\n\n`,
    );
    await waitFor(async () => titleOf(await client.readLocalEntity("post_new")) === "Live");

    unsubscribe();
    client.close();
  });

  it("evicts a removed group's rows and drops it from the subscription", async () => {
    const server = mkServer({
      groups: ["g_1", "g_2"],
      listing: (groupId) =>
        groupId === "g_2"
          ? listingPage({
              groupId,
              watermark: 20,
              entities: [
                membership("eg_2", "post_2", "g_2", 4),
                wire({
                  id: "post_2",
                  type: "blog_post",
                  fields: { title: "Resident" },
                  lastGsn: 3,
                }),
              ],
            })
          : listingPage({ groupId, watermark: 0, entities: [] }),
    });
    const client = mkClient(server);

    await client.handshake();
    const unsubscribe = client.subscribe(["g_1", "g_2"], () => {});
    await waitFor(async () => titleOf(await client.readLocalEntity("post_2")) === "Resident");
    await waitFor(() => client.state === "live");

    server.state.groups = ["g_1"];
    server.push(0, groupsChangedChunk());

    await waitFor(() => server.liveUrls.length === 2);
    await waitFor(() => activeGroups(client).join(",") === "g_1");
    await waitFor(() => client.replica.get("post_2") === undefined);

    expect(server.liveUrls[1]).not.toContain("g_2");
    expect(replicaScope(client)).toEqual(["g_1"]);
    expect(client.replica.get("post_2")).toBeUndefined();

    unsubscribe();
    client.close();
  });

  it("leaves an explicitly chosen subset alone when membership did not change", async () => {
    const server = mkServer({ groups: ["g_1", "g_2"] });
    const client = mkClient(server);

    await client.handshake();
    // g_1 is the subset the app wants; g_extra was never in the membership.
    const unsubscribe = client.subscribe(["g_1", "g_extra"], () => {});
    await waitFor(() => client.state === "live");

    // The actor belongs to g_2 too, but the app subscribed to g_1 only.
    server.push(0, groupsChangedChunk());
    server.push(0, groupsChangedChunk());
    await waitFor(() => server.handshakeBodies.length >= 3);

    expect(activeGroups(client)).toEqual(["g_1", "g_extra"]);
    expect(replicaScope(client)).toEqual(["g_1", "g_extra"]);
    // No reconnect: the subscription did not change.
    expect(server.liveUrls).toHaveLength(1);

    unsubscribe();
    client.close();
  });

  it("learns the membership without widening a subscription made before any handshake", async () => {
    const server = mkServer({ groups: ["g_1", "g_2"] });
    const client = mkClient(server);

    // No handshake yet, so there is no previous set to diff against.
    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(() => client.state === "live");

    server.push(0, groupsChangedChunk());
    await waitFor(() => server.handshakeBodies.length === 1);

    // The handshake runs (the write path and cursor cache need it) but the
    // caller's explicit set stands: nothing is known to have been gained.
    expect(activeGroups(client)).toEqual(["g_1"]);
    expect(server.liveUrls).toHaveLength(1);

    unsubscribe();
    client.close();
  });

  it("reconciles a silent membership change on the next reconnect", async () => {
    const server = mkServer({
      groups: ["g_1"],
      listing: (groupId) =>
        groupId === "g_new"
          ? listingPage({
              groupId,
              watermark: 40,
              entities: [
                membership("eg_new", "post_new", "g_new", 4),
                wire({
                  id: "post_new",
                  type: "blog_post",
                  fields: { title: "Seeded" },
                  lastGsn: 3,
                }),
              ],
            })
          : listingPage({ groupId, watermark: 0, entities: [] }),
    });
    const client = mkClient(server);

    await client.handshake();
    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(() => client.state === "live");

    // The membership changed but its `groups_changed` event was lost; the
    // stream drops and the server asks for a stale-cursor restart instead.
    server.state.groups = ["g_1", "g_new"];
    server.push(0, behindWatermarkChunk(0));

    await waitFor(() => server.liveUrls.length === 2);
    await waitFor(async () => titleOf(await client.readLocalEntity("post_new")) === "Seeded");

    expect(server.liveUrls[1]).toContain("g_new");
    expect(activeGroups(client)).toEqual(["g_1", "g_new"]);

    unsubscribe();
    client.close();
  });

  it("keeps the behind_watermark resume point across the reconnect handshake", async () => {
    const missed = putAction({ id: "act_missed", gsn: 6, entityId: "post_1", title: "Missed" });
    const server = mkServer({
      groups: ["g_1"],
      // The server's own cursor is stale; the control event widens the window.
      cursor: 0,
      catchUp: (_groupId, offset) =>
        offset === 5
          ? jsonResponse([missed], { "stream-next-offset": "6", "stream-up-to-date": "true" })
          : jsonResponse([], { "stream-up-to-date": "true" }),
    });
    const client = mkClient(server);

    await client.handshake();
    const unsubscribe = client.subscribe(["g_1"], () => {});
    await waitFor(() => client.state === "live");

    server.push(0, behindWatermarkChunk(5));

    await waitFor(async () => titleOf(await client.readLocalEntity("post_1")) === "Missed");

    // The reconnect refresh handshakes, but the stale-cursor window wins:
    // the handshake advertises the persisted resume point and catch-up
    // starts from it, not from the server's older cursor.
    expect(server.catchUpOffsets).toContainEqual({ groupId: "g_1", offset: 5 });
    expect(server.handshakeBodies.at(-1)?.cursors).toEqual({ g_1: 5 });
    expect(server.liveUrls.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
    client.close();
  });
});
