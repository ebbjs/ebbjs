/**
 * Cursor inference for the two-argument `subscribe(groupIds, onEvent)`
 * overload. The caller should not have to thread a cursor: the durable
 * storage cursor and the cursors cached by `handshake()` / `catchUp()`
 * already say where to resume, mirroring `catchUp(groupId)`.
 */

import { describe, it, expect, vi } from "vitest";

import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { emptyCatchUpResponse, jsonResponse, openSseResponse, waitFor } from "./test-utils";

const handshakeResponse = (groupId: string, cursor: number): Response =>
  jsonResponse({
    actor_id: "a_self",
    groups: [
      {
        id: groupId,
        permissions: ["read", "write"],
        cursor_valid: true,
        reason: null,
        cursor,
      },
    ],
  });

describe("SyncClient.subscribe inferred cursor", () => {
  it("resumes from the cursor cached by handshake", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/sync/handshake")) return handshakeResponse("grp_1", 7);
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    await client.handshake();
    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(calls.find((url) => url.includes("/sync/groups/"))).toContain("offset=7");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=7");

    unsubscribe();
  });

  it("resumes from the durable storage cursor when nothing is cached", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const storage = createMemoryAdapter();
    await storage.cursors.set("grp_1", 12);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      storage,
    });

    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(calls.find((url) => url.includes("/sync/groups/"))).toContain("offset=12");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=12");

    unsubscribe();
  });

  it("starts from cursor 0 when no cursor is known", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(calls.find((url) => url.includes("/sync/groups/"))).toContain("offset=0");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=0");

    unsubscribe();
  });

  it("throws a TypeError when no event callback is supplied", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(() => (client.subscribe as unknown as (groupIds: string[]) => void)(["grp_1"])).toThrow(
      TypeError,
    );

    client.close();
  });
});
