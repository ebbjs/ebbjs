/**
 * SyncClient fan-out of the storage adapter's change emitter.
 *
 * `_applyAction` is the single funnel for inbound actions (SSE and
 * catch-up). After it stores an action and marks the affected
 * entities dirty, it force-materializes each affected entity so
 * subscribers on the storage adapter's change emitter observe the
 * new state immediately. Without the force-materialize, the
 * emitter's "fires on materialization" contract would require every
 * consumer to issue a read first.
 */

import { describe, it, expect } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { createClient } from "../client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

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

const mkAction = (gsn: number, subjectId: string): Action => ({
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
        fields: { title: { value: `Title ${gsn}`, update_id: `u_${gsn}`, hlc: makeHlc(1) } },
      },
    },
  ],
});

describe("SyncClient._applyAction fan-out to storage change emitter", () => {
  it("fires onEntityChange for every affected id when the action is applied", async () => {
    const storage = createMemoryAdapter();
    if (storage.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
    });

    const seen: string[] = [];
    const unsub = storage.changeEmitter.onEntityChange("todo_1", (e) => {
      if (e !== null) seen.push(String(e.data.fields.title.value));
    });

    await callApplyAction(client, mkAction(1, "todo_1"), "grp_1");
    expect(seen).toEqual(["Title 1"]);

    await callApplyAction(client, mkAction(2, "todo_1"), "grp_1");
    expect(seen).toEqual(["Title 1", "Title 2"]);

    unsub();
  });

  it("fires onTypeChange for the affected type", async () => {
    const storage = createMemoryAdapter();
    if (storage.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
    });

    const seen: string[] = [];
    const unsub = storage.changeEmitter.onTypeChange("todo", (e) => {
      seen.push(e.id);
    });

    await callApplyAction(client, mkAction(1, "todo_1"), "grp_1");
    await callApplyAction(client, mkAction(2, "todo_2"), "grp_1");
    expect(seen.sort()).toEqual(["todo_1", "todo_2"]);

    unsub();
  });

  it("preserves the dirty flag after the fan-out so the SSE invariant holds", async () => {
    const storage = createMemoryAdapter();
    if (storage.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
    });

    await callApplyAction(client, mkAction(1, "todo_1"), "grp_1");
    // The fan-out replays the action log and fires the emitter but
    // does NOT clear the dirty flag — a subsequent read will
    // re-materialize the same entity. This is the invariant the
    // SSE tests pin (post-receipt isDirty must remain true).
    expect(await storage.isDirty("todo_1")).toBe(true);

    // The listener fired exactly once during the fan-out.
    let fired = 0;
    const unsub = storage.changeEmitter.onEntityChange("todo_1", () => {
      fired++;
    });
    await client.readLocalEntity("todo_1");
    // Reading re-materializes (still dirty) → listener fires once.
    expect(fired).toBe(1);
    expect(await storage.isDirty("todo_1")).toBe(false);
    unsub();
  });
});
