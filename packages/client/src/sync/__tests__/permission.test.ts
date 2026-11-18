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
import { componentName, makeHlc, type Action, type Update } from "@ebbjs/core";

import { createClient } from "../client";
import { PermissionError } from "../permission";
import {
  entityRow,
  isPlatformModel,
  linkRow,
  linkValue,
  makeFetchMock,
  platformEntity,
  platformUpdate,
  type FetchCall,
} from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const field = (value: unknown): { value: unknown; update_id: string } => ({
  value,
  update_id: "u_1",
});

const fields = (
  values: Record<string, unknown>,
): Record<string, { value: unknown; update_id: string }> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, field(v)]));

/** The row fact a `put` opens with: a create names the model and no component. */
const create = (model: string, subjectId: string): Update => ({
  id: `u_${subjectId}_create`,
  subject_id: subjectId,
  model,
  method: "create",
  hlc: makeHlc(1),
  data: null,
});

/**
 * A `put` is a create followed by one Update per field (`replace`), a
 * `patch` is the field Updates alone (`merge`), and `delete` names no
 * component. A platform row is one atomic `replace` instead.
 */
const update = (
  model: string,
  subjectId: string,
  method: "put" | "patch" | "delete",
  values: Record<string, unknown> = {},
): Update[] =>
  isPlatformModel(model)
    ? platformUpdate(subjectId, model, method, values)
    : method === "delete"
      ? [{ id: `u_${subjectId}_delete`, subject_id: subjectId, method: "delete", data: null }]
      : [
          ...(method === "put" ? [create(model, subjectId)] : []),
          ...Object.entries(fields(values)).map(([name, value]) => ({
            id: `u_${subjectId}_${method}_${name}`,
            subject_id: subjectId,
            component: componentName(model, name),
            method: method === "put" ? ("replace" as const) : ("merge" as const),
            data: value,
          })),
        ];

/** One Action from any number of component-Update groups. */
const action = (...groups: readonly (readonly Update[])[]): Action => ({
  id: "a_1",
  actor_id: ACTOR_ID,
  hlc: makeHlc(1_711_036_800_000),
  gsn: 0,
  updates: groups.flat(),
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
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action(update("todo", "todo_1", "put", { title: "Ship" }))]),
    ).rejects.toBeInstanceOf(PermissionError);

    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("reports the subject, the missing permission and the checked groups", async () => {
    const { client } = await mkClient([["g_1", ["list.*"]]]);
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const error = await client
      .write([action(update("todo", "todo_1", "put", { title: "Ship" }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "todo",
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
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([action(update("todo", "todo_1", "patch", { title: "Renamed" }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("passes a delete held in any one of the entity's groups", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.delete"]],
    ]);
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(client.write([action(update("todo", "todo_1", "delete"))])).resolves.toEqual({
      rejected: [],
    });
  });

  it("accepts the wildcard permission <type>.*", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action(update("todo", "todo_1", "patch", { title: "Renamed" }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a write whose entity resolves to no group", async () => {
    const { client, calls } = await mkClient([["g_1", []]]);

    await expect(
      client.write([action(update("todo", "unowned", "put", { title: "Ship" }))]),
    ).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it.each(["put", "patch"] as const)(
    "refuses a wire type that contradicts the committed type for a %s",
    async (method) => {
      const { client, calls } = await mkClient([["g_1", ["todo.*"]]]);
      await client.storage.entities.set(entityRow("invoice_1", "invoice", { amount: 100 }));
      await client.storage.entities.set(
        platformEntity("eg_1", "membership", { entity_id: "invoice_1", group_id: "g_1" }),
      );

      // The wire claims `todo`, which the actor holds; the entity is
      // committed as an `invoice`, so the relabel is refused whatever the
      // permission (#624).
      const error = await client
        .write([action(update("todo", "invoice_1", method, { amount: 999_999 }))])
        .then(() => null)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PermissionError);
      expect((error as PermissionError).violations).toEqual([
        {
          kind: "type-mismatch",
          model: "todo",
          subjectId: "invoice_1",
          committedModel: "invoice",
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
    // and no missing permission is the reason (#624). Holding every
    // permission is what separates this from the `it.each` above: a check
    // that refuses a relabel only because a permission is missing passes
    // there and fails here.
    const { client } = await mkClient([["g_1", ["todo.*", "invoice.*"]]]);
    await client.storage.entities.set(entityRow("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    const error = await client
      .write([action(update("todo", "invoice_1", "put", { amount: 999_999 }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).message).toContain(
      'todo invoice_1: declared model "todo" but the entity is committed as "invoice"',
    );
    expect((error as PermissionError).message).not.toContain("missing");
    expect(client.outbox.size()).toBe(0);
  });

  it("passes a write that declares the entity's committed type", async () => {
    const { client } = await mkClient([["g_1", ["invoice.create"]]]);
    await client.storage.entities.set(entityRow("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action(update("invoice", "invoice_1", "put", { amount: 200 }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("uses the wire model for an id the local store does not know", async () => {
    // A new entity has no committed model, so the create's model stands
    // (#624/#817) — for the grant that satisfies it and for the one that
    // does not.
    const allowed = await mkClient([["g_1", ["todo.create"]]]);
    await allowed.client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await expect(
      allowed.client.write([action(update("todo", "todo_1", "put", { title: "Ship" }))]),
    ).resolves.toEqual({ rejected: [] });

    const denied = await mkClient([["g_1", ["invoice.create"]]]);
    await denied.client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    const error = await denied.client
      .write([action(update("todo", "todo_1", "put", { title: "Ship" }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "todo",
        subjectId: "todo_1",
        required: "todo.create",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("agrees with can() that a forged wire type is not a way in", async () => {
    const { client } = await mkClient([["g_1", ["todo.*"]]]);
    await client.storage.entities.set(entityRow("invoice_1", "invoice", { amount: 100 }));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "invoice_1", group_id: "g_1" }),
    );

    // can() has no wire type to compare, so it reports the permission the
    // committed type would need; write() refuses the relabel before it
    // ever gets that far. Both refuse.
    expect(await client.can("invoice_1", "create")).toEqual({
      kind: "denied",
      violation: {
        kind: "missing-permission",
        permissionSubject: "invoice",
        subjectId: "invoice_1",
        required: "invoice.create",
        groupIds: ["g_1"],
      },
    });

    const error = await client
      .write([action(update("todo", "invoice_1", "put", { amount: 999_999 }))])
      .then(() => null)
      .catch((err: unknown) => err);
    expect((error as PermissionError).violations).toEqual([
      {
        kind: "type-mismatch",
        model: "todo",
        subjectId: "invoice_1",
        committedModel: "invoice",
        groupIds: ["g_1"],
      },
    ]);
  });
});

describe("collectPermissionViolations — component subjects", () => {
  /** A committed note row owned by `g_1`, where the actor holds `permissions`. */
  const mkNoteClient = async (permissions: string[]) => {
    const { client } = await mkClient([["g_1", permissions]]);
    await client.storage.entities.set(entityRow("note_1", "note", { title: "T", body: "B" }));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "note_1", group_id: "g_1" }),
    );
    return client;
  };

  it("authorizes a write to a component by a grant on that component", async () => {
    const client = await mkNoteClient(["note/title.*"]);

    await expect(
      client.write([action(update("note", "note_1", "patch", { title: "Renamed" }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("denies a write to a component the grant does not cover", async () => {
    const client = await mkNoteClient(["note/title.*"]);

    const error = await client
      .write([action(update("note", "note_1", "patch", { body: "Rewritten" }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "note/body",
        subjectId: "note_1",
        required: "note/body.update",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("authorizes a component write by a grant on the model", async () => {
    const client = await mkNoteClient(["note.*"]);

    await expect(
      client.write([action(update("note", "note_1", "patch", { body: "Rewritten" }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("denies a multi-component update when the grant covers only one of them", async () => {
    const client = await mkNoteClient(["note/title.*"]);

    const error = await client
      .write([action(update("note", "note_1", "patch", { title: "Renamed", body: "Rewritten" }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "note/body",
        subjectId: "note_1",
        required: "note/body.update",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("authorizes a multi-component update when the grant covers all of them", async () => {
    const client = await mkNoteClient(["note/title.*", "note/body.*"]);

    await expect(
      client.write([
        action(update("note", "note_1", "patch", { title: "Renamed", body: "Rewritten" })),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("denies a drop of a component the grant does not cover", async () => {
    const client = await mkNoteClient(["note/title.*"]);

    const error = await client
      .write([
        action([
          { id: "u_1", subject_id: "note_1", component: "note/body", method: "drop", data: null },
        ]),
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "note/body",
        subjectId: "note_1",
        required: "note/body.update",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("authorizes a row create by a grant on the model, not on a field", async () => {
    const created = await mkClient([["g_1", ["note.create"]]]);
    await created.client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "note_2", group_id: "g_1" }),
    );
    await expect(
      created.client.write([action(update("note", "note_2", "put", { title: "T" }))]),
    ).resolves.toEqual({ rejected: [] });

    const denied = await mkClient([["g_1", ["note/title.create"]]]);
    await denied.client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "note_2", group_id: "g_1" }),
    );
    const error = await denied.client
      .write([action(update("note", "note_2", "put", { title: "T" }))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "note",
        subjectId: "note_2",
        required: "note.create",
        groupIds: ["g_1"],
      },
    ]);
  });

  it("authorizes a delete by a grant on the model, not on a field", async () => {
    const allowed = await mkNoteClient(["note.delete"]);
    await expect(allowed.write([action(update("note", "note_1", "delete"))])).resolves.toEqual({
      rejected: [],
    });

    const denied = await mkNoteClient(["note/title.delete"]);
    const error = await denied
      .write([action(update("note", "note_1", "delete"))])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "note",
        subjectId: "note_1",
        required: "note.delete",
        groupIds: ["g_1"],
      },
    ]);
  });
});

describe("collectPermissionViolations — link edges", () => {
  /** One `ebb/link` merge on `sourceId`: a presence key, or its tombstone. */
  const linkUpdate = (sourceId: string, targetId = "list_1", present = true): Update => ({
    id: `u_link_${sourceId}`,
    subject_id: sourceId,
    component: "ebb/link",
    method: "merge",
    data: linkValue([{ as: "list", type: "todo", targetId, present }]),
  });

  /** A `todo` row filed into `group`, optionally already carrying one edge. */
  const seedSource = async (
    client: Awaited<ReturnType<typeof mkClient>>["client"],
    groupId: string,
    withEdge = false,
  ): Promise<void> => {
    await client.storage.entities.set(
      withEdge
        ? linkRow("todo_1", "todo", [{ as: "list", type: "todo", targetId: "list_9" }])
        : entityRow("todo_1", "todo", {}),
    );
    await client.storage.entities.set(
      platformEntity("eg_src", "membership", { entity_id: "todo_1", group_id: groupId }),
    );
  };

  it("checks the source row's group set, not the target's", async () => {
    const { client, calls } = await mkClient([
      ["g_source", []],
      ["g_target", ["ebb/link.*"]],
    ]);
    await seedSource(client, "g_source");
    await client.storage.entities.set(
      platformEntity("eg_tgt", "membership", { entity_id: "list_1", group_id: "g_target" }),
    );

    const error = await client
      .write([action([linkUpdate("todo_1")])])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "missing-permission",
        permissionSubject: "ebb/link",
        subjectId: "todo_1",
        required: "ebb/link.update",
        groupIds: ["g_source"],
      },
    ]);
    expect(client.outbox.size()).toBe(0);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("authorizes an edge on an existing row as ebb/link.update over its group set", async () => {
    const { client } = await mkClient([["g_source", ["ebb/link.update"]]]);
    await seedSource(client, "g_source");

    await expect(client.write([action([linkUpdate("todo_1")])])).resolves.toEqual({
      rejected: [],
    });
  });

  it("authorizes an edge in the Action that creates its source as ebb/link.create", async () => {
    // The verb follows the Action, not the store: the source row does not
    // exist yet, but the create rides in this Action, so the write is a
    // create — the same rule the server applies.
    const { client } = await mkClient([["g_source", ["todo.create", "ebb/link.create"]]]);
    await client.storage.entities.set(
      platformEntity("eg_src", "membership", { entity_id: "todo_1", group_id: "g_source" }),
    );

    await expect(
      client.write([action([create("todo", "todo_1"), linkUpdate("todo_1")])]),
    ).resolves.toEqual({ rejected: [] });

    const updated = await mkClient([["g_source", ["todo.create", "ebb/link.update"]]]);
    await updated.client.storage.entities.set(
      platformEntity("eg_src", "membership", { entity_id: "todo_1", group_id: "g_source" }),
    );

    await expect(
      updated.client.write([action([create("todo", "todo_1"), linkUpdate("todo_1")])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("authorizes a row that already carries ebb/link as an update", async () => {
    const { client } = await mkClient([["g_source", ["ebb/link.update"]]]);
    await seedSource(client, "g_source", true);

    await expect(client.write([action([linkUpdate("todo_1", "list_2")])])).resolves.toEqual({
      rejected: [],
    });

    // A grant of only `create` does not cover a second edge on the row.
    const created = await mkClient([["g_source", ["ebb/link.create"]]]);
    await seedSource(created.client, "g_source", true);
    await expect(
      created.client.write([action([linkUpdate("todo_1", "list_2")])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("treats a tombstone-only write to a link-carrying row as an update", async () => {
    const { client } = await mkClient([["g_source", ["ebb/link.update"]]]);
    await seedSource(client, "g_source", true);

    await expect(client.write([action([linkUpdate("todo_1", "list_9", false)])])).resolves.toEqual({
      rejected: [],
    });

    const created = await mkClient([["g_source", ["ebb/link.create"]]]);
    await seedSource(created.client, "g_source", true);
    await expect(
      created.client.write([action([linkUpdate("todo_1", "list_9", false)])]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("checks a delete that carries an edge write as the row's model delete", async () => {
    // A delete names the row, so the batch's subject is the model whatever
    // components ride with it — the rule the server applies to the same fold.
    const { client } = await mkClient([["g_source", ["todo.delete"]]]);
    await seedSource(client, "g_source");

    await expect(
      client.write([
        action([
          { id: "u_delete", subject_id: "todo_1", method: "delete", data: null },
          linkUpdate("todo_1"),
        ]),
      ]),
    ).resolves.toEqual({ rejected: [] });

    const edgeDelete = await mkClient([["g_source", ["ebb/link.delete"]]]);
    await seedSource(edgeDelete.client, "g_source");

    await expect(
      edgeDelete.client.write([
        action([
          { id: "u_delete", subject_id: "todo_1", method: "delete", data: null },
          linkUpdate("todo_1"),
        ]),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("defers a link write on a row the local store cannot see", async () => {
    // No membership rows for the row means no group set to check, so the
    // server decides.
    const { client } = await mkClient([["g_1", []]]);

    await expect(client.write([action([linkUpdate("todo_missing")])])).resolves.toEqual({
      rejected: [],
    });
  });

  it("needs no grant in the target row's group", async () => {
    const { client } = await mkClient([
      ["g_source", ["ebb/link.update"]],
      ["g_target", []],
    ]);
    await seedSource(client, "g_source");
    await client.storage.entities.set(
      platformEntity("eg_tgt", "membership", { entity_id: "list_1", group_id: "g_target" }),
    );

    await expect(client.write([action([linkUpdate("todo_1")])])).resolves.toEqual({
      rejected: [],
    });
  });
});

describe("collectPermissionViolations — immutable platform keys", () => {
  it("refuses an ebb/grant write that re-points its group", async () => {
    const { client, calls } = await mkClient([
      ["g_1", ["ebb/grant.*"]],
      ["g_2", ["ebb/grant.*"]],
    ]);
    await client.storage.entities.set(
      platformEntity("gm_1", "grant", { actor_id: "actor_2", group_id: "g_1", permissions: [] }),
    );

    const error = await client
      .write([
        action(
          update("grant", "gm_1", "patch", {
            actor_id: "actor_2",
            group_id: "g_2",
            permissions: [],
          }),
        ),
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "key-mismatch",
        component: "ebb/grant",
        subjectId: "gm_1",
        field: "group_id",
        declaredValue: "g_2",
        committedValue: "g_1",
        groupIds: ["g_1"],
      },
    ]);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("refuses an ebb/membership write that re-points its pair", async () => {
    const { client, calls } = await mkClient([
      ["g_1", ["todo.*"]],
      ["g_2", ["todo.*"]],
    ]);
    await client.storage.entities.set(entityRow("todo_1", "todo", { title: "Ship" }));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const error = await client
      .write([
        action(update("membership", "eg_1", "patch", { entity_id: "todo_1", group_id: "g_2" })),
      ])
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as PermissionError).violations).toEqual([
      {
        kind: "key-mismatch",
        component: "ebb/membership",
        subjectId: "eg_1",
        field: "group_id",
        declaredValue: "g_2",
        committedValue: "g_1",
        groupIds: ["g_1"],
      },
    ]);
    expect(actionRequests(calls)).toHaveLength(0);
  });
});

describe("collectPermissionViolations — membership writes", () => {
  it("requires <type>.create in the target group for a put", async () => {
    const { client, calls } = await mkClient([["g_1", ["todo.update"]]]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));

    await expect(
      client.write([
        action(update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("requires <type>.update where the entity lives, not only in the target", async () => {
    // The graft: `todo.create` in the caller's own group, nothing where
    // the entity lives (#623).
    const { client, calls } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.create"]],
    ]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([
        action(update("membership", "eg_2", "put", { entity_id: "todo_1", group_id: "g_2" })),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("passes a put holding create in the target and update where the entity lives", async () => {
    const { client } = await mkClient([
      ["g_1", ["todo.update"]],
      ["g_2", ["todo.create"]],
    ]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([
        action(update("membership", "eg_2", "put", { entity_id: "todo_1", group_id: "g_2" })),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("passes a put when any one of a multi-group entity's groups holds <type>.update", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.update"]],
      ["g_3", ["todo.create"]],
    ]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([
        action(update("membership", "eg_3", "put", { entity_id: "todo_1", group_id: "g_3" })),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("passes a put for an entity with no locally-known group set on the target gate alone", async () => {
    // The server's "new to the index" branch (#289/#623): an entity the
    // store has never filed resolves no source group, so `create` stands
    // alone rather than the pass inventing a refusal it cannot support.
    const { client } = await mkClient([["g_1", ["todo.create"]]]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));

    await expect(
      client.write([
        action(update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("skips a put whose model cannot be resolved", async () => {
    // `unknown` is not a denial on the write path: the server is the
    // authority, so the write proceeds.
    const { client } = await mkClient([["g_1", []]]);

    await expect(
      client.write([
        action(update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_1" })),
      ]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("requires <type>.update in the entity's current set for a delete", async () => {
    const { client, calls } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(
      client.write([action(update("membership", "eg_1", "delete"))]),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(actionRequests(calls)).toHaveLength(0);
  });

  it("passes a delete when another of the entity's groups holds <type>.update", async () => {
    const { client } = await mkClient([
      ["g_1", []],
      ["g_2", ["todo.update"]],
    ]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_1", group_id: "g_2" }),
    );

    await expect(client.write([action(update("membership", "eg_1", "delete"))])).resolves.toEqual({
      rejected: [],
    });
  });

  it("skips a delete whose membership row cannot be resolved", async () => {
    const { client } = await mkClient([["g_1", []]]);

    await expect(
      client.write([action(update("membership", "eg_missing", "delete"))]),
    ).resolves.toEqual({ rejected: [] });
  });
});

describe("collectPermissionViolations — group bootstrap", () => {
  it("exempts a group bootstrap and honors its declared permissions", async () => {
    const { client, calls } = await mkClient([["g_old", []]]);

    const created = action(
      update("group", "g_new", "put", { id: "g_new" }),
      update("grant", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*", "ebb/group.*", "ebb/grant.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    );

    await expect(client.write([created])).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
  });

  it("checks a lone group put rather than treating it as a bootstrap", async () => {
    const { client } = await mkClient([["g_old", []]]);

    await expect(
      client.write([action(update("group", "g_new", "put", { name: "New" }))]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("allows a subsequent write to a group the actor bootstrapped", async () => {
    const { client } = await mkClient([["g_old", []]]);
    const created = action(
      update("group", "g_new", "put", { name: "New" }),
      update("grant", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    );
    await client.write([created]);

    const followUp = action(
      update("todo", "todo_2", "put", { title: "Ship again" }),
      update("membership", "eg_2", "put", { entity_id: "todo_2", group_id: "g_new" }),
    );
    await expect(client.write([followUp])).resolves.toEqual({ rejected: [] });
  });

  it("does not exempt a membership put for an entity that already exists", async () => {
    const { client } = await mkClient([["g_old", []]]);
    await client.storage.entities.set(entityRow("todo_1", "todo", {}));

    const created = action(
      update("group", "g_new", "put", { id: "g_new" }),
      update("grant", "gm_1", "put", {
        actor_id: ACTOR_ID,
        group_id: "g_new",
        permissions: ["todo.*"],
      }),
      update("todo", "todo_1", "put", { title: "Ship" }),
      update("membership", "eg_1", "put", { entity_id: "todo_1", group_id: "g_new" }),
    );

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
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    await expect(
      client.write([action(update("todo", "todo_1", "put", { title: "Ship" }))]),
    ).resolves.toEqual({ rejected: [] });
    expect(actionRequests(calls)).toHaveLength(1);
    expect(client.outbox.size("acknowledged")).toBe(1);
  });

  it("aggregates violations across every Action in the batch", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );
    await client.storage.entities.set(
      platformEntity("eg_2", "membership", { entity_id: "todo_2", group_id: "g_1" }),
    );

    const error = await client
      .write([
        action(update("todo", "todo_1", "put", { title: "One" })),
        { ...action(update("todo", "todo_2", "put", { title: "Two" })), id: "a_2" },
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
      platformEntity("eg_1", "membership", { entity_id: "todo_1", group_id: "g_1" }),
    );

    const response = await client.write([
      action(update("todo", "todo_1", "put", { title: "Ship" })),
    ]);
    expect(response.rejected.map((rejection) => rejection.id)).toEqual(["a_1"]);
    expect(client.outbox.errors().map((entry) => entry.action.id)).toEqual(["a_1"]);
  });
});

describe("collectPermissionViolations — platform model", () => {
  it("requires group.create in the group for a put", async () => {
    const { client } = await mkClient([["g_1", ["ebb/group.update"]]]);

    await expect(
      client.write([action(update("group", "g_1", "put", { name: "G" }))]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("passes a group put when the target group grants group.create", async () => {
    const { client } = await mkClient([["g_1", ["ebb/group.*"]]]);

    await expect(
      client.write([action(update("group", "g_1", "put", { name: "G" }))]),
    ).resolves.toEqual({ rejected: [] });
  });

  it("requires ebb/grant.create in the target group for a put", async () => {
    const { client } = await mkClient([["g_1", ["ebb/grant.update"]]]);

    await expect(
      client.write([
        action(
          update("grant", "gm_1", "put", {
            actor_id: "actor_2",
            group_id: "g_1",
            permissions: [],
          }),
        ),
      ]),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("resolves a grant delete's group from the local row", async () => {
    const { client } = await mkClient([["g_1", []]]);
    await client.storage.entities.set(
      platformEntity("gm_1", "grant", { actor_id: "actor_2", group_id: "g_1", permissions: [] }),
    );

    await expect(client.write([action(update("grant", "gm_1", "delete"))])).rejects.toBeInstanceOf(
      PermissionError,
    );
  });
});

describe("PermissionError", () => {
  it("formats its message from the violations", () => {
    const error = new PermissionError([
      {
        kind: "missing-permission",
        permissionSubject: "todo",
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

  it("names both types for a mismatch and no missing permission", () => {
    const error = new PermissionError([
      {
        kind: "type-mismatch",
        model: "todo",
        subjectId: "invoice_1",
        committedModel: "invoice",
        groupIds: ["g_1"],
      },
    ]);

    expect(error.message).toContain(
      'todo invoice_1: declared model "todo" but the entity is committed as "invoice"',
    );
    expect(error.message).toContain("an entity's model cannot change");
    expect(error.message).not.toContain("missing");
    expect(error.message).not.toContain("todo.create");
  });
});
