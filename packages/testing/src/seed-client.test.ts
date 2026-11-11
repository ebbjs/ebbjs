/**
 * Unit tests for the server's raw-POST seed harness.
 *
 * `seed()` builds one Action from plain `SeedData` and submits it over
 * HTTP; these tests pin the POST shape and the shared
 * rejection-tolerance policy, with `fetch` stubbed so no server is
 * required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";

import { SeedRejectedError, seed, type SeedData } from "./seed-client";

const rejection = (reason: string) => ({ id: "action_1", reason });

/** A small fixture exercising each row kind the builder emits. */
const seedData: SeedData = {
  groups: [{ id: "grp_1", name: "Group One" }],
  groupMembers: [{ id: "gm_1", actorId: "actor_1", groupId: "grp_1", permissions: ["todo.*"] }],
  entities: [{ id: "todo_1", type: "todo", patches: [{ fields: { title: "Ship it" } }] }],
  entityGroups: [{ id: "eg_1", entityId: "todo_1", groupId: "grp_1" }],
};

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("seed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts one msgpack Action to /sync/actions with the actor header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return okResponse({ rejected: [] });
    });

    // A trailing slash on the base URL must not double the path separator.
    await seed("http://localhost:4000/", "actor_1", seedData);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://localhost:4000/sync/actions");
    expect(seen[0]!.init.method).toBe("POST");

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["x-ebb-actor-id"]).toBe("actor_1");
    expect(headers["Content-Type"]).toBe("application/msgpack");

    const actions = decodeSync<{ actions: Action[] }>(seen[0]!.init.body as Uint8Array).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actor_id).toBe("actor_1");
  });

  it("treats an empty success body as an accepted seed", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));

    await expect(seed("http://localhost:4000", "actor_1", seedData)).resolves.toBeUndefined();
  });

  it("rejects with SeedRejectedError when a row is refused", async () => {
    vi.stubGlobal("fetch", async () => okResponse({ rejected: [rejection("not_authorized")] }));

    await expect(seed("http://localhost:4000", "actor_1", seedData)).rejects.toBeInstanceOf(
      SeedRejectedError,
    );
  });

  it("rejects on a non-ok response", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));

    await expect(seed("http://localhost:4000", "actor_1", seedData)).rejects.toThrow(
      /Seed failed: 500/,
    );
  });
});
