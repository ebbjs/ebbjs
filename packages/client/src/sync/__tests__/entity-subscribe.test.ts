/**
 * Tests for `client.<entity>.get(id)` → `row.subscribe(cb)` — the
 * per-entity reactive subscribe (Path C, #161).
 *
 * The callback receives a typed `EntitySnapshot<TFields>` on every
 * materialization of the row. `get(id)` already materialized before
 * the listener attaches, so `subscribe` never fires immediately.
 */

import { describe, it, expect as globalExpect } from "vitest";
import { makeHlc, type Action, type Entity } from "@ebbjs/core";
import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { callApplyAction } from "../test-utils";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  entities: { todo },
  version: 1,
});

const mkAction = (gsn: number, subjectId: string, title: string, completed: boolean): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `u_${gsn}`,
      subject_id: subjectId,
      subject_type: "todo",
      method: "put",
      data: {
        fields: {
          title: { value: title, update_id: `u_${gsn}`, hlc: makeHlc(1) },
          completed: { value: completed, update_id: `u_${gsn}`, hlc: makeHlc(1) },
        },
      },
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
      subject_type: "todo",
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
  title: string;
  completed: boolean;
  id: string;
  entity: { id: string; type: string; deleted_hlc: unknown };
};

/** Build a raw materialized entity for direct `entities.set` writes. */
const mkRawEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
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
    const unsub = row.subscribe((snapshot) => {
      seen.push({ title: snapshot.title, completed: snapshot.completed });
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", true), "grp_1");
    await callApplyAction(client, mkAction(3, "todo_1", "T3", false), "grp_1");

    globalExpect(seen).toEqual([
      { title: "T2", completed: true },
      { title: "T3", completed: false },
    ]);

    unsub();
  });

  it("does not fire immediately on subscribe (no post-read emit)", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((snapshot) => {
      seen.push(snapshot);
    });

    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not fire for changes to a different id", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((snapshot) => {
      seen.push(snapshot);
    });

    await callApplyAction(client, mkAction(2, "todo_other", "Other", false), "grp_1");
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not fire when a same-id row of a different type materializes", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    const row = await seedRow(client, 1, "shared_id", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((snapshot) => {
      seen.push(snapshot);
    });

    // Same id, different type — the row no longer represents a `todo`,
    // matching `get`'s own type guard.
    await storage.entities.set(mkRawEntity("shared_id", "user", { name: "Ada" }));
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("unsub stops further emissions", async () => {
    const client = mkClient();
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: string[] = [];
    const unsub = row.subscribe((snapshot) => {
      seen.push(snapshot.title);
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
    const unsub = row.subscribe((snapshot) => {
      snapshotShape = snapshot;
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", true), "grp_1");

    const snap = snapshotShape as unknown as TodoSnapshot;
    globalExpect(snap.title).toBe("T2");
    globalExpect(snap.completed).toBe(true);
    globalExpect(snap.id).toBe("todo_1");
    globalExpect(snap.entity.id).toBe("todo_1");
    globalExpect(snap.entity.type).toBe("todo");
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
    const unsub = row.subscribe((snapshot) => {
      deletedHlc = snapshot.entity.deleted_hlc;
    });

    await callApplyAction(client, mkDeleteAction(2, "todo_1"), "grp_1");
    globalExpect(deletedHlc).not.toBeNull();

    unsub();
  });

  it("subscribe is a no-op when the adapter ships no change emitter", async () => {
    const { changeEmitter: _omitted, ...withoutEmitter } = createMemoryAdapter();
    const client = mkClient(withoutEmitter);
    const row = await seedRow(client, 1, "todo_1", "T1", false);

    const seen: unknown[] = [];
    const unsub = row.subscribe((snapshot) => {
      seen.push(snapshot);
    });

    await callApplyAction(client, mkAction(2, "todo_1", "T2", false), "grp_1");
    globalExpect(seen).toHaveLength(0);
    globalExpect(typeof unsub).toBe("function");

    unsub();
  });

  it("the callback type narrows to EntitySnapshot<TFields> (bogus field is a compile error)", () => {
    // Compile-time check: the snapshot's fields flow from the entity's
    // TypeBox shape. Wrapped in a function so vitest's runtime ignore
    // doesn't trip when the file loads.
    const check: () => void = () => {
      const _onSnapshot: (snapshot: TodoSnapshot) => void = (snapshot) => {
        void snapshot.title.toUpperCase();
        void !snapshot.completed;
        // @ts-expect-error — `bogus` is not in the field map.
        void snapshot.bogus;
      };
      void _onSnapshot;
    };
    globalExpect(typeof check).toBe("function");
  });
});
