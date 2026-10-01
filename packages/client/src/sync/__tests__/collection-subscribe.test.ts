/**
 * Tests for `client.<entity>.subscribe(filter, cb)` — the per-collection
 * reactive subscribe.
 *
 * Path C (per the design comment pinned on #161): the callback
 * receives a typed `CollectionSnapshot<TFields>` — the projected
 * rows, the active filter, and a count — not a diff. The runtime
 * re-evaluates the filter set on every storage emit and only fires
 * `cb` when the matching set has changed (referential equality on
 * the row array is the no-op case).
 */

import { describe, it, expect as globalExpect } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

type Expect<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertExtends<A, B> = Expect<Extends<A, B>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Extends<A, B> = A extends B ? true : false;

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  entities: { todo },
  version: 1,
});

const callApplyAction = (
  client: ReturnType<typeof createClient>,
  action: Action,
  groupId?: string,
): Promise<{ entityId: string; entityType: string }[]> =>
  (
    client as unknown as {
      _applyAction: (a: Action, g?: string) => Promise<{ entityId: string; entityType: string }[]>;
    }
  )._applyAction.call(client, action, groupId);

const mkAction = (gsn: number, subjectId: string, completed: boolean): Action => ({
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
          title: { value: `T${gsn}`, update_id: `u_${gsn}`, hlc: makeHlc(1) },
          completed: { value: completed, update_id: `u_${gsn}`, hlc: makeHlc(1) },
        },
      },
    },
  ],
});

describe("client.<entity>.subscribe(filter, cb)", () => {
  it("fires when an inbound action brings a matching entity into the set", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    // Pre-seed an entity that does NOT match the filter.
    await callApplyAction(client, mkAction(1, "todo_done", true), "grp_1");

    const seen: { count: number; titles: string[] }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({
        count: snapshot.count,
        titles: snapshot.entities.map((e) => e.title).sort(),
      });
    });

    globalExpect(seen).toHaveLength(0);

    // todo_active matches the filter (completed:false).
    await callApplyAction(client, mkAction(2, "todo_active", false), "grp_1");

    globalExpect(seen).toHaveLength(1);
    globalExpect(seen[0]).toEqual({ count: 1, titles: ["T2"] });

    // todo_another matches the filter.
    await callApplyAction(client, mkAction(3, "todo_another", false), "grp_1");
    globalExpect(seen).toHaveLength(2);
    globalExpect(seen[1]).toEqual({ count: 2, titles: ["T2", "T3"] });

    unsub();
  });

  it("does not fire when an inbound action targets an id outside the filter set", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    const seen: { count: number }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({ count: snapshot.count });
    });

    // A new entity that's `completed: true` doesn't match the filter.
    await callApplyAction(client, mkAction(2, "todo_done_2", true), "grp_1");
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not fire twice on the same matching set when no relevant state changed", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    await callApplyAction(client, mkAction(1, "todo_a", false), "grp_1");

    const seen: { count: number }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({ count: snapshot.count });
    });

    // Re-applying the same id — the emitter fires (materialization
    // lands) but the matching set is unchanged, so subscribe should
    // NOT fire its listener.
    await callApplyAction(client, mkAction(2, "todo_a", false), "grp_1");
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("the snapshot carries the typed rows (per-entity static projection)", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    let snapshotShape: unknown = null;
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      snapshotShape = snapshot;
    });

    await callApplyAction(client, mkAction(1, "todo_1", false), "grp_1");

    // Compile-time check: each entity has the projected field shape.
    const snap = snapshotShape as {
      entities: readonly { title: string; completed: boolean }[];
      filter: unknown;
      count: number;
    };
    globalExpect(snap.entities[0]?.title).toBe("T1");
    globalExpect(snap.entities[0]?.completed).toBe(false);
    globalExpect(snap.count).toBe(1);

    unsub();
  });

  it("unsub stops further emissions", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    const seen: { count: number }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({ count: snapshot.count });
    });

    await callApplyAction(client, mkAction(2, "todo_a", false), "grp_1");
    globalExpect(seen).toHaveLength(1);

    unsub();

    await callApplyAction(client, mkAction(3, "todo_b", false), "grp_1");
    globalExpect(seen).toHaveLength(1);
  });
});
