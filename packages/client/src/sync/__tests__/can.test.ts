/**
 * The read-only permission query (#322). `client.can(...)` answers the
 * same `<type>.<verb>` question the write-path pre-check (#319) answers,
 * so an app can hide or disable a control before attempting a write.
 *
 * The result is a discriminated union: `allowed` / `denied` are
 * decisions; `unknown` (no handshake, an unresolvable entity, or an
 * entity with no local owner) means the server remains the authority and
 * is never folded into `denied`.
 */

import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";

import { createClient } from "../client";
import { makeFetchMock, platformEntity } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

/** A materialized user row. Platform rows use `platformEntity`. */
const mkEntity = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  deletedHlc: string | null = null,
): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u_1" }]),
    ),
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: deletedHlc,
  last_gsn: 0,
});

const handshakeBody = (groups: readonly (readonly [string, string[]])[]): unknown => ({
  actor_id: ACTOR_ID,
  groups: groups.map(([id, permissions]) => ({
    id,
    permissions,
    cursor_valid: true,
    reason: null,
    cursor: 0,
  })),
});

/** A client whose `handshake()` reports `groups`. */
const mkClient = async (groups: readonly (readonly [string, string[]])[]) => {
  const { fn, calls } = makeFetchMock([
    {
      body: JSON.stringify(handshakeBody(groups)),
      headers: { "content-type": "application/json" },
    },
    { body: JSON.stringify({ rejected: [] }), headers: { "content-type": "application/json" } },
    { body: JSON.stringify({ rejected: [] }), headers: { "content-type": "application/json" } },
  ]);
  const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl: fn });
  await client.handshake();
  return { client, calls };
};

/** A client that has never run `handshake()`. */
const mkPreHandshakeClient = () => {
  const { fn, calls } = makeFetchMock([
    { body: JSON.stringify({ rejected: [] }), headers: { "content-type": "application/json" } },
  ]);
  const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl: fn });
  return { client, calls };
};

describe("client.can — global form", () => {
  it("allows an exact grant from the handshake", async () => {
    const { client } = await mkClient([["g_1", ["todo.update"]]]);
    await expect(client.can("todo.update")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1"],
    });
  });

  it("allows a type.* wildcard grant", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await expect(client.can("todo.delete")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1"],
    });
  });

  it("denies when no actor group grants the permission", async () => {
    const { client } = await mkClient([["g_1", ["todo.update"]]]);
    await expect(client.can("todo.create")).resolves.toEqual({
      kind: "denied",
      violation: {
        kind: "missing-permission",
        model: "todo",
        subjectId: "*",
        required: "todo.create",
        groupIds: ["g_1"],
      },
    });
  });

  it("reflects grants from local groupMember rows, not just the handshake", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      platformEntity("gm_1", "grant", {
        actor_id: ACTOR_ID,
        group_id: "g_2",
        permissions: ["list.*"],
      }),
    );
    await expect(client.can("list.delete")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1", "g_2"],
    });
  });

  it("ignores another actor's groupMember rows", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      platformEntity("gm_1", "grant", {
        actor_id: "actor_2",
        group_id: "g_2",
        permissions: ["list.*"],
      }),
    );
    const result = await client.can("list.delete");
    expect(result.kind).toBe("denied");
  });

  it("reports unknown — not denied — before handshake()", async () => {
    const { client } = mkPreHandshakeClient();
    await expect(client.can("todo.update")).resolves.toEqual({
      kind: "unknown",
      reason: "no-handshake",
    });
  });

  it("denies, rather than reporting unknown, for a handshake with zero groups", async () => {
    // A successful handshake that reports no groups is a known state —
    // the actor holds nothing — so the answer is a definite `denied`.
    const { client } = await mkClient([]);
    await expect(client.can("todo.update")).resolves.toEqual({
      kind: "denied",
      violation: {
        kind: "missing-permission",
        model: "todo",
        subjectId: "*",
        required: "todo.update",
        groupIds: [],
      },
    });
  });

  it("throws on a malformed permission string", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await expect(client.can("todo")).rejects.toBeInstanceOf(TypeError);
    await expect(client.can("todo.frobnicate")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("client.can — per-entity form", () => {
  it("resolves the entity's group set and union-matches", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.update"]],
    ]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(client.can("todo_1", "update")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1", "g_2"],
    });
  });

  it("denies with the missing permission and the consulted groups", async () => {
    const { client } = await mkClient([["g_1", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(client.can("todo_1", "delete")).resolves.toEqual({
      kind: "denied",
      violation: {
        kind: "missing-permission",
        model: "todo",
        subjectId: "todo_1",
        required: "todo.delete",
        groupIds: ["g_1"],
      },
    });
  });

  it("accepts an entity-like subject carrying an id", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const result = await client.can({ id: "todo_1" }, "update");
    expect(result.kind).toBe("allowed");
  });

  it("reports unknown for an entity the local store cannot resolve", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await expect(client.can("todo_missing", "update")).resolves.toEqual({
      kind: "unknown",
      reason: "entity-unknown",
    });
  });

  it("reports unknown for an entity with no local owner", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await expect(client.can("todo_1", "update")).resolves.toEqual({
      kind: "unknown",
      reason: "no-owner",
    });
  });

  it("reports unknown — not denied — before handshake()", async () => {
    const { client } = mkPreHandshakeClient();
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await expect(client.can("todo_1", "update")).resolves.toEqual({
      kind: "unknown",
      reason: "no-handshake",
    });
  });
});

describe("client.can — system entities", () => {
  it("checks a group against itself", async () => {
    const { client } = await mkClient([["g_1", ["ebb/group.*"]]]);
    await client.storage.entities.set(platformEntity("g_1", "group", { name: "G" }));
    await expect(client.can("g_1", "update")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1"],
    });
  });

  it("checks a grant against its group", async () => {
    const { client } = await mkClient([["g_1", ["ebb/grant.delete"]]]);
    await client.storage.entities.set(
      platformEntity("gm_1", "grant", { actor_id: "actor_2", group_id: "g_1", permissions: [] }),
    );
    await expect(client.can("gm_1", "delete")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1"],
    });
  });

  it("checks a membership delete against the entity's set", async () => {
    const { client } = await mkClient([["g_2", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );
    await expect(client.can("eg_1", "delete")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_1", "g_2"],
    });
  });

  it("checks a relationship patch against the source's set, not the target's", async () => {
    const { client } = await mkClient([
      ["g_src", ["ebb/link.update"]],
      ["g_tgt", []],
    ]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("rel_1", "link", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      platformEntity("eg_src", "membership", { entity_id: "todo_1", group_id: "g_src" }),
    );
    await expect(client.can("rel_1", "update")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_src"],
    });
  });

  it("checks a relationship create against the source type's update permission", async () => {
    const { client } = await mkClient([["g_src", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("rel_1", "link", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      platformEntity("eg_src", "membership", { entity_id: "todo_1", group_id: "g_src" }),
    );
    await expect(client.can("rel_1", "create")).resolves.toEqual({
      kind: "allowed",
      groupIds: ["g_src"],
    });
  });
});
