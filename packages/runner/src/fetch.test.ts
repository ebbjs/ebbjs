import { describe, expect, it } from "vitest";

import type { FetchAuditFields } from "@ebbjs/functions-protocol";

import {
  DEFAULT_MAX_FETCH_RESPONSE_BYTES,
  FetchBlockedError,
  compileAllowlist,
  createGuardedFetch,
} from "./fetch.ts";

type Fetch = typeof globalThis.fetch;

const stub = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  }) as Fetch;

  return { fetch, calls };
};

const audits: FetchAuditFields[] = [];

const guard = (fetch: Fetch, options: { allowlist?: readonly string[]; max?: number } = {}) => {
  audits.length = 0;
  return createGuardedFetch(fetch, {
    allowlist: options.allowlist ?? [],
    maxResponseBytes: options.max,
    audit: (fields) => audits.push(fields),
  });
};

const ok = (body = "ok", status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

describe("compileAllowlist", () => {
  it("reads host, host:port, IPv6, and URL entries", () => {
    expect(compileAllowlist(["api.example.com"])).toEqual([
      { hostname: "api.example.com", port: null },
    ]);
    expect(compileAllowlist(["api.example.com:8443"])).toEqual([
      { hostname: "api.example.com", port: "8443" },
    ]);
    expect(compileAllowlist(["[::1]:8080"])).toEqual([{ hostname: "[::1]", port: "8080" }]);
    expect(compileAllowlist(["https://API.example.com:9443/path"])).toEqual([
      { hostname: "api.example.com", port: "9443" },
    ]);
  });

  it("drops entries that cannot name a host", () => {
    expect(compileAllowlist(["", "  ", "not a host", "a/b"])).toEqual([]);
  });
});

describe("createGuardedFetch", () => {
  it("is unrestricted with an empty allowlist and still audits", async () => {
    const { fetch, calls } = stub(async () => ok("hello"));
    const guarded = guard(fetch);

    const response = await guarded("https://anywhere.example/x?token=hidden");

    expect(await response.text()).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      method: "GET",
      url: "https://anywhere.example/x?token=hidden",
      status: 200,
      blocked: false,
    });
    expect(audits[0]?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("allows a listed host on any port and a listed port only on that port", async () => {
    const { fetch } = stub(async () => ok());
    const guarded = guard(fetch, { allowlist: ["api.example.com", "pinned.example.com:8443"] });

    await expect(guarded("https://api.example.com:1234/x")).resolves.toBeDefined();
    await expect(guarded("http://api.example.com/x")).resolves.toBeDefined();
    await expect(guarded("https://pinned.example.com:8443/x")).resolves.toBeDefined();

    await expect(guarded("https://pinned.example.com/x")).rejects.toBeInstanceOf(FetchBlockedError);
  });

  it("blocks a host that is not listed without calling the original fetch", async () => {
    const { fetch, calls } = stub(async () => ok());
    const guarded = guard(fetch, { allowlist: ["api.example.com"] });

    await expect(guarded("https://evil.example/x")).rejects.toBeInstanceOf(FetchBlockedError);
    expect(calls).toEqual([]);
    expect(audits).toEqual([
      {
        method: "GET",
        url: "https://evil.example/x",
        status: null,
        duration_ms: expect.any(Number),
        blocked: true,
      },
    ]);
  });

  it("blocks a relative URL under an allowlist", async () => {
    const { fetch } = stub(async () => ok());
    const guarded = guard(fetch, { allowlist: ["api.example.com"] });

    await expect(guarded("/local/path")).rejects.toBeInstanceOf(FetchBlockedError);
  });

  it("reads the method from the init or the Request", async () => {
    const { fetch } = stub(async () => ok());
    const guarded = guard(fetch);

    await guarded("https://anywhere.example/x", { method: "post" });

    expect(audits[0]?.method).toBe("POST");
  });

  it("refuses a response whose declared content-length exceeds the cap", async () => {
    const { fetch } = stub(
      async () => new Response("x", { status: 200, headers: { "content-length": "11" } }),
    );
    const guarded = guard(fetch, { max: 10 });

    await expect(guarded("https://anywhere.example/x")).rejects.toMatchObject({
      name: "FetchResponseTooLargeError",
      limit: 10,
    });
    // The request completed, so the audit carries its real status.
    expect(audits[0]).toMatchObject({ status: 200, blocked: false });
  });

  it("errors a chunked body that grows past the cap while it is read", async () => {
    const { fetch } = stub(async () => new Response(streamOf("123456", "789012"), { status: 200 }));
    const guarded = guard(fetch, { max: 10 });

    const response = await guarded("https://anywhere.example/x");

    expect(response.status).toBe(200);
    expect(audits[0]).toMatchObject({ status: 200, blocked: false });
    await expect(response.text()).rejects.toMatchObject({ name: "FetchResponseTooLargeError" });
  });

  it("lets a chunked body under the cap through", async () => {
    const { fetch } = stub(async () => new Response(streamOf("1234", "5678"), { status: 200 }));
    const guarded = guard(fetch, { max: 10 });

    const response = await guarded("https://anywhere.example/x");

    expect(await response.text()).toBe("12345678");
  });

  it("passes a response with a fitting declared length through untouched", async () => {
    const original = new Response("tiny", { status: 200, headers: { "content-length": "4" } });
    const { fetch } = stub(async () => original);
    const guarded = guard(fetch, { max: 10 });

    await expect(guarded("https://anywhere.example/x")).resolves.toBe(original);
  });

  it("audits a network failure and rethrows it", async () => {
    const { fetch } = stub(async () => {
      throw new TypeError("connection refused");
    });
    const guarded = guard(fetch);

    await expect(guarded("https://anywhere.example/x")).rejects.toThrow("connection refused");

    expect(audits[0]).toMatchObject({ status: null, blocked: false });
  });

  it("does not fail a request when the audit sink throws", async () => {
    const { fetch } = stub(async () => ok());
    const guarded = createGuardedFetch(fetch, {
      allowlist: [],
      audit: () => {
        throw new Error("telemetry down");
      },
    });

    await expect(guarded("https://anywhere.example/x")).resolves.toBeDefined();
  });

  it("refuses a response past the default 10 MiB cap", async () => {
    const { fetch } = stub(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(DEFAULT_MAX_FETCH_RESPONSE_BYTES + 1) },
        }),
    );
    const guarded = guard(fetch);

    await expect(guarded("https://anywhere.example/x")).rejects.toMatchObject({
      name: "FetchResponseTooLargeError",
      limit: DEFAULT_MAX_FETCH_RESPONSE_BYTES,
    });
  });
});
