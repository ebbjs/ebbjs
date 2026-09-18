import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { decodeSync } from "@ebbjs/core";

/**
 * Tiny helper: a `fetch` mock that records calls and returns canned responses
 * from a FIFO queue. The last entry in the queue is returned for all
 * subsequent calls (so you can stash a "default" response and override).
 */
function makeFetchMock(
  responses: Array<{
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = queue.shift() ?? queue[queue.length - 1];
    if (!next) {
      throw new Error("fetchMock: no more responses queued");
    }
    const headers = new Headers(next.headers ?? {});
    return new Response((next.body ?? "") as BodyInit, {
      status: next.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("SyncClient.handshake", () => {
  it("returns group membership and caches cursors", async () => {
    const { fn } = makeFetchMock([
      {
        body: JSON.stringify({
          actor_id: "a_test",
          groups: [
            {
              id: "grp_1",
              permissions: ["read", "write"],
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
            {
              id: "grp_2",
              permissions: ["read"],
              cursor_valid: false,
              reason: "behind_watermark",
              cursor: 42,
            },
          ],
        }),
      },
    ]);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });

    const result = await client.handshake();
    expect(result.actorId).toBe("a_test");
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toEqual({
      id: "grp_1",
      permissions: ["read", "write"],
      cursorValid: true,
      reason: null,
      cursor: 0,
    });
    expect(result.groups[1].cursorValid).toBe(false);
    expect(result.groups[1].reason).toBe("behind_watermark");

    // Handshake should send POST to /sync/handshake with JSON body.
    const call = (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe("http://localhost:4000/sync/handshake");
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      cursors: {},
      schema_version: undefined,
    });
  });

  it("throws on non-2xx response", async () => {
    const { fn } = makeFetchMock([{ status: 401, body: '{"error":"unauthorized"}' }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    await expect(client.handshake()).rejects.toThrow(/handshake failed: 401/);
  });

  it("sends the x-ebb-actor-id header", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "alice",
      fetchImpl: fn,
    });
    await client.handshake();
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers["x-ebb-actor-id"]).toBe("alice");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("SyncClient.catchUp", () => {
  it("fetches actions and applies them to storage", async () => {
    const actions = [
      {
        id: "act_1",
        actor_id: "a_test",
        hlc: 1711036800000000,
        gsn: 1,
        updates: [
          {
            id: "u_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: "put",
            // User entities nest their fields under `data.fields` to mirror
            // `EbbServer.Storage.ActionValidator.well_formed_data?/1`.
            data: {
              fields: { title: { value: "Hello", update_id: "u_1", hlc: 1711036800000000 } },
            } as never,
          },
        ],
      },
      {
        id: "act_2",
        actor_id: "a_test",
        hlc: 1711036800000001,
        gsn: 2,
        updates: [
          {
            id: "u_2",
            subject_id: "todo_1",
            subject_type: "todo",
            method: "patch",
            data: {
              fields: { title: { value: "Updated", update_id: "u_2", hlc: 1711036800000001 } },
            } as never,
          },
        ],
      },
    ];

    const { fn, calls } = makeFetchMock([
      {
        body: JSON.stringify(actions),
        headers: {
          "stream-next-offset": "2",
          "stream-up-to-date": "true",
        },
      },
    ]);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });

    const result = await client.catchUp("grp_1", 0);
    expect(result.actions).toHaveLength(2);
    expect(result.nextOffset).toBe(2);
    expect(result.upToDate).toBe(true);

    // Storage should have materialized the entity.
    const entity = await client.readLocalEntity("todo_1");
    expect(entity).not.toBeNull();
    expect(entity!.data.fields.title).toMatchObject({ value: "Updated" });

    // Cursor should be advanced.
    expect(await client.storage.cursors.get("grp_1")).toBe(2);

    // URL should have the offset query string.
    expect(calls[0].url).toBe("http://localhost:4000/sync/groups/grp_1?offset=0");
  });

  it("uses the storage cursor when fromGsn is omitted", async () => {
    const { fn, calls } = makeFetchMock([{ body: "[]", headers: { "stream-up-to-date": "true" } }]);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    await client.storage.cursors.set("grp_1", 99);
    await client.catchUp("grp_1");
    expect(calls[0].url).toContain("offset=99");
  });

  it("marks up-to-date when no next-offset header is present", async () => {
    const { fn } = makeFetchMock([{ body: "[]" }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const result = await client.catchUp("grp_1", 0);
    expect(result.upToDate).toBe(true);
    expect(result.nextOffset).toBeNull();
  });

  it("translates 403 into a not-a-member error", async () => {
    const { fn } = makeFetchMock([{ status: 403, body: '{"error":"not_member"}' }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    await expect(client.catchUp("grp_x", 0)).rejects.toThrow(/not a member of group grp_x/);
  });
});

describe("SyncClient.write", () => {
  it("encodes actions as msgpack and parses rejections", async () => {
    let received: Uint8Array | undefined;
    const { fn } = makeFetchMock([
      {
        body: JSON.stringify({
          rejected: [{ id: "act_bad", reason: "permission_denied" }],
        }),
      },
    ]);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });

    const result = await client.write([
      {
        id: "act_ok",
        actor_id: "a_test",
        hlc: "1711036800000000",
        gsn: 0,
        updates: [
          {
            id: "u_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: "put",
            data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000000" } },
          },
        ],
      },
      {
        id: "act_bad",
        actor_id: "a_test",
        hlc: "1711036800000001",
        gsn: 0,
        updates: [
          {
            id: "u_2",
            subject_id: "todo_2",
            subject_type: "todo",
            method: "put",
            data: {},
          },
        ],
      },
    ]);

    expect(result.rejected).toEqual([{ id: "act_bad", reason: "permission_denied" }]);

    const call = (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/msgpack");
    expect((init.headers as Record<string, string>)["x-ebb-actor-id"]).toBe("a_test");
    received = init.body as unknown as Uint8Array;
    expect(received).toBeDefined();
    expect(received!.length).toBeGreaterThan(0);

    // Round-trip: the server should decode this same shape, so verify our
    // outgoing bytes match the encoded action.
    const decoded = decodeSync<{ actions: unknown[] }>(received!);
    expect(Array.isArray(decoded.actions)).toBe(true);
    expect(decoded.actions).toHaveLength(2);
  });

  it("returns empty rejection list when no actions are provided", async () => {
    const { fn } = makeFetchMock([]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const result = await client.write([]);
    expect(result.rejected).toEqual([]);
    // No fetch call should have been made.
    expect((fn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("throws on non-2xx response", async () => {
    const { fn } = makeFetchMock([{ status: 422, body: '{"error":"invalid_msgpack"}' }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    await expect(
      client.write([
        {
          id: "act_x",
          actor_id: "a_test",
          hlc: "1",
          gsn: 0,
          updates: [
            {
              id: "u_1",
              subject_id: "todo_1",
              subject_type: "todo",
              method: "put",
              data: {},
            },
          ],
        },
      ]),
    ).rejects.toThrow(/write failed: 422/);
  });
});

describe("SyncClient.getEntity and queryEntities", () => {
  it("fetches a single entity", async () => {
    const { fn, calls } = makeFetchMock([
      {
        body: JSON.stringify({
          id: "todo_1",
          type: "todo",
          data: { fields: { title: { value: "Hi", update_id: "u_1", hlc: "1" } } },
          created_hlc: "1",
          updated_hlc: "1",
          deleted_hlc: null,
          last_gsn: 1,
        }),
      },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const entity = await client.getEntity("todo_1");
    expect(entity?.id).toBe("todo_1");
    expect(entity?.type).toBe("todo");
    expect(calls[0].url).toContain("/entities/todo_1?actor_id=a_test");
  });

  it("returns null on 404", async () => {
    const { fn } = makeFetchMock([{ status: 404, body: '{"error":"not_found"}' }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    expect(await client.getEntity("missing")).toBeNull();
  });

  it("queries entities by type", async () => {
    const { fn, calls } = makeFetchMock([
      {
        body: JSON.stringify([
          {
            id: "todo_1",
            type: "todo",
            data: { fields: {} },
            created_hlc: "1",
            updated_hlc: "1",
            deleted_hlc: null,
            last_gsn: 1,
          },
        ]),
      },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const list = await client.queryEntities("todo", { limit: 10, offset: 0 });
    expect(list).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ type: "todo", filter: undefined, limit: 10, offset: 0 });
  });
});

describe("SyncClient connection state", () => {
  it("starts in connecting", () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    expect(client.state).toBe("connecting");
  });

  it("fires onStateChange with the current state on subscribe", async () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    await new Promise((r) => setTimeout(r, 10));
    expect(states).toEqual(["connecting"]);
  });

  it("returns an unsubscribe fn", async () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    const states: string[] = [];
    const unsub = client.onStateChange((s) => states.push(s));
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    client.close();
    // close() transitions to offline; unsub should prevent the listener from firing.
    expect(states).toEqual(["connecting"]);
  });

  it("close() transitions to offline", () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    client.close();
    expect(client.state).toBe("offline");
  });
});
