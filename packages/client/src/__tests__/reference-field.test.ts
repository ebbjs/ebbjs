/**
 * Acceptance tests for `e.reference({ of })` — issue #454.
 *
 * A reference is wire-level a string, so it must round-trip through the
 * typed client's `create` / `query` / `get` unchanged while the schema
 * keeps it distinguishable from free text.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "../schema/entity";
import { defineSchema } from "../schema/schema";
import { createClient } from "../sync/client";
import { jsonResponse } from "../sync/test-utils";

const HANDSHAKE = {
  actor_id: "actor_1",
  groups: [
    {
      id: "g_1",
      permissions: ["issue.*"],
      cursor_valid: true,
      reason: null,
      cursor: 0,
    },
  ],
};

const issue = defineEntity("issue", {
  title: e.string(),
  workspace_id: e.reference({ of: "workspace" }),
  assignee_id: e.reference({ of: "actor" }).nullable(),
});

const schema = defineSchema({ entities: { issue }, version: 1 });

const harness = () => {
  const storage = createMemoryAdapter();
  const written: Action[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/sync/handshake")) return jsonResponse(HANDSHAKE);
    if (url.endsWith("/sync/actions")) {
      if (init?.body instanceof Uint8Array) {
        written.push(...decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
  const client = createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage,
    schema,
    fetchImpl,
  });
  return { client, written };
};

describe("e.reference() round-trip", () => {
  it("creates, gets, and queries a reference as a plain string", async () => {
    const { client, written } = harness();
    await client.handshake();

    const { id } = await client.issue.create(
      { title: "Broken build", workspace_id: "ws_1", assignee_id: "actor_2" },
      { groups: ["g_1"] },
    );

    // On the wire the reference is an ordinary string field value.
    const issueUpdate = written[0]!.updates.find((u) => u.subject_type === "issue")!;
    const fields = issueUpdate.data!.fields as Record<string, { value: unknown }>;
    expect(fields.workspace_id!.value).toBe("ws_1");
    expect(fields.assignee_id!.value).toBe("actor_2");

    const row = await client.issue.get(id);
    expect(row).not.toBeNull();
    expect(row!.workspace_id).toBe("ws_1");
    expect(row!.assignee_id).toBe("actor_2");

    const rows = await client.issue.query();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace_id).toBe("ws_1");
    expect(rows[0]!.assignee_id).toBe("actor_2");
  });

  it("filters on a reference as an ordinary field predicate", async () => {
    const { client } = harness();
    await client.handshake();
    await client.issue.create(
      { title: "Mine", workspace_id: "ws_1", assignee_id: "actor_2" },
      { groups: ["g_1"] },
    );
    await client.issue.create(
      { title: "Theirs", workspace_id: "ws_2", assignee_id: "actor_3" },
      { groups: ["g_1"] },
    );

    const rows = await client.issue.query().where("workspace_id", "ws_1");
    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
  });

  it("treats a nullable reference as an ordinary nullable string", async () => {
    const { client } = harness();
    await client.handshake();
    const { id } = await client.issue.create(
      { title: "Unowned", workspace_id: "ws_1", assignee_id: null },
      { groups: ["g_1"] },
    );
    const row = await client.issue.get(id);
    expect(row!.assignee_id).toBeNull();
  });

  it("reports declared references through the registry after defineSchema", () => {
    expect(schema._registry.getReference("issue", "workspace_id")).toEqual({ of: "workspace" });
    expect(schema._registry.getReference("issue", "assignee_id")).toEqual({ of: "actor" });
    expect(schema._registry.getReference("issue", "title")).toBeUndefined();
  });
});
