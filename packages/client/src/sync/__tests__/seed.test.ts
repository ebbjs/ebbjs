/**
 * `SyncClient.seed` routes a {@link SeedData} through the public write
 * path — one `POST /sync/actions` — and applies the shared
 * rejection-tolerance policy.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";

import { createClient } from "../client";
import type { Rejection } from "../types";
import { SeedRejectedError, type SeedData } from "../../seed";

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** A small seed that reaches every system subject type the seed emits. */
const seedData: SeedData = {
  groups: [{ id: "grp_1", name: "Group One" }],
  groupMembers: [{ id: "gm_1", actorId: "actor_1", groupId: "grp_1", permissions: ["todo.*"] }],
  entities: [
    {
      id: "todo_1",
      type: "todo",
      patches: [{ fields: { title: { value: "Ship it", hlc: "1", update_id: "u1" } } }],
    },
  ],
  entityGroups: [{ id: "eg_1", entityId: "todo_1", groupId: "grp_1" }],
};

const mkClient = (
  rejectFor: (actions: readonly Action[]) => readonly Rejection[],
): { client: ReturnType<typeof createClient>; seen: RecordedRequest[] } => {
  const seen: RecordedRequest[] = [];
  const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : undefined;
    seen.push({ url, body });
    if (url.endsWith("/sync/actions")) {
      const actions = body === undefined ? [] : decodeSync<{ actions: Action[] }>(body).actions;
      return new Response(JSON.stringify({ rejected: rejectFor(actions) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    fetchImpl,
  });
  return { client, seen };
};

describe("client.seed", () => {
  it("submits one seed Action through the write path", async () => {
    const { client, seen } = mkClient(() => []);
    await client.seed(seedData);
    client.close();

    const calls = seen.filter((r) => r.url.endsWith("/sync/actions"));
    expect(calls).toHaveLength(1);
    const actions = decodeSync<{ actions: Action[] }>(calls[0]!.body!).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actor_id).toBe("actor_1");
    expect(actions[0]!.updates.map((u) => u.subject_type)).toEqual([
      "group",
      "groupMember",
      "todo",
      "entityGroup",
    ]);
  });

  it("tolerates already_exists / duplicate_action rejections", async () => {
    const { client } = mkClient(() => [
      { id: "a1", reason: "already_exists" },
      { id: "a1", reason: "duplicate_action" },
    ]);
    await expect(client.seed(seedData)).resolves.toBeUndefined();
    client.close();
  });

  it("throws SeedRejectedError on a non-tolerated rejection", async () => {
    const { client } = mkClient(() => [{ id: "a1", reason: "not_authorized" }]);
    await expect(client.seed(seedData)).rejects.toBeInstanceOf(SeedRejectedError);
    client.close();
  });
});
