/**
 * Invocation tests: the low-level `invokeFunction` call and the
 * `client.functions` surface `createClient` mounts from a contract map.
 *
 * The stub `fetch` records every request, so the tests assert the wire the
 * server's `POST /functions/:name` expects: the encoded name, the actor
 * header set, and whether an idempotency key travelled at all.
 */

import { describe, expect, it } from "vitest";

import {
  ActionRejectedError,
  FunctionCallError,
  createClient,
  defineAction,
  defineModel,
  defineSchema,
  e,
  functionContract,
} from "../../index";

interface Recorded {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

const mkFetch = (
  respond: (request: Recorded) => Response,
): { seen: Recorded[]; fetchImpl: typeof fetch } => {
  const seen: Recorded[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}): Promise<Response> => {
    const request: Recorded = {
      url: String(input),
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    seen.push(request);
    return respond(request);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const mkClient = (respond: (request: Recorded) => Response) => {
  const { seen, fetchImpl } = mkFetch(respond);
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    fetchImpl,
  });
  return { client, seen };
};

describe("client.invokeFunction", () => {
  it("posts the encoded name, JSON input, and the actor header", async () => {
    const { client, seen } = mkClient(() =>
      jsonResponse({
        ok: true,
        result: { commentCount: 2 },
        invocation_id: "inv_1",
        version: "1",
        replayed: false,
      }),
    );

    const out = await client.invokeFunction("proofread doc", { documentId: "d_1" });

    expect(out).toEqual({ result: { commentCount: 2 }, replayed: false });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request!.url).toBe("http://localhost:4000/functions/proofread%20doc");
    expect(request!.method).toBe("POST");
    expect(request!.headers["x-ebb-actor-id"]).toBe("actor_1");
    expect(request!.headers["content-type"]).toBe("application/json");
    expect(request!.headers["idempotency-key"]).toBeUndefined();
    expect(JSON.parse(request!.body!)).toEqual({ documentId: "d_1" });
  });

  it("sends an empty object for a no-params invocation", async () => {
    const { client, seen } = mkClient(() =>
      jsonResponse({ ok: true, result: "pong", invocation_id: "inv_1", version: "1" }),
    );

    const out = await client.invokeFunction("ping");

    expect(out).toEqual({ result: "pong", replayed: false });
    expect(JSON.parse(seen[0]!.body!)).toEqual({});
  });

  it("sends the idempotency key only when the caller supplies one", async () => {
    const { client, seen } = mkClient(() => jsonResponse({ ok: true, result: null }));

    await client.invokeFunction("ping", undefined, { idempotencyKey: "retry-7" });
    await client.invokeFunction("ping", undefined, {});

    expect(seen[0]!.headers["idempotency-key"]).toBe("retry-7");
    expect(seen[1]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("reports a replayed commit", async () => {
    const { client } = mkClient(() => jsonResponse({ ok: true, result: 3, replayed: true }));

    await expect(client.invokeFunction("count")).resolves.toEqual({ result: 3, replayed: true });
  });

  it("throws ActionRejectedError carrying a one-line-per-rejection message", async () => {
    // One rejection names its model and details, the other carries only the
    // id; the message is what a caller logs, so both shapes appear here.
    const rejected = [
      { id: "u_1", model: "todo", reason: "permission_denied", details: "todo.create" },
      { id: "u_2", reason: "duplicate" },
    ];
    const { client } = mkClient(() => jsonResponse({ error: "rejected", rejected }, 422));

    const error: unknown = await client.invokeFunction("createTodo").catch((caught) => caught);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections).toEqual(rejected);
    expect((error as ActionRejectedError).message).toBe(
      [
        "ActionRejectedError: 2 rejected update(s)",
        "  - todo u_1: permission_denied (todo.create)",
        "  - u_2: duplicate",
      ].join("\n"),
    );
  });

  it("throws FunctionCallError carrying the failure envelope", async () => {
    const { client } = mkClient(() =>
      jsonResponse(
        {
          error: "not_found",
          details: "no such function",
          invocation_id: "inv_2",
          version: "3",
        },
        404,
      ),
    );

    await expect(client.invokeFunction("missing")).rejects.toBeInstanceOf(FunctionCallError);
    await expect(client.invokeFunction("missing")).rejects.toMatchObject({
      name: "FunctionCallError",
      message: "FunctionCallError: 404 not_found (no such function)",
      status: 404,
      code: "not_found",
      details: "no such function",
      invocationId: "inv_2",
      version: "3",
      issues: undefined,
    });
  });

  it("keeps invalid params and invalid output distinct from a rejection", async () => {
    const issues = [{ path: "documentId", message: "is required" }];
    const { client } = mkClient(() =>
      jsonResponse({ error: "invalid_input", issues, invocation_id: "inv_3", version: "1" }, 400),
    );

    await expect(client.invokeFunction("proofread")).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
      issues,
    });
    await expect(client.invokeFunction("proofread")).rejects.not.toBeInstanceOf(
      ActionRejectedError,
    );
  });

  it("survives a body that is not JSON", async () => {
    const { client } = mkClient(() => new Response("<html>bad gateway</html>", { status: 502 }));

    await expect(client.invokeFunction("proofread")).rejects.toMatchObject({
      status: 502,
      code: "unknown_error",
      details: undefined,
    });
  });
});

interface ProofreadDef {
  readonly "~input"?: { documentId: string };
  readonly "~output"?: { commentCount: number };
}

const proofread = functionContract<ProofreadDef>("proofreadDocument");

describe("client.functions", () => {
  it("mounts from a contract map without a schema", async () => {
    const { seen, fetchImpl } = mkFetch(() =>
      jsonResponse({ ok: true, result: { commentCount: 5 }, replayed: true }),
    );
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl,
      functions: { proofread },
    });

    const out = await client.functions.proofread({ documentId: "d_1" });

    expect(out).toEqual({ commentCount: 5, replayed: true });
    expect(seen[0]!.url).toBe("http://localhost:4000/functions/proofreadDocument");
  });

  it("keeps a non-object result under result", async () => {
    const count = functionContract<{
      readonly "~input"?: void;
      readonly "~output"?: number;
    }>("count");
    const { fetchImpl } = mkFetch(() => jsonResponse({ ok: true, result: 5 }));
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl,
      functions: { count },
    });

    const out = await client.functions.count();

    expect(out).toEqual({ result: 5, replayed: false });
  });

  it("returns only replayed for a void result", async () => {
    const noop = functionContract<{ readonly "~input"?: void; readonly "~output"?: void }>("noop");
    const { fetchImpl } = mkFetch(() => jsonResponse({ ok: true, result: undefined }));
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl,
      functions: { noop },
    });

    const out = await client.functions.noop();

    expect(out).toEqual({ replayed: false });
    expect("result" in out).toBe(false);
  });

  it("sits alongside entity namespaces and actions", async () => {
    const todo = defineModel("todo", { title: e.string() });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const createTodo = defineAction(schema, ({ todo: t }, params: { title: string }) =>
      t.create({ title: params.title }, { groups: ["g_1"] }),
    );
    const { fetchImpl } = mkFetch((request) => {
      if (request.url.endsWith("/sync/handshake")) {
        return jsonResponse({ actor_id: "actor_1", groups: [] });
      }
      if (request.url.endsWith("/sync/actions")) {
        return jsonResponse({ rejected: [] });
      }
      return jsonResponse({ ok: true, result: { commentCount: 1 }, replayed: true });
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl,
      schema,
      actions: { createTodo },
      functions: { proofread },
    });

    expect(typeof client.todo.query).toBe("function");
    expect(typeof client.actions.createTodo).toBe("function");
    const { id } = await client.actions.createTodo({ title: "Ship it" });
    expect(id).toMatch(/^e_/);
    await expect(client.functions.proofread({ documentId: "d_1" })).resolves.toEqual({
      commentCount: 1,
      replayed: true,
    });
  });
});
