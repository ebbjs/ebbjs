/**
 * Tests for `QueryBuilder.subscribe` — the reactive trigger scoped to
 * the chain's source entity type.
 *
 * `builder.subscribe(listener)` fires whenever an entity of the
 * builder's source type materializes. The listener is a bare
 * "something changed" signal: terminal methods re-read the latest
 * snapshot, so a listener re-materializes to observe the new result.
 * Membership is deliberately not filtered here — `EntityNamespace.subscribe`
 * is the membership-filtered surface; this trigger exists so a
 * matching row whose non-filtered field changed still wakes the chain.
 */

import { describe, it, expect } from "vitest";
import { makeHlc, type Action, type Entity } from "@ebbjs/core";
import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { buildQueryBuilder } from "../query-builder";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { callApplyAction } from "../test-utils";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const note = defineEntity("note", {
  body: e.string(),
});

const schema = defineSchema({
  entities: { todo, note },
  version: 1,
});

const mkTodoAction = (gsn: number, subjectId: string): Action => ({
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
          completed: { value: false, update_id: `u_${gsn}`, hlc: makeHlc(1) },
        },
      },
    },
  ],
});

const mkNoteAction = (gsn: number, subjectId: string): Action => ({
  id: `act_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: [
    {
      id: `u_${gsn}`,
      subject_id: subjectId,
      subject_type: "note",
      method: "put",
      data: {
        fields: { body: { value: `N${gsn}`, update_id: `u_${gsn}`, hlc: makeHlc(1) } },
      },
    },
  ],
});

describe("QueryBuilder.subscribe", () => {
  it("fires when an entity of the builder's source type materializes", async () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      schema,
    });

    const builder = client.todo.query();
    const seen: string[] = [];
    const unsub = builder.subscribe(() => seen.push("change"));

    await callApplyAction(client, mkTodoAction(1, "todo_1"), "grp_1");
    expect(seen).toHaveLength(1);

    await callApplyAction(client, mkTodoAction(2, "todo_2"), "grp_1");
    expect(seen).toHaveLength(2);

    unsub();
  });

  it("does not fire for a change to a different entity type", async () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      schema,
    });

    const builder = client.todo.query();
    const seen: string[] = [];
    const unsub = builder.subscribe(() => seen.push("change"));

    await callApplyAction(client, mkNoteAction(1, "note_1"), "grp_1");
    expect(seen).toHaveLength(0);

    unsub();
  });

  it("stops firing after the returned unsubscribe runs", async () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      schema,
    });

    const builder = client.todo.query();
    const seen: string[] = [];
    const unsub = builder.subscribe(() => seen.push("change"));

    await callApplyAction(client, mkTodoAction(1, "todo_1"), "grp_1");
    expect(seen).toHaveLength(1);

    unsub();

    await callApplyAction(client, mkTodoAction(2, "todo_2"), "grp_1");
    expect(seen).toHaveLength(1);
  });

  it("is a callable no-op for a bare builder with no query context", () => {
    const builder = buildQueryBuilder([], todo.shape);
    const seen: string[] = [];
    const unsub = builder.subscribe(() => seen.push("change"));

    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("is a callable no-op when the adapter ships no change emitter", async () => {
    const emitterless: StorageAdapter = {
      ...createMemoryAdapter(),
      changeEmitter: undefined,
    };
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage: emitterless,
      schema,
    });

    const seen: string[] = [];
    const unsub = client.todo.query().subscribe(() => seen.push("change"));

    const entity: Entity = {
      id: "todo_1",
      type: "todo",
      data: {
        fields: {
          title: { value: "T", update_id: "u", hlc: makeHlc(1) },
          completed: { value: false, update_id: "u", hlc: makeHlc(1) },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 1,
    };
    await emitterless.entities.set(entity);

    expect(seen).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });
});
