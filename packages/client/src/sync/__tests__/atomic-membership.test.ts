/**
 * End-to-end tests for the membership operations (#464): the draft
 * `addToGroup` / `removeFromGroup` verbs compose into the batch, and a
 * content write plus a membership delta into different groups compose
 * into one spanning Action (the server delivers per-Update scope, #473).
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action, type Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { AtomicActionError } from "../operations";
import { EntityValidationError } from "../../schema/entity-registry";
import { createClient } from "../client";

const todo = defineEntity("todo", { title: e.string() });
const schema = defineSchema({ entities: { todo }, version: 1 });

const mkEntityGroup = (id: string, entityId: string, groupId: string): Entity => ({
  id,
  type: "entityGroup",
  data: {
    fields: {
      entity_id: { value: entityId, update_id: "u" },
      group_id: { value: groupId, update_id: "u" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const mkClient = async () => {
  const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
  const storage = createMemoryAdapter();
  const actions: Action[][] = [];
  const jsonFetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/sync/handshake")) {
      return jsonResponse({
        actor_id: "actor_1",
        groups: [
          { id: "g_1", permissions: ["todo.*"], cursor_valid: true, reason: null, cursor: 0 },
          { id: "g_2", permissions: ["todo.*"], cursor_valid: true, reason: null, cursor: 0 },
        ],
      });
    }
    if (url.endsWith("/sync/actions")) {
      actions.push(decodeSync<{ actions: Action[] }>(init.body as unknown as Uint8Array).actions);
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const fetchImpl = jsonFetch;
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema,
    fetchImpl,
  });
  await client.handshake();
  return { client, storage, actions };
};

const updatesOf = (actions: readonly Action[][]): Action["updates"] =>
  actions.flatMap((batch) => batch.flatMap((action) => action.updates));

describe("drafts — membership verbs (#464)", () => {
  it("composes a draft addToGroup with a group-coherent create into one Action", async () => {
    const { client, actions } = await mkClient();

    await client.atomic(({ todo: draft }) => {
      draft.create({ title: "Ship it" }, { groups: ["g_1"] });
      draft.addToGroup("todo_existing", "g_1");
    });

    expect(actions).toHaveLength(1);
    const updates = updatesOf(actions);
    // One content put + one entityGroup put for the create, plus one
    // entityGroup put for the addToGroup.
    expect(updates.filter((u) => u.subject_type === "todo")).toHaveLength(1);
    expect(updates.filter((u) => u.subject_type === "entityGroup")).toHaveLength(2);
  });

  it("submits a content create in g_1 mixed with a membership delta into g_2 as one Action", async () => {
    const { client, actions } = await mkClient();

    await client.atomic(({ todo: draft }) => {
      draft.create({ title: "Ship it" }, { groups: ["g_1"] });
      draft.addToGroup("todo_existing", "g_2");
    });

    expect(actions).toHaveLength(1);
    const updates = updatesOf(actions);
    // One content put + one entityGroup put for the create, plus one
    // entityGroup put for the addToGroup. The batch spans g_1 and g_2.
    expect(updates.filter((u) => u.subject_type === "todo")).toHaveLength(1);
    expect(updates.filter((u) => u.subject_type === "entityGroup")).toHaveLength(2);
    expect(
      updates
        .filter((u) => u.subject_type === "entityGroup")
        .map((u) => u.data?.fields?.["group_id"]?.value)
        .sort(),
    ).toEqual(["g_1", "g_2"]);
  });

  it("lets a membership batch span groups in one Action", async () => {
    const { client, actions } = await mkClient();

    await client.atomic(({ todo: draft }) => {
      draft.addToGroup("todo_1", "g_1");
      draft.addToGroup("todo_2", "g_2");
    });

    expect(actions).toHaveLength(1);
    const updates = updatesOf(actions);
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.data?.fields?.["group_id"]?.value).sort()).toEqual(["g_1", "g_2"]);
  });

  // One row per `(entity, group)` (#623): two devices that share the same
  // entity into the same group before syncing must converge on one row, or
  // an unshare deletes the row one device can see and the entity stays
  // shared.
  it("derives the membership row id from the pair, so re-shares are one row", async () => {
    const first = await mkClient();
    const second = await mkClient();

    await first.client.atomic(({ todo: draft }) => {
      draft.addToGroup("todo_1", "g_1");
    });
    await second.client.atomic(({ todo: draft }) => {
      draft.addToGroup("todo_1", "g_1");
    });

    const [a] = updatesOf(first.actions);
    const [b] = updatesOf(second.actions);
    expect(a!.subject_id).toBe(b!.subject_id);
    expect(a!.subject_id.startsWith("eg_")).toBe(true);
  });

  it("gives a multi-group entity one distinct row per group", async () => {
    const { client, actions } = await mkClient();

    await client.todo.create({ title: "both" }, { id: "todo_1", groups: ["g_1", "g_2"] });

    const ids = updatesOf(actions)
      .filter((u) => u.subject_type === "entityGroup")
      .map((u) => u.subject_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-shares after an unshare as one row again", async () => {
    const { client, storage, actions } = await mkClient();
    await storage.entities.set(mkEntityGroup("eg_1", "todo_1", "g_1"));
    await storage.entities.set(mkEntityGroup("eg_2", "todo_1", "g_2"));

    await client.atomic(({ todo: draft }) => {
      draft.removeFromGroup("todo_1", "g_1");
    });
    await client.atomic(({ todo: draft }) => {
      draft.addToGroup("todo_1", "g_1");
    });

    const puts = updatesOf(actions).filter((u) => u.method === "put");
    expect(puts).toHaveLength(1);
    // Same pair, so the same derived row id the first share used: an
    // unshare followed by a re-share cannot leave a second row behind.
    const { entityGroupId } = await import("../membership");
    expect(puts[0]!.subject_id).toBe(entityGroupId("todo_1", "g_1"));
  });

  it("keeps the derived id unambiguous when ids contain the separator", async () => {
    const { entityGroupId } = await import("../membership");

    // A readable `eg_<entity>_<group>` would collapse these two pairs.
    expect(entityGroupId("a_b", "c")).not.toBe(entityGroupId("a", "b_c"));
  });

  it("is a no-op when the local view already holds the membership", async () => {
    const { client, storage, actions } = await mkClient();
    await storage.entities.set(mkEntityGroup("eg_1", "todo_1", "g_1"));

    await client.atomic(({ todo: draft }) => {
      draft.addToGroup("todo_1", "g_1");
    });

    expect(actions).toHaveLength(0);
  });

  it("resolves a removal against the local cache and deletes the row", async () => {
    const { client, storage, actions } = await mkClient();
    await storage.entities.set(mkEntityGroup("eg_1", "todo_1", "g_1"));
    await storage.entities.set(mkEntityGroup("eg_2", "todo_1", "g_2"));

    await client.atomic(({ todo: draft }) => {
      draft.removeFromGroup("todo_1", "g_1");
    });

    const updates = updatesOf(actions);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.subject_id).toBe("eg_1");
    expect(updates[0]!.method).toBe("delete");
  });

  it("refuses removing the entity's last membership before any network call", async () => {
    const { client, storage, actions } = await mkClient();
    await storage.entities.set(mkEntityGroup("eg_1", "todo_1", "g_1"));

    const error = await client
      .atomic(({ todo: draft }) => {
        draft.removeFromGroup("todo_1", "g_1");
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AtomicActionError);
    expect((error as AtomicActionError).rejections.map((r) => r.reason)).toEqual([
      "last_membership",
    ]);
    expect(actions).toHaveLength(0);
  });

  it("throws EntityValidationError when the removed row is not in the local view", async () => {
    const { client, actions } = await mkClient();

    const error = await client
      .atomic(({ todo: draft }) => {
        draft.removeFromGroup("todo_1", "g_1");
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EntityValidationError);
    expect(actions).toHaveLength(0);
  });

  it("refuses a malformed group ref before any network call", async () => {
    const { client, actions } = await mkClient();

    await expect(
      client.atomic(({ todo: draft }) => {
        draft.addToGroup("todo_1", 42 as never);
      }),
    ).rejects.toBeInstanceOf(EntityValidationError);
    expect(actions).toHaveLength(0);
  });
});
