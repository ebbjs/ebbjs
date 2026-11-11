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

import { describe, it, expect as globalExpect, vi } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { defineModel, e } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { createClient } from "../client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { callApplyAction } from "../test-utils";

/** Let the async subscribe hydration settle before mutating storage. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  models: { todo },
  version: 1,
});

const mkAction = (gsn: number, subjectId: string, completed: boolean): Action => ({
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
      data: { value: `T${gsn}`, update_id: `u_${gsn}`, hlc: makeHlc(1) },
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

/** A write to a component the collection filter does not name. */
const mkTitleAction = (gsn: number, subjectId: string, title: string): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `u_${gsn}`,
      subject_id: subjectId,
      component: "todo/title",
      method: "replace",
      data: { value: title, update_id: `u_${gsn}`, hlc: makeHlc(1) },
    },
  ],
});

const mkDeleteAction = (gsn: number, subjectId: string): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [{ id: `u_${gsn}`, subject_id: subjectId, method: "delete", data: null }],
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
        titles: snapshot.entities.map((e) => e.title ?? "").sort(),
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

  it("fires with the smaller snapshot when a matching row is soft-deleted", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    await callApplyAction(client, mkAction(1, "todo_a", false), "grp_1");

    const seen: { count: number; titles: string[] }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({
        count: snapshot.count,
        titles: snapshot.entities.map((e) => e.title ?? "").sort(),
      });
    });
    await flush();

    await callApplyAction(client, mkDeleteAction(2, "todo_a"), "grp_1");

    globalExpect(seen).toEqual([{ count: 0, titles: [] }]);

    unsub();
  });

  it("does not fire when a non-matching row is soft-deleted", async () => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema,
    });

    await callApplyAction(client, mkAction(1, "todo_done", true), "grp_1");

    const seen: { count: number }[] = [];
    const unsub = client.todo.subscribe({ completed: false }, (snapshot) => {
      seen.push({ count: snapshot.count });
    });
    await flush();

    await callApplyAction(client, mkDeleteAction(2, "todo_done"), "grp_1");

    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not fire when a matching row edits a field but stays in the set", async () => {
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
    await flush();

    // Same id, still matching; the collection result is the id set, so the
    // field edit is not a membership change.
    await callApplyAction(client, mkAction(2, "todo_a", false), "grp_1");
    globalExpect(seen).toHaveLength(0);

    unsub();
  });

  it("does not re-run its plan when a matching row edits a component the filter does not read", async () => {
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
    await flush();

    const iterate = vi.spyOn(client.replica, "iterate");
    await callApplyAction(client, mkTitleAction(2, "todo_a", "Renamed"), "grp_1");

    // The filter reads `todo/completed`; a title write never reaches the plan.
    globalExpect(iterate).not.toHaveBeenCalled();
    globalExpect(seen).toHaveLength(0);
    iterate.mockRestore();

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

  it("the snapshot carries EntitySnapshot<TFields> rows (id + entity escape hatch per Path C)", async () => {
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

    // Compile-time check: each entity carries the projected
    // field shape AND the wire-envelope escape hatch (`id` and
    // `entity`). Path C's typed-snapshot signature.
    const snap = snapshotShape as {
      entities: readonly {
        title: string;
        completed: boolean;
        id: string;
        entity: { id: string; type: string };
      }[];
      filter: unknown;
      count: number;
    };
    globalExpect(snap.entities[0]?.title).toBe("T1");
    globalExpect(snap.entities[0]?.completed).toBe(false);
    globalExpect(snap.entities[0]?.id).toBe("todo_1");
    globalExpect(snap.entities[0]?.entity.id).toBe("todo_1");
    globalExpect(snap.entities[0]?.entity.type).toBe("todo");
    globalExpect(snap.count).toBe(1);

    // Compile-time check: bogus isn't a column on the snapshot.
    const _typecheck: (s: {
      count: number;
      entities: { title: string; completed: boolean }[];
      filter: unknown;
    }) => void = (s) => {
      // @ts-expect-error — `bogus` is not a field on the snapshot.
      void s.bogus;
      void s.count;
      void s.entities;
    };
    void _typecheck;

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
