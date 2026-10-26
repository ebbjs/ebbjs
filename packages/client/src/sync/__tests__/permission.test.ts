/**
 * The local permission pre-check (#319). A client that has completed
 * `handshake()` — so it knows its own group permissions — refuses a
 * locally-authored Update it lacks `<type>.<verb>` for, before the
 * Action reaches the Outbox. The server stays the authority; the pass
 * is best-effort and skips when the actor's groups are unknown.
 *
 * The rules mirror `EbbServer.Storage.Authorizer` /
 * `PermissionHelper`: per-Update, union semantics over an entity's
 * group set, and the group bootstrap exemption.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Entity, type Update } from "@ebbjs/core";

import { createClient } from "../client";
import { PermissionError } from "../permission";
import { makeFetchMock, type FetchCall } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

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
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: deletedHlc,
  last_gsn: 0,
});

const field = (value: unknown): { value: unknown; update_id: string } => ({
  value,
  update_id: "u_1",
});

const fields = (
  values: Record<string, unknown>,
): Record<string, { value: unknown; update_id: string }> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, field(v)]));

const update = (
  subjectType: string,
  subjectId: string,
  method: "put" | "patch" | "delete",
  values: Record<string, unknown> = {},
): Update => ({
  id: `u_${subjectId}_${method}`,
  subject_id: subjectId,
  subject_type: subjectType,
  method,
  data: method === "delete" ? null : { fields: fields(values) },
});

const action = (updates: readonly Update[]): Action => ({
  id: "a_1",
  actor_id: ACTOR_ID,
  hlc: makeHlc(1_711_036_800_000),
  gsn: 0,
  updates: [...updates],
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

const actionRequests = (calls: readonly FetchCall[]): FetchCall[] =>
  calls.filter((call) => call.url.endsWith("/sync/actions"));

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

describe("collectPermissionViolations — user entities", () => {
  it("throws locally and never enqueues or POSTs when the permission is missing", async () => {
    const { client, calls } = await mkClient([["g_1", ["list.*"]]]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("todo", "todo_1", "put", { title: "Ship" })])]),
    ).rejects.toBeInstanceOf(PermissionError);

    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("reports the subject, the missing permission and the checked groups", async () => {
    const { client } = await mkClient([["g_1", ["list.*"]]]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const error = await client
      .write([action([update("todo", "todo_1", "put", { title: "Ship" })])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        subjectType: "todo",
        subjectId: "todo_1",
        required: "todo.create",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("passes an update held in any one of the entity's groups", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.update"]],
    ]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([action([update("todo", "todo_1", "patch", { title: "Renamed" })])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("passes a delete held in any one of the entity's groups", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.delete"]],
    ]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(client.write([action([update("todo", "todo_1", "delete")])])).resolves.toEqual({
      rejected: [],
    });
  });

  it("accepts the wildcard permission <type>.*", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("todo", "todo_1", "patch", { title: "Renamed" })])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a write whose entity resolves to no group", async () => {
    const { client, calls } = await mkClient([["g_1", []]]);

    await expect(
      client.write([action([update("todo", "unowned", "put", { title: "Ship" })])]),
    ).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it.each(["put", "patch", "delete"] as const)(
    "refuses a wire type that contradicts the committed type for a %s",
    async (method) => {
      const { client, calls } = await mkClient([["g_1", ["todo.*"]]]);
      await client.storage.entities.set(mkEntity("invoice_1", "invoice", { amount: 100 }));
      await client.storage.entities.set(
        mkEntity("eg_1", "entityGroup", { entity_id: "invoice_1", group_id: "g_1" }),
      );

      // The wire claims `todo`, which the actor holds; the entity is
      // committed as an `invoice`, so the relabel is refused whatever the
      // permission (#624).
      const error = await client
        .write([action([update("todo", "invoice_1", method, { amount: 999_999 })])])
        .then(() => null)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PermissionError);
      expect((error as PermissionError).violations).toEqual([
        {
          kind: "type-mismatch",
          subjectType: "todo",
          subjectId: "invoice_1",
          committedType: "invoice",
          groupIds: ["g_1"],
        },
      ]);
      expect(client.outbox.size()).toBe(0);
      expect(actionRequests(calls)).toHaveLength(0);
    },
  );

  it("refuses a forged wire type even when the actor holds the committed type's permission", async () => {
    // The server rejects a wire type that contradicts the committed one
    // outright, so holding `<committed>.<verb>` is no licence to relabel,
    // and no missing permission is the reason (#624).
    const { client } = await mkClient([["g_1", ["todo.*", "invoice.*"]]]);
    await client.storage.entities.set(mkEntity("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    const error = await client
      .write([action([update("todo", "invoice_1", "put", { amount: 999_999 })])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).message).toContain(
      'todo invoice_1: declared type "todo" but the entity is committed as "invoice"',
    );
    expect((error as PermissionError).message).not.toContain("missing");
    expect(client.outbox.size()).toBe(0);
  });

  it("passes a write that declares the entity's committed type", async () => {
    const { client } = await mkClient([["g_1", ["invoice.create"]]]);
    await client.storage.entities.set(mkEntity("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("invoice", "invoice_1", "put", { amount: 200 })])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("uses the wire type for an id the local store does not know", async () => {
    // A new entity has no committed type, so the wire type stands (#624)
    // — for the grant that satisfies it and for the one that does not.
    const allowed = await mkClient([["g_1", ["todo.create"]]]);
    await allowed.client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await expect(
      allowed.client.write([action([update("todo", "todo_1", "put", { title: "Ship" })])]),
    ).resolves.toEqual({ rejected: [] });

    const denied = await mkClient([["g_1", ["invoice.create"]]]);
    await denied.client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    const error = await denied.client
      .write([action([update("todo", "todo_1", "put", { title: "Ship" })])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        subjectType: "todo",
        subjectId: "todo_1",
        required: "todo.create",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("agrees with can() that a forged wire type is not a way in", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(mkEntity("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    // can() has no wire type to compare, so it reports the permission the
    // committed type would need; write() refuses the relabel before it
    // ever gets that far. Both refuse.
    expect(await client.can("invoice_1", "create")).toEqual({
      kind: "denied",
      violation: {
        kind: "missing-permission",
        subjectType: "invoice",
        subjectId: "invoice_1",
        required: "invoice.create",
        groupIds: ["g_1"],
      },
    });

    const error = await client
      .write([action([update("todo", "invoice_1", "put", { amount: 999_999 })])])
      .then(() => null)
      .catch((err: unknown) => err);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "type-mismatch",
        subjectType: "todo",
        subjectId: "invoice_1",
        committedType: "invoice",
        groupIds: ["g_1"],
      },
    ]);
  });
});

describe("collectPermissionViolations — relationship edges", () => {
  const relUpdate = (sourceId: string, targetId: string, type: string): Update =>
    update("relationship", "rel_1", "put", {
      source_id: sourceId,
      target_id: targetId,
      field: "list",
      type,
    });

  it("checks the source entity's group set, not the target's", async () => {
    const { client, calls } = await mkClient([
      ["g_source", ["list.*"]],
      ["g_target", ["todo.update"]],
    ]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_source" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_tgt", "entityGroup", { entity_id: "list_1", group_id: "g_target" }),
    );

    await expect(
      client.write([action([relUpdate("todo_1", "list_1", "todo")])]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("authorizes a new edge by the wire source over the source's group set", async () => {
    // No local row means no committed source to contradict: the wire
    // source names the edge being created.
    const { client } = await mkClient([
      ["g_source", ["todo.update"]],
      ["g_target", ["list.*"]],
    ]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_source" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_tgt", "entityGroup", { entity_id: "list_1", group_id: "g_target" }),
    );

    await expect(client.write([action([relUpdate("todo_1", "list_1", "todo")])])).resolves.toEqual({
      rejected: [],
    });
  });

  it("ignores a forged wire type and checks the source's true type", async () => {
    const { client, calls } = await mkClient([["g_source", ["comment.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_source" }),
    );

    // The wire claims `comment`, which the actor holds; the source is
    // really a `todo`, which the actor may not update (#323).
    await expect(
      client.write([action([relUpdate("todo_1", "list_1", "comment")])]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("accepts a custom wire type when the source's true type is permitted", async () => {
    const { client } = await mkClient([["g_source", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_source" }),
    );

    await expect(
      client.write([action([relUpdate("todo_1", "list_1", "todo.belongsTo.list")])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("passes a put that restates the row's own source", async () => {
    const { client } = await mkClient([["g_src", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_src" }),
    );

    await expect(client.write([action([relUpdate("todo_1", "list_1", "todo")])])).resolves.toEqual({
      rejected: [],
    });
  });

  it("passes a patch that restates the row's own source", async () => {
    const { client } = await mkClient([["g_src", ["relationship.update"]]]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_src" }),
    );

    await expect(
      client.write([
        action([
          update("relationship", "rel_1", "patch", { source_id: "todo_1", target_id: "list_2" }),
        ]),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a put that does not carry its source id", async () => {
    const { client } = await mkClient([["g_1", []]]);

    await expect(
      client.write([action([update("relationship", "rel_1", "put", { target_id: "list_1" })])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("refuses a patch that re-points the edge at another source", async () => {
    // A relationship row's source is row identity: the server refuses a
    // declared source other than the row's own, so no permission can
    // re-point the edge here either. Moving an edge is delete + put.
    const { client, calls } = await mkClient([
      ["g_grant", ["relationship.update"]],
      ["g_plain", []],
    ]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_old",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_old", "entityGroup", { entity_id: "todo_old", group_id: "g_plain" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_new", "entityGroup", { entity_id: "todo_new", group_id: "g_grant" }),
    );

    const error = await client
      .write([action([update("relationship", "rel_1", "patch", { source_id: "todo_new" })])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "source-mismatch",
        subjectType: "relationship",
        subjectId: "rel_1",
        declaredSourceId: "todo_new",
        committedSourceId: "todo_old",
        groupIds: ["g_plain"],
      },
    ]);
    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("accepts a re-put of a locally tombstoned edge that declares another source", async () => {
    // The server's by-id row is gone, so it sees a new edge and authorizes
    // the put by the declared source; a tombstoned local row is not a
    // committed source either.
    const { client } = await mkClient([["g_new", ["todo.update"]]]);
    await client.storage.entities.set(
      mkEntity(
        "rel_1",
        "relationship",
        { source_id: "todo_old", target_id: "list_1", field: "list", type: "todo" },
        "9",
      ),
    );
    await client.storage.entities.set(mkEntity("todo_new", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_new", "entityGroup", { entity_id: "todo_new", group_id: "g_new" }),
    );

    await expect(
      client.write([
        action([
          update("relationship", "rel_1", "put", {
            source_id: "todo_new",
            target_id: "list_2",
            field: "list",
            type: "todo",
          }),
        ]),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  // A source binding is released by a delete in the same request, exactly
  // as the server's request simulation does; the actor holds
  // `relationship.delete` over the stored source and `todo.update` over
  // the new one, so delete + put is the move that re-points the edge.
  const mkMovingEdgeClient = async () => {
    const { client, calls } = await mkClient([
      ["g_old", ["relationship.delete"]],
      ["g_new", ["todo.update"]],
    ]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_old",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(mkEntity("todo_old", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_old", "entityGroup", { entity_id: "todo_old", group_id: "g_old" }),
    );
    await client.storage.entities.set(mkEntity("todo_new", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_new", "entityGroup", { entity_id: "todo_new", group_id: "g_new" }),
    );
    return { client, calls };
  };

  it("accepts a delete and a re-put to another source in one Action", async () => {
    const { client, calls } = await mkMovingEdgeClient();

    await expect(
      client.write([
        action([
          update("relationship", "rel_1", "delete"),
          relUpdate("todo_new", "list_2", "todo"),
        ]),
      ]),
    ).resolves.toEqual({ rejected: [] });
    expect(client.outbox.size("acknowledged")).toBe(1);
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it("accepts a delete and a re-put to another source split across Actions", async () => {
    const { client, calls } = await mkMovingEdgeClient();

    await expect(
      client.write([
        action([update("relationship", "rel_1", "delete")]),
        { ...action([relUpdate("todo_new", "list_2", "todo")]), id: "a_2" },
      ]),
    ).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it("refuses a put that re-points a committed edge with no delete in the batch", async () => {
    const { client, calls } = await mkMovingEdgeClient();

    const error = await client
      .write([action([relUpdate("todo_new", "list_2", "todo")])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "source-mismatch",
        subjectType: "relationship",
        subjectId: "rel_1",
        declaredSourceId: "todo_new",
        committedSourceId: "todo_old",
        groupIds: ["g_old"],
      },
    ]);
    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("refuses a put whose delete comes in a later Action of the same write()", async () => {
    // The server advances its simulation only for Actions it has already
    // accepted, so a delete that follows the put cannot release it.
    const { client, calls } = await mkMovingEdgeClient();

    const error = await client
      .write([
        action([relUpdate("todo_new", "list_2", "todo")]),
        { ...action([update("relationship", "rel_1", "delete")]), id: "a_2" },
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "source-mismatch",
        subjectType: "relationship",
        subjectId: "rel_1",
        declaredSourceId: "todo_new",
        committedSourceId: "todo_old",
        groupIds: ["g_old"],
      },
    ]);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("does not release a delete carried by an Action that is refused", async () => {
    // Only an accepted Action advances the request simulation, so a
    // sibling violation in the same Action must keep its delete from
    // releasing the binding for the next Action.
    const { client } = await mkMovingEdgeClient();
    await client.storage.entities.set(
      mkEntity("eg_denied", "entityGroup", { entity_id: "todo_1", group_id: "g_old" }),
    );

    const error = await client
      .write([
        action([
          update("relationship", "rel_1", "delete"),
          update("todo", "todo_1", "put", { title: "Ship" }),
        ]),
        { ...action([relUpdate("todo_new", "list_2", "todo")]), id: "a_2" },
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        subjectType: "todo",
        subjectId: "todo_1",
        required: "todo.create",
        groupIds: ["g_old"],
      },
      {
        kind: "source-mismatch",
        subjectType: "relationship",
        subjectId: "rel_1",
        declaredSourceId: "todo_new",
        committedSourceId: "todo_old",
        groupIds: ["g_old"],
      },
    ]);
  });

  it("ignores a delete's wire source and authorizes against the stored row", async () => {
    // The server resolves a delete's groups from the stored row and never
    // looks at a wire `source_id`, so a stale one may not refuse it here.
    const { client } = await mkClient([
      ["g_owner", ["relationship.delete"]],
      ["g_foreign", []],
    ]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_old",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_owner", "entityGroup", { entity_id: "todo_old", group_id: "g_owner" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_foreign", "entityGroup", { entity_id: "todo_new", group_id: "g_foreign" }),
    );

    await expect(
      client.write([
        action([
          {
            ...update("relationship", "rel_1", "delete"),
            data: { fields: fields({ source_id: "todo_new" }) },
          },
        ]),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("does not let a delete borrow the wire source's permission", async () => {
    // `relationship.delete` is held for the source the wire names, not for
    // the stored row's source: the stored row's set decides.
    const { client } = await mkClient([
      ["g_owner", []],
      ["g_foreign", ["relationship.delete"]],
    ]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_old",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_owner", "entityGroup", { entity_id: "todo_old", group_id: "g_owner" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_foreign", "entityGroup", { entity_id: "todo_new", group_id: "g_foreign" }),
    );

    const error = await client
      .write([
        action([
          {
            ...update("relationship", "rel_1", "delete"),
            data: { fields: fields({ source_id: "todo_new" }) },
          },
        ]),
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        subjectType: "relationship",
        subjectId: "rel_1",
        required: "relationship.delete",
        groupIds: ["g_owner"],
      },
    ]);
  });

  it("resolves a delete's source from the local relationship row", async () => {
    const { client } = await mkClient([
      ["g_1", ["relationship.delete"]],
      ["g_2", []],
    ]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("relationship", "rel_1", "delete")])]),
    ).resolves.toEqual({ rejected: [] });
  });
});

describe("collectPermissionViolations — entityGroup membership", () => {
  it("requires <type>.create in the target group for a put", async () => {
    const { client, calls } = await mkClient([["g_1", ["todo.update"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));

    await expect(
      client.write([
        action([update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })]),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("passes a put when the target group holds <type>.create", async () => {
    const { client } = await mkClient([["g_1", ["todo.create"]]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));

    await expect(
      client.write([
        action([update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })]),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a put whose entity type cannot be resolved", async () => {
    const { client } = await mkClient([["g_1", []]]);

    await expect(
      client.write([
        action([update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })]),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("requires <type>.update in the entity's current set for a delete", async () => {
    const { client, calls } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([action([update("entityGroup", "eg_1", "delete")])]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("passes a delete when another of the entity's groups holds <type>.update", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.update"]],
    ]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([action([update("entityGroup", "eg_1", "delete")])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a delete whose membership row cannot be resolved", async () => {
    const { client } = await mkClient([["g_1", []]]);

    await expect(
      client.write([action([update("entityGroup", "eg_missing", "delete")])]),
    ).resolves.toEqual({ rejected: [] });
  });
});

describe("collectPermissionViolations — group bootstrap", () => {
  it("exempts a group bootstrap and honors its declared permissions", async () => {
    const { client, calls } = await mkClient([["g_old", []]]);

    const created = action([
      update("group", "g_new", "put", { id: "g_new" }),
      update("groupMember", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*", "group.*", "groupMember.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    ]);

    await expect(client.write([created])).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it("checks a lone group put rather than treating it as a bootstrap", async () => {
    const { client } = await mkClient([["g_old", []]]);

    await expect(
      client.write([action([update("group", "g_new", "put", { name: "New" })])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("allows a subsequent write to a group the actor bootstrapped", async () => {
    const { client } = await mkClient([["g_old", []]]);
    const created = action([
      update("group", "g_new", "put", { name: "New" }),
      update("groupMember", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    ]);
    await client.write([created]);

    const followUp = action([
      update("todo", "todo_2", "put", { title: "Ship again" }),
      update("entityGroup", "eg_2", "put", { entity_id: "todo_2", group_id: "g_new" }),
    ]);
    await expect(client.write([followUp])).resolves.toEqual({ rejected: [] });
  });

  it("does not exempt an entityGroup put for an entity that already exists", async () => {
    const { client } = await mkClient([["g_old", []]]);
    await client.storage.entities.set(mkEntity("todo_1", "todo", {}));

    const created = action([
      update("group", "g_new", "put", { id: "g_new" }),
      update("groupMember", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("entityGroup", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    ]);

    await expect(client.write([created])).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("collectPermissionViolations — best-effort", () => {
  it("skips the pass when the actor's groups are not yet known", async () => {
    const { fn, calls } = makeFetchMock([
      { body: JSON.stringify({ rejected: [] }), headers: { "content-type": "application/json" } },
    ]);
    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl: fn });
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("todo", "todo_1", "put", { title: "Ship" })])]),
    ).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
    expect(client.outbox.size("acknowledged")).toBe(1);
  });

  it("aggregates violations across every Action in the batch", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      mkEntity("eg_2", "entityGroup", { entity_id: "todo_2", group_id: "g_1" }),
    );

    const error = await client
      .write([
        action([update("todo", "todo_1", "put", { title: "One" })]),
        { ...action([update("todo", "todo_2", "put", { title: "Two" })]), id: "a_2" },
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations.map((v) => v.subjectId)).toEqual([
      "todo_1",
      "todo_2",
    ]);
  });

  it("lets a locally-allowed write reach a server rejection that lands in outbox.errors()", async () => {
    // A permission revoked server-side while offline: the cached
    // handshake still allows it, the server refuses, and the outbox
    // records the error rather than the client blocking it locally.
    const { fn } = makeFetchMock([
      {
        body: JSON.stringify(handshakeBody([["g_1", ["todo.create"]]])),
        headers: { "content-type": "application/json" },
      },
      {
        body: JSON.stringify({ rejected: [{ id: "a_1", reason: "not_authorized" }] }),
        headers: { "content-type": "application/json" },
      },
    ]);
    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl: fn });
    await client.handshake();
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const response = await client.write([
      action([update("todo", "todo_1", "put", { title: "Ship" })]),
    ]);
    expect(response.rejected.map((rejection) => rejection.id)).toEqual(["a_1"]);
    expect(client.outbox.errors().map((entry) => entry.action.id)).toEqual(["a_1"]);
  });
});

describe("collectPermissionViolations — system entities", () => {
  it("requires group.create in the group for a put", async () => {
    const { client } = await mkClient([["g_1", ["group.update"]]]);

    await expect(
      client.write([action([update("group", "g_1", "put", { name: "G" })])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("passes a group put when the target group grants group.create", async () => {
    const { client } = await mkClient([["g_1", ["group.*"]]]);

    await expect(
      client.write([action([update("group", "g_1", "put", { name: "G" })])]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("requires groupMember.create in the target group for a put", async () => {
    const { client } = await mkClient([["g_1", ["groupMember.update"]]]);

    await expect(
      client.write([
        action([
          update("groupMember", "gm_1", "put", {
            actor_id: "actor_2",
            group_id: "g_1",
            permissions: [],
          }),
        ]),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("resolves a groupMember delete's group from the local row", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      mkEntity("gm_1", "groupMember", { actor_id: "actor_2", group_id: "g_1", permissions: [] }),
    );

    await expect(
      client.write([action([update("groupMember", "gm_1", "delete")])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("requires entityGroup.update in the membership's group for a patch", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      mkEntity("eg_1", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("entityGroup", "eg_1", "patch", { group_id: "g_1" })])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("requires relationship.update in the edge's source group set for a patch", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    await client.storage.entities.set(
      mkEntity("eg_src", "entityGroup", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action([update("relationship", "rel_1", "patch", { target_id: "list_2" })])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("PermissionError", () => {
  it("formats its message from the violations", () => {
    const error = new PermissionError([
      {
        kind: "missing-permission",
        subjectType: "todo",
        subjectId: "todo_1",
        required: "todo.create",
        groupIds: ["g_1"],
      },
    ]);

    expect(error.name).toBe("PermissionError");
    expect(error.violations).toHaveLength(1);
    expect(error.message).toContain("PermissionError: 1 violation(s)");
    expect(error.message).toContain("todo todo_1");
    expect(error.message).toContain("todo.create");
    expect(error.message).toContain("g_1");
  });

  it("names both sources for a re-point and no missing permission", () => {
    const error = new PermissionError([
      {
        kind: "source-mismatch",
        subjectType: "relationship",
        subjectId: "rel_1",
        declaredSourceId: "todo_new",
        committedSourceId: "todo_old",
        groupIds: ["g_plain"],
      },
    ]);

    expect(error.message).toContain(
      'relationship rel_1: declared source "todo_new" but the row is committed with source "todo_old"',
    );
    expect(error.message).toContain("a relationship row cannot be re-pointed at another source");
    expect(error.message).not.toContain("missing");
    expect(error.message).not.toContain("relationship.update");
  });

  it("names both types for a mismatch and no missing permission", () => {
    const error = new PermissionError([
      {
        kind: "type-mismatch",
        subjectType: "todo",
        subjectId: "invoice_1",
        committedType: "invoice",
        groupIds: ["g_1"],
      },
    ]);

    expect(error.message).toContain(
      'todo invoice_1: declared type "todo" but the entity is committed as "invoice"',
    );
    expect(error.message).toContain("an entity's type cannot change");
    expect(error.message).not.toContain("missing");
    expect(error.message).not.toContain("todo.create");
  });
});
