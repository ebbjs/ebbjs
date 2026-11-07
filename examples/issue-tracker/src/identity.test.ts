/**
 * Unit tests for the demo's onboarding decision. The demo is the first app to
 * exercise `resolveIdentity`, so these pin the split that keeps bypass
 * unchanged: a server-derived actor skips the picker, a 401 falls back to
 * `?actor=`, and an offline start uses the cached id.
 */

import { describe, expect, it, vi } from "vitest";
import { ActionRejectedError, IdentityResolutionError } from "@ebbjs/client";
import {
  describeIdentityFailure,
  describeWriteError,
  resolveDemoIdentity,
  usesActorPicker,
  type IdentityCache,
} from "./identity";

const memoryCache = (
  entries: Record<string, string> = {},
): IdentityCache & {
  readonly entries: Record<string, string>;
} => ({
  entries,
  getItem: (key) => entries[key] ?? null,
  setItem: (key, value) => {
    entries[key] = value;
  },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tailscale = (actorId = "alice@example.com", displayName = "Alice") => ({
  actor_id: actorId,
  provider: "tailscale",
  display_name: displayName,
});

describe("usesActorPicker", () => {
  it("keeps the picker for bypass and drops it for server-derived actors", () => {
    expect(usesActorPicker("bypass")).toBe(true);
    expect(usesActorPicker("tailscale")).toBe(false);
    expect(usesActorPicker("external")).toBe(false);
  });
});

describe("resolveDemoIdentity", () => {
  it("uses the server-derived actor and caches it", async () => {
    const cache = memoryCache();

    const identity = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => json(tailscale()),
      cache,
    });

    expect(identity).toEqual({
      actorId: "alice@example.com",
      provider: "tailscale",
      displayName: "Alice",
      cached: false,
    });
    expect(
      JSON.parse(cache.entries["ebb-issue-tracker:identity:http://localhost:4000"] ?? "{}"),
    ).toMatchObject({ actorId: "alice@example.com", provider: "tailscale" });
  });

  it("falls back to the ?actor= pick when the headerless identity read is rejected", async () => {
    const cache = memoryCache();

    const identity = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "bob",
      fetchImpl: async () => new Response("", { status: 401 }),
      cache,
    });

    expect(identity).toEqual({ actorId: "bob", provider: "bypass", cached: false });
    expect(cache.entries).toEqual({});
  });

  it("starts offline from the cached actor after a network failure", async () => {
    const cache = memoryCache({
      "ebb-issue-tracker:identity:http://localhost:4000": JSON.stringify({
        actorId: "alice@example.com",
        provider: "tailscale",
        displayName: "Alice",
      }),
    });

    const identity = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      cache,
    });

    expect(identity).toEqual({
      actorId: "alice@example.com",
      provider: "tailscale",
      displayName: "Alice",
      cached: true,
    });
  });

  it("reports a network failure when there is nothing cached", async () => {
    const error = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      cache: memoryCache(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IdentityResolutionError);
    expect(error).toMatchObject({ kind: "network" });
  });

  it("does not mask a proxy or server failure with a cached actor", async () => {
    const cache = memoryCache({
      "ebb-issue-tracker:identity:http://localhost:4000": JSON.stringify({
        actorId: "alice@example.com",
        provider: "tailscale",
      }),
    });

    const error = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => new Response("boom", { status: 503 }),
      cache,
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ kind: "http", status: 503 });
  });

  it("treats a changed actor as a new login and overwrites the cache", async () => {
    const cache = memoryCache({
      "ebb-issue-tracker:identity:http://localhost:4000": JSON.stringify({
        actorId: "alice@example.com",
        provider: "tailscale",
      }),
    });

    const identity = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => json(tailscale("bob@example.com", "Bob")),
      cache,
    });

    expect(identity.actorId).toBe("bob@example.com");
    expect(
      JSON.parse(cache.entries["ebb-issue-tracker:identity:http://localhost:4000"] ?? "{}"),
    ).toMatchObject({ actorId: "bob@example.com" });
  });

  it("tolerates a corrupt cache entry", async () => {
    const cache = memoryCache({
      "ebb-issue-tracker:identity:http://localhost:4000": "{not json",
    });

    const error = await resolveDemoIdentity({
      serverUrl: "http://localhost:4000",
      fallbackActorId: "alice",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      cache,
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ kind: "network" });
  });
});

describe("describeIdentityFailure", () => {
  it.each([
    [new IdentityResolutionError("unauthorized", "no"), /tailscale-served URL/i],
    [new IdentityResolutionError("invalid-response", "no"), /proxy login page/i],
    [new IdentityResolutionError("http", "no", { status: 502 }), /HTTP 502/],
    [new IdentityResolutionError("network", "no"), /cached actor/i],
  ])("explains %#", (error, expected) => {
    expect(describeIdentityFailure(error)).toMatch(expected);
  });
});

describe("describeWriteError", () => {
  it("turns actor_mismatch into a reload instruction", () => {
    const error = new ActionRejectedError([
      { id: "action_1", subjectType: "issue", reason: "actor_mismatch", details: "stale" },
    ]);

    expect(describeWriteError(error)).toMatch(/Reload the page/i);
  });

  it("leaves other rejections and errors alone", () => {
    const other = new ActionRejectedError([
      { id: "action_1", subjectType: "issue", reason: "permission_denied" },
    ]);
    expect(describeWriteError(other)).toBeNull();
    expect(describeWriteError(new Error("boom"))).toBeNull();
  });
});

describe("resolveDemoIdentity cache default", () => {
  it("runs without a browser storage", async () => {
    const identity = await resolveDemoIdentity({
      serverUrl: "",
      fallbackActorId: "alice",
      fetchImpl: vi.fn(async () => json(tailscale())),
      cache: null,
    });

    expect(identity.actorId).toBe("alice@example.com");
  });
});
