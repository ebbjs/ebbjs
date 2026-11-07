/**
 * Unit tests for `resolveIdentity`. It is the client's only read of
 * `GET /sync/identity`, so these pin the wire parse and — more importantly —
 * that every failure mode is a distinct, actionable error kind rather than a
 * bare `Error` a caller cannot branch on.
 */

import { describe, expect, it, vi } from "vitest";

import { IdentityResolutionError, resolveIdentity } from "./identity";
import * as entryPoint from "./index";

const serverUrl = "http://ebb.test:4000";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A `fetch` stand-in that answers every request with `respond`. */
const stubFetch = (
  respond: () => Response | Promise<Response>,
): ReturnType<typeof vi.fn<typeof fetch>> => vi.fn<typeof fetch>(async () => respond());

const rejection = async (promise: Promise<unknown>): Promise<IdentityResolutionError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityResolutionError);
    return error as IdentityResolutionError;
  }
  throw new Error("expected resolveIdentity to reject");
};

describe("resolveIdentity", () => {
  it("is exported from the package entry point", () => {
    expect(entryPoint.resolveIdentity).toBe(resolveIdentity);
    expect(entryPoint.IdentityResolutionError).toBe(IdentityResolutionError);
  });
  it("parses the full identity payload into camelCase", async () => {
    const fetchImpl = stubFetch(() =>
      json({
        actor_id: "alice@example.com",
        provider: "tailscale",
        display_name: "Alice",
        provider_id: 42,
      }),
    );

    const identity = await resolveIdentity({ serverUrl, fetchImpl });

    expect(identity).toEqual({
      actorId: "alice@example.com",
      provider: "tailscale",
      displayName: "Alice",
      providerId: 42,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${serverUrl}/sync/identity`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("leaves the optional fields off when the server omits them", async () => {
    const fetchImpl = stubFetch(() => json({ actor_id: "alice", provider: "bypass" }));

    const identity = await resolveIdentity({ serverUrl, fetchImpl });

    expect(identity).toEqual({ actorId: "alice", provider: "bypass" });
    expect("displayName" in identity).toBe(false);
    expect("providerId" in identity).toBe(false);
  });

  it("strips trailing slashes from the server url", async () => {
    const fetchImpl = stubFetch(() => json({ actor_id: "alice", provider: "external" }));

    await resolveIdentity({ serverUrl: `${serverUrl}//`, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(`${serverUrl}/sync/identity`, expect.anything());
  });

  it("sends no actor header — the server decides who the caller is", async () => {
    const fetchImpl = stubFetch(() => json({ actor_id: "alice", provider: "tailscale" }));

    await resolveIdentity({ serverUrl, fetchImpl });

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.has("x-ebb-actor-id")).toBe(false);
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    const fetchImpl = stubFetch(() => json({ actor_id: "alice", provider: "bypass" }));

    await resolveIdentity({ serverUrl, fetchImpl, signal: controller.signal });

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it("maps a 401 to an unauthorized error naming the login", async () => {
    const fetchImpl = stubFetch(() => json({ error: "unauthorized" }, 401));

    const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/401/);
    expect(error.message).toMatch(/login|sign in/i);
  });

  it("maps any other non-ok response to an http error with its status", async () => {
    const fetchImpl = stubFetch(() => json({ error: "boom" }, 500));

    const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
    expect(error.message).toMatch(/500/);
  });

  it("treats an HTML body as an invalid response, not a parse crash", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response("<!doctype html><html><body>Sign in to the proxy</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

    expect(error.kind).toBe("invalid-response");
    expect(error.status).toBeUndefined();
    expect(error.message).toMatch(/JSON/);
    expect(error.message).toMatch(/proxy/i);
  });

  it("rejects a payload that is not JSON at all", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

    expect(error.kind).toBe("invalid-response");
    expect(error.message).toMatch(/not JSON/);
  });

  describe("rejects malformed payloads", () => {
    const cases: readonly {
      readonly name: string;
      readonly body: unknown;
      readonly field: RegExp;
    }[] = [
      { name: "a non-object body", body: [], field: /object/ },
      { name: "a null body", body: null, field: /object/ },
      { name: "a missing actor_id", body: { provider: "bypass" }, field: /actor_id/ },
      { name: "an empty actor_id", body: { actor_id: "", provider: "bypass" }, field: /actor_id/ },
      {
        name: "a non-string actor_id",
        body: { actor_id: 7, provider: "bypass" },
        field: /actor_id/,
      },
      {
        name: "an unknown provider",
        body: { actor_id: "alice", provider: "cookie" },
        field: /provider/,
      },
      {
        name: "a non-string display_name",
        body: { actor_id: "alice", provider: "bypass", display_name: 7 },
        field: /display_name/,
      },
      {
        name: "a null display_name",
        body: { actor_id: "alice", provider: "bypass", display_name: null },
        field: /display_name/,
      },
      {
        name: "a non-number provider_id",
        body: { actor_id: "alice", provider: "bypass", provider_id: "42" },
        field: /provider_id/,
      },
      {
        name: "a null provider_id",
        body: { actor_id: "alice", provider: "bypass", provider_id: null },
        field: /provider_id/,
      },
    ];

    for (const { name, body, field } of cases) {
      it(name, async () => {
        const fetchImpl = stubFetch(() => json(body));

        const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

        expect(error.kind).toBe("invalid-response");
        expect(error.message).toMatch(field);
      });
    }
  });

  it("maps a fetch rejection to a network error and keeps the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetchImpl = stubFetch(() => {
      throw cause;
    });

    const error = await rejection(resolveIdentity({ serverUrl, fetchImpl }));

    expect(error.kind).toBe("network");
    expect(error.status).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.message).toMatch(/reach/i);
    expect(error.message).toContain(serverUrl);
  });
});
