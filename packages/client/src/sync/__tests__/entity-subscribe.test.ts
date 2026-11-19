/**
 * Tests for `client.<entity>.get(id)` → `row.subscribe(cb)` — the
 * per-entity reactive subscribe (Path C, #161).
 *
 * The callback receives an `EntityEvent<EntitySnapshot<TFields>>`: a
 * `snapshot` on every materialization of the row, and an `unloaded` event
 * when a tracked component — or the whole row — leaves the replica.
 * `get(id)` already materialized before the listener attaches, so
 * `subscribe` never fires immediately.
 */

import { describe, it, expect as globalExpect } from "vitest";
import { makeHlc, type Action, type Entity } from "@ebbjs/core";
import { defineModel, e } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { createClient } from "../client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";
import type { EntityEvent } from "../namespace";
import { callApplyAction, seedReplicaRow } from "../test-utils";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  models: { todo },
  version: 1,
});

const mkAction = (gsn: number, subjectId: string, title: string, completed: boolean): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `${`u_${gsn}`}_0`,
      subject_id: subjectId,
      component: "todo/title",
      method: "replace",
      data: { value: title, update_id: `u_${gsn}`, hlc: makeHlc(1) },
    },
    {
      id: `${`u_${gsn}`}_1`,
      subject_id: subjectId,
      component: "todo/completed",
      method: "replace",
      data: { value: completed, update_id: `u_${gsn}`, hlc: makeHlc(1) },
    },
  ],
});

const mkDeleteAction = (gsn: number, subjectId: string): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `u_${gsn}`,
      subject_id: subjectId,
      method: "delete",
      data: null,
    },
  ],
});

const mkClient = (storage: StorageAdapter = createMemoryAdapter()) =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "actor_1", storage, schema });

type TestClient = ReturnType<typeof mkClient>;

/** The `EntitySnapshot<todo fields>` shape the callback receives. */
type TodoSnapshot = {
  title?: string;
  completed?: boolean;
  id: string;
  entity: { id: string; model: string; deleted_hlc: unknown };
};

/** Build a raw materialized entity for direct `entities.set` writes. */
const mkRawEntity = (id: string, model: string, fields: Record<string, unknown>): Entity => ({
  id,
  model,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/** Apply one put for `id`, then return its row. */
const seedRow = async (
  client: TestClient,
  gsn: number,
  id: string,
  title: string,
  completed: boolean,
) => {
  await callApplyAction(client, mkAction(gsn, id, title, completed), "grp_1");
  const row = await client.todo.get(id);
  if (row === null) throw new Error("expected row");
  return row;
};

describe("client.<entity>.get(id).subscribe(cb)", () => {
  it("fires on each inbound change to the row, with the new projection", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: { title: string; completed: boolean }[] = [];
    const unsub = row.subscribe((event) => {
      if (event.type !== "snapshot") return;
      seen.push({ title: event.row.title ?? "", completed: event.row.completed ?? false });
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", true), "grp_1");
    await callApplyAction(client, mkAction(3, "todo_1", "T3", false), "grp_1");

    globalExpect(seen).toEqual([
      { title: "T2", completed: true },
      { title: "T3", completed: false },
    ]);

    unsub();
  });

  it("does not fire for a delivery that only advances last_gsn", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((event) => {
      if (event.type === "snapshot") seen.push(event.row);
    });

    // An older Action whose field ties on HLC and loses the update_id
    // tiebreak: the row keeps its content and only `last_gsn` moves.
    const stale: Action = {
      id: "act_stale",
      actor_id: "actor_1",
      hlc: makeHlc(1_711_036_800_000, 0),
      gsn: 9,
      updates: [
        {
          id: "u_stale_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "merge",
          data: { value: "Stale", update_id: "u_000", hlc: makeHlc(1) },
        },
      ],
    };
    await callApplyAction(client, stale, "grp_1");
    globalExpect(seen).toHaveLength(0);

    await callApplyAction(client, mkAction(3, "todo_1", "T3", false), "grp_1");
    globalExpect(seen).toHaveLength(1);

    unsub();
  });

  it("does not fire immediately on subscribe (no post-read emit)", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((event) => {
      seen.push(event);
    });

    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not fire for changes to a different id", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((event) => {
      seen.push(event);
    });

    await callApplyAction(client, mkAction(2, "todo_other", "Other", false), "grp_1");
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("reports the row unloaded when a same-id row of a different type replaces it", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    const row = await seedRow(client, 1, "shared_id", "T1", false);

    const seen: EntityEvent<unknown>[] = [];
    const unsub = row.subscribe((event) => {
      seen.push(event);
    });

    // Same id, different type — the row this subscription read is gone from
    // the replica, so it reports the whole row leaving. No single component
    // names the change.
    const other = mkRawEntity("shared_id", "user", { name: "Ada" });
    seedReplicaRow(client.replica, other);
    await storage.entities.set(other);
    globalExpect(seen).toEqual([{ type: "unloaded" }]);

    unsub();
  });

  it("unsub stops further emissions", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: string[] = [];
    const unsub = row.subscribe((event) => {
      if (event.type === "snapshot") seen.push(event.row.title ?? "");
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", false), "grp_1");
    globalExpect(seen).toEqual(["T2"]);

    unsub();

    await callApplyAction(client, mkAction(3, "todo_1", "T3", false), "grp_1");
    globalExpect(seen).toEqual(["T2"]);
  });

  it("the snapshot is EntitySnapshot<TFields> (fields + id + entity escape hatch)", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    let snapshotShape: TodoSnapshot | null = null;
    const unsub = row.subscribe((event) => {
      if (event.type === "snapshot") snapshotShape = event.row;
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", true), "grp_1");

    const snap = snapshotShape as unknown as TodoSnapshot;
    globalExpect(snap.title).toBe("T2");
    globalExpect(snap.completed).toBe(true);
    globalExpect(snap.id).toBe("todo_1");
    globalExpect(snap.entity.id).toBe("todo_1");
    globalExpect(snap.entity.model).toBe("todo");
    globalExpect(snap.entity.deleted_hlc).toBeNull();

    // Compile-time check: `bogus` isn't a field on the snapshot.
    const _typecheck: (s: TodoSnapshot) => void = (s) => {
      // @ts-expect-error — `bogus` is not a field on the snapshot.
      void s.bogus;
      void s.title;
      void s.id;
      void s.entity;
    };
    void _typecheck;

    unsub();
  });

  it("keeps the entity escape hatch on a delete (soft-delete is still a change)", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    let deletedHlc: unknown = null;
    const unsub = row.subscribe((event) => {
      if (event.type === "snapshot") deletedHlc = event.row.entity.deleted_hlc;
    });

    await callApplyAction(client, mkDeleteAction(2, "todo_1"), "grp_1");
    globalExpect(deletedHlc).not.toBeNull();

    unsub();
  });

  it("the callback receives an EntityEvent<EntitySnapshot<TFields>> union", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: EntityEvent<TodoSnapshot>[] = [];
    const unsub = row.subscribe((event) => {
      const typed: EntityEvent<TodoSnapshot> = event;
      seen.push(typed);
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", true), "grp_1");
    globalExpect(seen).toHaveLength(1);
    globalExpect(seen[0]).toMatchObject({ type: "snapshot", row: { id: "todo_1", title: "T2" } });

    // Compile-time checks: the union narrows on `type`, and each branch carries
    // only its own fields.
    const _typecheck = (event: EntityEvent<TodoSnapshot>): void => {
      if (event.type === "snapshot") {
        void event.row.title;
        // @ts-expect-error — the snapshot branch has no `component`.
        void event.component;
      } else {
        void event.component;
        // @ts-expect-error — the unloaded branch carries no `row`.
        void event.row;
      }
      // @ts-expect-error — "closed" is not an event type.
      if (event.type === "closed") void event;
    };
    void _typecheck;

    unsub();
  });
});
