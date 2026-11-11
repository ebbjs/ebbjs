import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "./client";
import { decodeSync, makeHlc, type Action } from "@ebbjs/core";
import { e } from "@ebbjs/schema";
import {
  makeFetchMock,
  callApplyAction,
  emptyCatchUpResponse,
  emptyListingResponse,
  jsonResponse,
  openSseResponse,
  waitFor,
} from "./test-utils";
import { ModelRegistry, EntityValidationError } from "@ebbjs/schema";
import { defineModel } from "@ebbjs/schema";
import { defineRelationship, TextCellSchema } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import type { OutboxSnapshot } from "./outbox-observer";

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
      apps: null,
      permissions: ["read", "write"],
      cursorValid: true,
      reason: null,
      cursor: 0,
    });
    expect(result.groups[1].cursorValid).toBe(false);
    expect(result.groups[1].reason).toBe("behind_watermark");

    // Handshake should send POST to /sync/handshake with JSON body.
    const call = fn.mock.calls[0];
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

describe("SyncClient schema option", () => {
  it("builds the per-client registry from schema._registry and exposes it on client.registry", () => {
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const { fn } = makeFetchMock([{ body: JSON.stringify({ actor_id: "a_test", groups: [] }) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({ models: { todo }, version: 1 }),
    });
    expect(client.registry).toBeInstanceOf(ModelRegistry);
    expect(client.registry.has("todo")).toBe(true);
    expect(client.registry.get("todo")).toBe(todo);
  });

  it("seeds client.write() validation from the schema's registry", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify({ actor_id: "a_test", groups: [] }) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: {
          todo: defineModel("todo", {
            title: e.string(),
            completed: e.boolean(),
          }),
        },
        version: 1,
      }),
    });

    const hlc = makeHlc(1711036800000);
    const bad: Action = {
      id: "a_1",
      actor_id: "a_test",
      hlc,
      gsn: 0,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_1",
          component: "todo/typo",
          method: "replace",
          data: { value: "oops", update_id: "u_1", hlc },
        },
      ],
    };
    await expect(client.write([bad])).rejects.toBeInstanceOf(EntityValidationError);
    // No fetch should have been issued for the rejected write.
    const writeCalls = fn.mock.calls.filter(
      (call) =>
        (call[1] as RequestInit).method === "POST" && String(call[0]).endsWith("/sync/actions"),
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("advertises schema.version on the handshake body", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: {
          todo: defineModel("todo", { title: e.string() }),
        },
        version: 4,
      }),
    });
    await client.handshake();
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    expect(handshakeCall).toBeDefined();
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(body.schema_version).toBe(4);
  });

  it("advertises minSupportedVersion on the handshake body when set", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: {
          todo: defineModel("todo", { title: e.string() }),
        },
        version: 5,
        minSupportedVersion: 2,
      }),
    });
    await client.handshake();
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(body.schema_version).toBe(5);
    expect(body.min_supported_version).toBe(2);
  });

  it("omits min_supported_version from the handshake when not configured", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: {
          todo: defineModel("todo", { title: e.string() }),
        },
        version: 1,
      }),
    });
    await client.handshake();
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(body).not.toHaveProperty("min_supported_version");
  });

  it("advertises a deterministic schema_hash on the handshake body when a schema is configured", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const schema = defineSchema({
      models: {
        todo: defineModel("todo", { title: e.string() }),
      },
      version: 1,
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema,
    });
    await client.handshake();
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(typeof body.schema_hash).toBe("string");
    expect(body.schema_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes schema_hash when a declared default changes", async () => {
    const hashOf = async (defaultValue: string): Promise<string> => {
      const { fn } = makeFetchMock([{ body: JSON.stringify({ actor_id: "a_test", groups: [] }) }]);
      const client = createClient({
        serverUrl: "http://localhost:4000",
        actorId: "a_test",
        fetchImpl: fn,
        schema: defineSchema({
          models: {
            todo: defineModel("todo", {
              priority: e.string().default(defaultValue),
            }),
          },
          version: 1,
        }),
      });
      await client.handshake();
      const body = JSON.parse((fn.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);
      return body.schema_hash as string;
    };
    expect(await hashOf("normal")).not.toBe(await hashOf("urgent"));
  });

  it("produces the same schema_hash for equivalent schemas on independent clients", async () => {
    const schemaA = defineSchema({
      models: {
        todo: defineModel("todo", { title: e.string() }),
      },
      version: 1,
    });
    const schemaB = defineSchema({
      models: {
        todo: defineModel("todo", { title: e.string() }),
      },
      version: 1,
    });
    const { fn: fnA } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const a = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fnA,
      schema: schemaA,
    });
    await a.handshake();
    const { fn: fnB } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "b_test", groups: [] }) },
    ]);
    const b = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "b_test",
      fetchImpl: fnB,
      schema: schemaB,
    });
    await b.handshake();
    const bodyA = JSON.parse((fnA.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);
    const bodyB = JSON.parse((fnB.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);
    expect(bodyA.schema_hash).toBe(bodyB.schema_hash);
  });

  it("produces the same schema_hash for equivalent schemas that declare a document entity", async () => {
    const buildSchema = () => {
      const blogPost = defineModel("blog_post", { title: e.string() });
      const textDocument = defineModel(
        "text_document",
        { content: e.map(TextCellSchema), version: e.number() },
        { materialization: "on-demand" },
      );
      return defineSchema({
        models: { blog_post: blogPost, text_document: textDocument },
        relationships: {
          body: defineRelationship({
            source: blogPost,
            target: textDocument,
            as: "body",
            sourceCardinality: "one",
          }),
        },
        version: 1,
      });
    };
    const { fn: fnA } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const a = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fnA,
      schema: buildSchema(),
    });
    await a.handshake();
    const { fn: fnB } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "b_test", groups: [] }) },
    ]);
    const b = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "b_test",
      fetchImpl: fnB,
      schema: buildSchema(),
    });
    await b.handshake();
    const bodyA = JSON.parse((fnA.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);
    const bodyB = JSON.parse((fnB.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);
    expect(bodyA.schema_hash).toBe(bodyB.schema_hash);
  });

  it("omits schema_hash from the handshake when no schema is configured", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    await client.handshake();
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(body).not.toHaveProperty("schema_hash");
  });

  it("accepts a per-call schema_hash override on handshake()", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "a_test", groups: [] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: { todo: defineModel("todo", { title: e.string() }) },
        version: 1,
      }),
    });
    await client.handshake({ schema_hash: "deadbeefcafebabe" });
    const handshakeCall = calls.find((c) => c.url === "http://localhost:4000/sync/handshake");
    const body = JSON.parse((handshakeCall!.init.body ?? "{}") as string);
    expect(body.schema_hash).toBe("deadbeefcafebabe");
  });

  it("keeps the schema's registry isolated from other clients", () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify({ actor_id: "a_test", groups: [] }) }]);
    const a = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      schema: defineSchema({
        models: { todo: defineModel("todo", { title: e.string() }) },
        version: 1,
      }),
    });
    const { fn: fn2 } = makeFetchMock([
      { body: JSON.stringify({ actor_id: "b_test", groups: [] }) },
    ]);
    const b = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "b_test",
      fetchImpl: fn2,
      schema: defineSchema({
        models: { user: defineModel("user", { name: e.string() }) },
        version: 1,
      }),
    });
    expect(a.registry).not.toBe(b.registry);
    expect(a.registry.has("todo")).toBe(true);
    expect(a.registry.has("user")).toBe(false);
    expect(b.registry.has("todo")).toBe(false);
    expect(b.registry.has("user")).toBe(true);
  });
});

describe("SyncClient.catchUp", () => {
  it("fetches actions and applies them to storage", async () => {
    const actions = [
      {
        id: "act_1",
        actor_id: "a_test",
        hlc: makeHlc(1711036800000),
        gsn: 1,
        updates: [
          {
            id: "u_1",
            subject_id: "todo_1",
            component: "todo/title",
            method: "replace",
            data: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) },
          },
        ],
      },
      {
        id: "act_2",
        actor_id: "a_test",
        hlc: makeHlc(1711036800000, 1),
        gsn: 2,
        updates: [
          {
            id: "u_2",
            subject_id: "todo_1",
            component: "todo/title",
            method: "merge",
            data: { value: "Updated", update_id: "u_2", hlc: makeHlc(1711036800000, 1) },
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

    // The `groupCursors` cache (which feeds `computeResumeCursor`) must be
    // in sync with `storage.cursors` so SSE reconnects resume from the right
    // GSN. Issue #46: catchUp used to track the max GSN in two places; this
    // guards against drift between them.
    const groupCursors = (client as unknown as { groupCursors: Map<string, number> }).groupCursors;
    expect(groupCursors.get("grp_1")).toBe(2);

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
        hlc: makeHlc(1711036800000),
        gsn: 0,
        updates: [
          {
            id: "u_1",
            subject_id: "todo_1",
            component: "todo/title",
            method: "replace",
            data: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) },
          },
        ],
      },
      {
        id: "act_bad",
        actor_id: "a_test",
        hlc: makeHlc(1711036800000, 1),
        gsn: 0,
        updates: [
          {
            id: "u_2",
            subject_id: "todo_2",
            method: "delete",
            data: null,
          },
        ],
      },
    ]);

    expect(result.rejected).toEqual([{ id: "act_bad", reason: "permission_denied" }]);

    const call = fn.mock.calls[0];
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
    expect(fn.mock.calls).toHaveLength(0);
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
              method: "delete",
              data: null,
            },
          ],
        },
      ]),
    ).rejects.toThrow(/write failed: 422/);
    // Stop the scheduler's background retry from firing into a later test.
    client.close();
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
    expect(calls[0].url).toContain("/entities/todo_1");
    expect(calls[0].url).not.toContain("actor_id=");
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

describe("SyncClient reconnect backoff (#40)", () => {
  // Regression test for #40: when the SSE stream errors out, the
  // subscription loop used to re-iterate synchronously inside
  // `while (!sub.cancelled)` and call `openSSEStream` again as fast as
  // the network (or fetch mock) could resolve. The exponential backoff
  // computed by `scheduleReconnect` was applied to a state-machine
  // transition only; the actual reconnect attempt hammered the server.
  //
  // Verify that the second fetch call happens at least
  // `reconnectInitialMs` after the first, not sooner.
  it("waits for reconnectInitialMs between failed stream opens", async () => {
    // 500 responses are converted by `openSSEStream` into a stream-level
    // error, which `connectAndDrain` catches and feeds to
    // `scheduleReconnect`. Each call advances `reconnectAttempt`, so the
    // 100ms initial backoff applies to the first retry.
    const fetchImpl = (() => {
      const calls: number[] = [];
      const fn = (async (): Promise<Response> => {
        calls.push(Date.now());
        return new Response("server down", { status: 500 });
      }) as unknown as typeof fetch;
      return Object.assign(fn, { __calls: calls });
    })();

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl,
      reconnectInitialMs: 100,
      reconnectMaxMs: 200,
    });

    // subscribe() arms the subscription loop. The first call to fetch
    // happens immediately.
    client.subscribe(["grp_1"], 0, () => {});

    // Wait for the retry the backoff arms rather than for a fixed window:
    // on a loaded machine the first connect can itself take longer than the
    // gap being measured, which used to make this test fail spuriously.
    const calls = (fetchImpl as unknown as { __calls: number[] }).__calls;
    for (let i = 0; i < 300 && calls.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(calls.length).toBeGreaterThanOrEqual(2);
    const gap = calls[1] - calls[0];
    expect(gap).toBeGreaterThanOrEqual(95); // 100ms - 5ms jitter

    client.close();
  });

  it("caps the loop at MAX_RECONNECT_ATTEMPTS instead of spinning forever", async () => {
    // After 10 attempts the loop must transition to "offline" and stop
    // calling fetch. The previous code (with the synchronous re-iteration
    // bug) would never reach the cap, but the cap itself was also broken
    // because `scheduleReconnect` returned `void` and the loop kept
    // checking only `!sub.cancelled`. The fix returns a sentinel that
    // causes `runSubscriptionLoop` to exit.
    let fetchCount = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCount += 1;
      return new Response("server down", { status: 500 });
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
    });

    client.subscribe(["grp_1"], 0, () => {});

    // 10 attempts × ~5ms backoff + 10 fetch calls ≈ 100ms. Wait for the
    // loop to actually reach the cap rather than assuming a fixed wall-clock
    // window; under a loaded parallel run the timers can slip past 300ms.
    for (let i = 0; i < 200 && client.state !== "offline"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.state).toBe("offline");

    // Then verify no additional fetches happen.
    const countAfterTimeout = fetchCount;
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchCount).toBe(countAfterTimeout);
    // Exactly 10 fetches (one per attempt) — not 11 (which would mean the
    // loop kept spinning after give-up) and not 100+ (which would mean the
    // synchronous-hammer bug is still present).
    expect(fetchCount).toBe(11); // 10 retries + 1 initial = 11 total opens
    expect(client.state).toBe("offline");

    client.close();
  });
});

describe("SyncClient.write with ModelRegistry (#143)", () => {
  const todoAction = (
    overrides: Partial<Extract<Action["updates"][number], { method: "merge" | "replace" }>> = {},
  ): Action => ({
    id: "act_ok",
    actor_id: "a_test",
    hlc: makeHlc(1711036800000),
    gsn: 0,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace",
        data: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) },
        ...overrides,
      },
    ],
  });

  const todoEntity = () => {
    const r = new ModelRegistry();
    r.register(defineModel("todo", { title: e.string() }));
    return r;
  };

  it("makes the request when action is valid against the registry", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify({ rejected: [] }) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
    });
    const result = await client.write([todoAction()]);
    expect(result.rejected).toEqual([]);
    expect(fn.mock.calls).toHaveLength(1);
  });

  it("throws EntityValidationError before any fetch on unknown field", async () => {
    const { fn } = makeFetchMock([]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
    });
    const action = todoAction({ component: "todo/typo" });
    await expect(client.write([action])).rejects.toBeInstanceOf(EntityValidationError);
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("aggregates violations across a batch before any fetch", async () => {
    const { fn } = makeFetchMock([]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
    });
    const good = todoAction();
    const badField = todoAction({ id: "u_bad", component: "todo/typo" });
    const badType = todoAction({ id: "u_unknown", component: "list/title" });
    let caught: unknown;
    try {
      await client.write([good, badField, badType]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EntityValidationError);
    const err = caught as EntityValidationError;
    expect(err.violations.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("constructs an empty registry when none is supplied", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
    });
    expect(client.registry).toBeInstanceOf(ModelRegistry);
    expect(client.registry.has("todo")).toBe(false);
  });
});

describe("SyncClient.queryEntities with ModelRegistry (#143)", () => {
  const todoEntity = () => {
    const r = new ModelRegistry();
    r.register(defineModel("todo", { title: e.string() }));
    return r;
  };

  it("makes the request when filter is valid", async () => {
    const { fn } = makeFetchMock([
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
      registry: todoEntity(),
    });
    const list = await client.queryEntities("todo", { filter: [{ title: "x" }] });
    expect(list).toHaveLength(1);
    expect(fn.mock.calls).toHaveLength(1);
  });

  it("emits a non-fatal warning when a filter skips a defaulted field's absence", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify([]) }]);
    const registry = new ModelRegistry();
    registry.register(defineModel("task", { priority: e.string().default("normal") }));
    const warnings: { violations: readonly { field?: string }[]; direction: string }[] = [];
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry,
      onRegistryViolation: (violations, context) => {
        warnings.push({ violations, direction: context.direction });
      },
    });

    await expect(
      client.queryEntities("task", { filter: [{ priority: "normal" }] }),
    ).resolves.toEqual([]);
    // Non-fatal: the query reached the wire.
    expect(fn.mock.calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.violations[0]?.field).toBe("priority");
    expect(warnings[0]?.direction).toBe("outbound");
  });

  it("stays silent when the filter names the defaulted field's absence", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify([]) }]);
    const registry = new ModelRegistry();
    registry.register(defineModel("task", { priority: e.string().default("normal") }));
    const warnings: unknown[] = [];
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry,
      onRegistryViolation: (violations) => warnings.push(violations),
    });

    await client.queryEntities("task", { filter: [{ priority: "normal" }, { priority: null }] });
    expect(warnings).toEqual([]);
  });

  it("throws EntityValidationError before any fetch on unknown filter field", async () => {
    const { fn } = makeFetchMock([]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
    });
    await expect(client.queryEntities("todo", { filter: [{ typo: "x" }] })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("skips filter validation when no filter is supplied", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify([]) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
    });
    await expect(client.queryEntities("todo")).resolves.toEqual([]);
    expect(fn.mock.calls).toHaveLength(1);
  });
});

describe("SyncClient._applyAction storage effects", () => {
  const titleAction = (args: { id: string; gsn: number; hlc?: string; value?: string }): Action => {
    const hlc = args.hlc ?? makeHlc(1711036800000);
    return {
      id: args.id,
      actor_id: "a_user",
      hlc,
      gsn: args.gsn,
      updates: [
        {
          id: `u_${args.id}_0`,
          subject_id: "todo_1",
          component: "todo/title",
          method: "replace",
          data: { value: args.value ?? "Hello", update_id: `u_${args.id}`, hlc },
        },
      ],
    };
  };

  it("appends the action and marks the entity dirty", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });

    await callApplyAction(client, titleAction({ id: "a_1", gsn: 1 }), "grp_1");

    expect(await client.storage.isDirty("todo_1")).toBe(true);
    expect(await client.storage.cursors.get("grp_1")).toBe(1);
  });

  it("advances the cursor only when gsn is higher", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });
    await client.storage.cursors.set("grp_1", 10);

    await callApplyAction(client, titleAction({ id: "a_1", gsn: 5 }), "grp_1");

    expect(await client.storage.cursors.get("grp_1")).toBe(10);
  });

  it("does not advance a cursor when gsn is 0", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });

    await callApplyAction(client, titleAction({ id: "a_1", gsn: 0 }), "grp_1");

    expect(await client.storage.cursors.get("grp_1")).toBeNull();
  });

  it("does not advance any cursor without a group", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });

    await callApplyAction(client, titleAction({ id: "a_1", gsn: 1 }));

    expect(await client.storage.cursors.get("grp_1")).toBeNull();
  });

  it("applies a patch carrying packed BigInt HLCs", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });
    const put = titleAction({ id: "a_put", gsn: 1 });
    const patch: Action = {
      id: "a_patch",
      actor_id: "a_user",
      hlc: makeHlc(1711036800000, 1),
      gsn: 2,
      updates: [
        {
          id: "u_patch_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "merge",
          data: { value: "Updated", update_id: "u_patch", hlc: makeHlc(1711036800000, 1) },
        },
      ],
    };

    await callApplyAction(client, put, "grp_1");
    // The merge compares the existing and patch HLCs, so a packed-BigInt HLC
    // that `BigInt()` could not parse used to throw here.
    await callApplyAction(client, patch, "grp_1");

    const entity = await client.readLocalEntity("todo_1");
    expect((entity!.data.fields.title as { value: unknown }).value).toBe("Updated");
  });
});

describe("SyncClient._applyAction incoming validation (#143)", () => {
  // Drive the private method via a typed cast — it's the same seam the
  // SSE / catchUp paths use internally.
  const callApplyAction = (
    client: ReturnType<typeof createClient>,
    action: Action,
    groupId?: string,
  ): Promise<{ entityId: string; entityType: string }[]> =>
    (
      client as unknown as {
        _applyAction: (
          a: Action,
          g?: string,
        ) => Promise<{ entityId: string; entityType: string }[]>;
      }
    )._applyAction.call(client, action, groupId);

  it("warn-and-logs on incoming violations but still materializes", async () => {
    const client = createClient({
      serverUrl: "http://localhost:0",
      actorId: "a_test",
    });
    const registry = new ModelRegistry();
    registry.register(defineModel("todo", { title: e.string() }));
    (client as unknown as { registry: ModelRegistry }).registry = registry;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const action: Action = {
        id: "act_bad",
        actor_id: "a_other",
        hlc: makeHlc(1711036800000),
        gsn: 5,
        updates: [
          {
            id: "u_1",

            subject_id: "todo_1",

            component: "todo/typo",

            method: "replace",

            data: { value: "x", update_id: "u_1", hlc: makeHlc(1711036800000) },
          },
        ],
      };
      const affected = await callApplyAction(client, action, "grp_1");
      // Action still materializes (warn-and-log is non-blocking).
      expect(affected).toHaveLength(1);
      expect(await client.readLocalEntity("todo_1")).not.toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/ModelRegistry.*incoming action violation/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn on a valid incoming action", async () => {
    const client = createClient({
      serverUrl: "http://localhost:0",
      actorId: "a_test",
    });
    const registry = new ModelRegistry();
    registry.register(defineModel("todo", { title: e.string() }));
    (client as unknown as { registry: ModelRegistry }).registry = registry;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const action: Action = {
        id: "act_ok",
        actor_id: "a_other",
        hlc: makeHlc(1711036800000),
        gsn: 5,
        updates: [
          {
            id: "u_1",
            subject_id: "todo_1",
            component: "todo/title",
            method: "replace",
            data: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) },
          },
        ],
      };
      await callApplyAction(client, action, "grp_1");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SyncClient.onRegistryViolation hook", () => {
  const callApplyAction = (
    client: ReturnType<typeof createClient>,
    action: Action,
    groupId?: string,
  ): Promise<{ entityId: string; entityType: string }[]> =>
    (
      client as unknown as {
        _applyAction: (
          a: Action,
          g?: string,
        ) => Promise<{ entityId: string; entityType: string }[]>;
      }
    )._applyAction.call(client, action, groupId);

  const badAction = (): Action => ({
    id: "act_bad",
    actor_id: "a_other",
    hlc: makeHlc(1711036800000),
    gsn: 5,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        component: "todo/typo",
        method: "replace",
        data: { value: "x", update_id: "u_1", hlc: makeHlc(1711036800000) },
      },
    ],
  });

  const todoEntity = () => {
    const r = new ModelRegistry();
    r.register(defineModel("todo", { title: e.string() }));
    return r;
  };

  it("fires for inbound violations and replaces console.warn", async () => {
    const calls: Array<{
      violations: unknown;
      context: { direction: string };
    }> = [];
    const client = createClient({
      serverUrl: "http://localhost:0",
      actorId: "a_test",
      registry: todoEntity(),
      onRegistryViolation: (violations, context) => {
        calls.push({ violations, context });
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await callApplyAction(client, badAction(), "grp_1");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.context).toEqual({ direction: "inbound" });
      expect(calls[0]?.violations).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fires for outbound violations before client.write throws", async () => {
    const calls: Array<{
      violations: unknown;
      context: { direction: string };
    }> = [];
    const { fn } = makeFetchMock([]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
      registry: todoEntity(),
      onRegistryViolation: (violations, context) => {
        calls.push({ violations, context });
      },
    });
    let caught: unknown;
    try {
      await client.write([badAction()]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EntityValidationError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toEqual({ direction: "outbound" });
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("isolates throwing listeners — others still fire", async () => {
    const calls: number[] = [];
    const client = createClient({
      serverUrl: "http://localhost:0",
      actorId: "a_test",
      registry: todoEntity(),
    });
    client.onRegistryViolation(() => {
      throw new Error("boom");
    });
    client.onRegistryViolation(() => {
      calls.push(1);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await callApplyAction(client, badAction(), "grp_1");
      expect(calls).toEqual([1]);
      expect(errorSpy).toHaveBeenCalled();
      const message = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/onRegistryViolation handler threw/);
      // console.warn was suppressed by the registered listener.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("onRegistryViolation returns an unsubscribe function", async () => {
    const calls: number[] = [];
    const client = createClient({
      serverUrl: "http://localhost:0",
      actorId: "a_test",
      registry: todoEntity(),
    });
    const unsub = client.onRegistryViolation(() => {
      calls.push(1);
    });
    await callApplyAction(client, badAction(), "grp_1");
    expect(calls).toHaveLength(1);
    unsub();
    await callApplyAction(client, badAction(), "grp_1");
    expect(calls).toHaveLength(1);
  });
});

describe("SyncClient.sync observables", () => {
  /** A well-formed single-update Action; only the id varies per test. */
  const writeAction = (id: string): Action => ({
    id,
    actor_id: "a_test",
    hlc: makeHlc(1711036800000),
    gsn: 0,
    updates: [
      {
        id: `u_${id}`,
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace" as const,
        data: { value: "Hi", update_id: `u_${id}`, hlc: makeHlc(1711036800000) },
      },
    ],
  });

  it("reports outbox depth and flush latency from one subscribable snapshot", async () => {
    const { fn } = makeFetchMock([{ body: JSON.stringify({ rejected: [] }) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const seen: OutboxSnapshot[] = [];
    const unsubscribe = client.sync.outbox.subscribe((snapshot) => seen.push(snapshot));

    expect(client.sync.outbox.get()).toEqual({
      pending: 0,
      acknowledged: 0,
      error: 0,
      conflicted: 0,
      flushLatency: null,
      storeFaults: 0,
    });

    await client.write([writeAction("act_1")]);

    // Enqueue fired a pending-depth change; the resolved flush recorded the
    // acknowledged depth and a latency — all without a poll.
    expect(seen.map((snapshot) => snapshot.pending)).toContain(1);
    const last = client.sync.outbox.get();
    expect(last).toMatchObject({ pending: 0, acknowledged: 1, error: 0 });
    expect(last.flushLatency).not.toBeNull();

    unsubscribe();
    client.close();
  });

  it("reflects a rejected flush as error depth and notifies", async () => {
    const { fn } = makeFetchMock([
      { body: JSON.stringify({ rejected: [{ id: "act_1", reason: "permission_denied" }] }) },
    ]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    const seen: OutboxSnapshot[] = [];
    const unsubscribe = client.sync.outbox.subscribe((snapshot) => seen.push(snapshot));

    const result = await client.write([writeAction("act_1")]);

    expect(result.rejected).toEqual([{ id: "act_1", reason: "permission_denied" }]);
    expect(client.sync.outbox.get()).toMatchObject({ pending: 0, acknowledged: 0, error: 1 });
    expect(seen.some((snapshot) => snapshot.error === 1)).toBe(true);

    unsubscribe();
    client.close();
  });
});

describe("SyncClient.status (#371)", () => {
  const mkAction = (id: string, gsn: number): Action => ({
    id,
    actor_id: "a_test",
    hlc: makeHlc(1711036800000),
    gsn,
    updates: [
      {
        id: `u_${id}`,
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace" as const,
        data: { value: "Hi", update_id: `u_${id}`, hlc: makeHlc(1711036800000) },
      },
    ],
  });

  it("reflects connection transitions and outbox depth", async () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    const listener = vi.fn();
    client.status.subscribe(listener);

    client.setState("live");
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connection: "live" }));

    await client.outbox.enqueue(mkAction("act_1", 0));
    expect(client.status.get().outbox.pending).toBe(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ outbox: expect.objectContaining({ pending: 1 }) }),
    );
  });

  it("stamps lastSyncedAt when a catch-up reaches the head", async () => {
    const { fn } = makeFetchMock([{ body: "[]", headers: { "stream-up-to-date": "true" } }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });
    expect(client.status.get().lastSyncedAt).toBeNull();

    await client.catchUp("grp_1", 0);

    expect(typeof client.status.get().lastSyncedAt).toBe("number");
  });

  it("does not stamp lastSyncedAt on a catch-up page that is still behind", async () => {
    const { fn } = makeFetchMock([{ body: "[]", headers: { "stream-next-offset": "10" } }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      fetchImpl: fn,
    });

    const result = await client.catchUp("grp_1", 0);

    expect(result.upToDate).toBe(false);
    expect(client.status.get().lastSyncedAt).toBeNull();
  });

  it("stamps lastSyncedAt for an inbound Action with a server GSN, not a local one", async () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });

    await callApplyAction(client, mkAction("act_local", 0));
    expect(client.status.get().lastSyncedAt).toBeNull();

    await callApplyAction(client, mkAction("act_remote", 5));
    expect(typeof client.status.get().lastSyncedAt).toBe("number");
  });

  it("stops notifying a status subscriber after unsubscribe", () => {
    const client = createClient({ serverUrl: "http://localhost:4000", actorId: "a_test" });
    const listener = vi.fn();
    const unsubscribe = client.status.subscribe(listener);

    unsubscribe();
    client.setState("live");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SyncClient._applyAction HLC drift (#663)", () => {
  const now = 1_790_000_000_000;

  const clockOf = (client: ReturnType<typeof createClient>) =>
    (client as unknown as { clock: { l: bigint; c: bigint } }).clock;

  const actionWithHlc = (hlc: string): Action => ({
    id: `act_${hlc}`,
    actor_id: "a_other",
    hlc,
    gsn: 1,
    updates: [],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not wedge the clock on a 30-day-old inbound Action", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });
    const oldLogicalTime = BigInt(now - 30 * 86_400_000);

    await callApplyAction(client, actionWithHlc(makeHlc(oldLogicalTime)), "grp_1");

    expect(clockOf(client).l).toBe(oldLogicalTime);
    expect(client.freshHlc()).toBe(makeHlc(now));
  });

  it("refuses to adopt an inbound HLC more than 120s ahead", async () => {
    const client = createClient({ serverUrl: "http://localhost:0", actorId: "a_test" });

    await callApplyAction(client, actionWithHlc(makeHlc(now + 6 * 3_600_000)), "grp_1");

    // A rejected merge leaves neither field moved.
    expect(clockOf(client)).toEqual({ l: 0n, c: 0n });
    expect(client.freshHlc()).toBe(makeHlc(now));
  });
});

describe("app scope (#732)", () => {
  const handshakeGroup = (id: string, apps?: string[] | null) => ({
    id,
    apps,
    permissions: [],
    cursor_valid: true,
    reason: null,
    cursor: 0,
  });

  const mkScopedClient = (appId: string | undefined, groups: unknown[]) => {
    const { fn, calls } = makeFetchMock([{ body: JSON.stringify({ actor_id: "a_test", groups }) }]);
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_test",
      appId,
      fetchImpl: fn,
    });
    return { client, calls };
  };

  const actorGroupIds = (client: ReturnType<typeof createClient>): string[] =>
    (client as unknown as { actorGroups: { id: string }[] }).actorGroups.map((g) => g.id);

  const cachedCursors = (client: ReturnType<typeof createClient>): string[] => [
    ...(client as unknown as { groupCursors: Map<string, number> }).groupCursors.keys(),
  ];

  describe("handshake filter", () => {
    it("keeps unscoped groups and groups whose scope names the client's app", async () => {
      const { client } = mkScopedClient("notes", [
        handshakeGroup("g_unscoped"),
        handshakeGroup("g_notes", ["notes"]),
        handshakeGroup("g_issues", ["issues"]),
        handshakeGroup("g_none", []),
        handshakeGroup("g_null", null),
      ]);

      const result = await client.handshake();

      expect(result.groups.map((group) => group.id)).toEqual(["g_unscoped", "g_notes", "g_null"]);
      expect(result.groups[0]!.apps).toBeNull();
      expect(result.groups[1]!.apps).toEqual(["notes"]);
      expect(actorGroupIds(client)).toEqual(["g_unscoped", "g_notes", "g_null"]);
      expect(cachedCursors(client)).toEqual(["g_unscoped", "g_notes", "g_null"]);
    });

    it("keeps every group when the client declares no app", async () => {
      const { client } = mkScopedClient(undefined, [
        handshakeGroup("g_unscoped"),
        handshakeGroup("g_notes", ["notes"]),
        handshakeGroup("g_none", []),
      ]);

      const result = await client.handshake();

      expect(result.groups.map((group) => group.id)).toEqual(["g_unscoped", "g_notes", "g_none"]);
      expect(result.groups[1]!.apps).toEqual(["notes"]);
    });

    it("reads a server that does not send apps as unscoped", async () => {
      const { client } = mkScopedClient("notes", [
        { id: "g_old_server", permissions: [], cursor_valid: true, reason: null, cursor: 0 },
      ]);

      const result = await client.handshake();

      expect(result.groups.map((group) => group.id)).toEqual(["g_old_server"]);
      expect(result.groups[0]!.apps).toBeNull();
    });
  });

  describe("seed", () => {
    const mkSeedClient = (appId: string | undefined) => {
      const { fn, calls } = makeFetchMock([{ body: JSON.stringify({ rejected: [] }) }]);
      const client = createClient({
        serverUrl: "http://localhost:4000",
        actorId: "a_test",
        appId,
        fetchImpl: fn,
      });
      return { client, calls };
    };

    const seedAction = async (
      client: ReturnType<typeof createClient>,
      calls: { init: RequestInit }[],
      groups: { id: string; name: string; apps?: Record<string, boolean> }[],
    ): Promise<Action> => {
      await client.seed({ groups, groupMembers: [], entities: [] });
      const body = calls[0]!.init.body as Uint8Array;
      return decodeSync<{ actions: Action[] }>(body).actions[0]!;
    };

    const appsField = (action: Action, groupId: string): unknown =>
      action.updates.find(
        (update) =>
          update.method !== "delete" &&
          update.component === "group/apps" &&
          update.subject_id === groupId,
      )?.data;

    it("scopes an unscoped group to the client's app", async () => {
      const { client, calls } = mkSeedClient("notes");

      const action = await seedAction(client, calls, [{ id: "g_1", name: "Team" }]);

      expect(appsField(action, "g_1")).toEqual({
        map: { notes: { value: true, update_id: "seed_update", hlc: expect.any(String) } },
      });
    });

    it("keeps an explicit scope, including an empty one", async () => {
      const { client, calls } = mkSeedClient("notes");

      const action = await seedAction(client, calls, [
        { id: "g_1", name: "Shared", apps: { notes: true, issues: true } },
        { id: "g_2", name: "Nobody", apps: {} },
      ]);

      expect(Object.keys((appsField(action, "g_1") as { map: object }).map)).toEqual([
        "notes",
        "issues",
      ]);
      expect((appsField(action, "g_2") as { map: object }).map).toEqual({});
    });

    it("omits apps when the client declares no app", async () => {
      const { client, calls } = mkSeedClient(undefined);

      const action = await seedAction(client, calls, [{ id: "g_1", name: "Team" }]);

      expect(appsField(action, "g_1")).toBeUndefined();
    });
  });

  describe("reconcile", () => {
    it("drops a subscribed group that left the app's scope and reconnects without it", async () => {
      const liveUrls: string[] = [];
      let groups = [handshakeGroup("g_notes", ["notes"]), handshakeGroup("g_old", ["notes"])];
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/sync/handshake")) return jsonResponse({ actor_id: "a_test", groups });
        if (url.includes("/sync/live")) {
          liveUrls.push(url);
          return openSseResponse();
        }
        if (url.includes("/entities")) return emptyListingResponse();
        if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
        return jsonResponse({});
      }) as typeof fetch;

      const client = createClient({
        serverUrl: "http://localhost:4000",
        actorId: "a_test",
        appId: "notes",
        reconnectInitialMs: 1,
        fetchImpl,
      });

      await client.handshake();
      const unsubscribe = client.subscribe(["g_notes", "g_old"], () => {});
      await waitFor(() => liveUrls.length > 0);
      expect(liveUrls[0]).toContain("g_old");

      groups = [handshakeGroup("g_notes", ["notes"]), handshakeGroup("g_old", ["issues"])];
      await client.handshake();

      const scope = (client as unknown as { replicaScope: Set<string> }).replicaScope;
      const sub = (client as unknown as { activeSub: { groupIds: string[] } }).activeSub;
      expect([...scope]).toEqual(["g_notes"]);
      expect(sub.groupIds).toEqual(["g_notes"]);

      await waitFor(() => liveUrls.length > 1);
      expect(liveUrls[1]).not.toContain("g_old");

      unsubscribe();
    });

    it("ends the session when no subscribed group remains in scope", async () => {
      let groups = [handshakeGroup("g_notes", ["notes"])];
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/sync/handshake")) return jsonResponse({ actor_id: "a_test", groups });
        if (url.includes("/sync/live")) return openSseResponse();
        if (url.includes("/entities")) return emptyListingResponse();
        if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
        return jsonResponse({});
      }) as typeof fetch;

      const client = createClient({
        serverUrl: "http://localhost:4000",
        actorId: "a_test",
        appId: "notes",
        reconnectInitialMs: 1,
        fetchImpl,
      });

      await client.handshake();
      client.subscribe(["g_notes"], () => {});
      await waitFor(() => client.state === "live");

      groups = [handshakeGroup("g_other", ["issues"])];
      await client.handshake();

      expect((client as unknown as { activeSub: unknown }).activeSub).toBeNull();
      expect(client.state).toBe("offline");
    });

    it("keeps an explicitly over-subscribed out-of-scope group", async () => {
      const groups = [handshakeGroup("g_notes", ["notes"]), handshakeGroup("g_issues", ["issues"])];
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/sync/handshake")) return jsonResponse({ actor_id: "a_test", groups });
        if (url.includes("/sync/live")) return openSseResponse();
        if (url.includes("/entities")) return emptyListingResponse();
        if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
        return jsonResponse({});
      }) as typeof fetch;

      const client = createClient({
        serverUrl: "http://localhost:4000",
        actorId: "a_test",
        appId: "notes",
        reconnectInitialMs: 1,
        fetchImpl,
      });

      // Subscribe before the first handshake: with no previous scope
      // baseline, reconcile has nothing to remove.
      const unsubscribe = client.subscribe(["g_notes", "g_issues"], () => {});
      await waitFor(() => client.state === "live");

      const { groups: inScope } = await client.handshake();
      expect(inScope.map((group) => group.id)).toEqual(["g_notes"]);
      await client.handshake();

      const scope = (client as unknown as { replicaScope: Set<string> }).replicaScope;
      const sub = (client as unknown as { activeSub: { groupIds: string[] } }).activeSub;
      expect([...scope]).toEqual(["g_notes", "g_issues"]);
      expect(sub.groupIds).toEqual(["g_notes", "g_issues"]);

      unsubscribe();
    });
  });
});
