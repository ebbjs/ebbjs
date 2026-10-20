import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";
import { buildPatchAction, buildPutAction } from "./fixtures";

export interface ActionLogTestSuiteOptions {
  name: string;
  factory: () => Promise<ActionLog> | ActionLog;
}

/** A `delete` for `todo_2` on the same Action id as the put — a #473 per-group copy. */
const buildPerGroupDelete = (): Update => ({
  id: "u_delete",
  subject_id: "todo_2",
  subject_type: "todo",
  method: "delete",
  data: null,
});

export const defineActionLogTests = ({ name, factory }: ActionLogTestSuiteOptions): void => {
  describe(`${name} ActionLog`, () => {
    describe("append", () => {
      it("stores the action", async () => {
        const log = await factory();
        const action = buildPutAction();
        await log.append(action);
        const actions = await log.getAll();
        expect(actions).toEqual([action]);
      });

      it("accumulates multiple actions in insertion order", async () => {
        const log = await factory();
        const a1 = buildPutAction();
        const a2: Action = { ...a1, id: "a_2", gsn: 2 };
        await log.append(a1);
        await log.append(a2);
        const actions = await log.getAll();
        expect(actions).toHaveLength(2);
        expect(actions[0].id).toBe("a_1");
        expect(actions[1].id).toBe("a_2");
      });

      it("returns the stored action, all its Updates, and its position", async () => {
        const log = await factory();
        const action = buildPutAction();
        const entry = await log.append(action);
        expect(entry.action).toEqual(action);
        expect(entry.added).toEqual(action.updates);
        expect(entry.position).toBe(1);
      });

      it("assigns monotonically increasing positions to distinct Actions", async () => {
        const log = await factory();
        const first = await log.append(buildPutAction());
        const second = await log.append(buildPatchAction());
        expect(first.position).toBe(1);
        expect(second.position).toBe(2);
      });
    });

    describe("append position + delta (#518)", () => {
      it("reports only the newly-added Updates and a stable position for a repeated id", async () => {
        const log = await factory();
        const put = buildPutAction();
        const first = await log.append(put);
        expect(first.position).toBe(1);

        const perGroup = await log.append({ ...put, updates: [buildPerGroupDelete()] });
        expect(perGroup.position).toBe(1);
        expect(perGroup.added.map((update) => update.id)).toEqual(["u_delete"]);
        expect(perGroup.action.updates.map((update) => update.id).sort()).toEqual([
          "u_1",
          "u_delete",
        ]);
      });

      it("reports no added Updates for an identical re-delivery", async () => {
        const log = await factory();
        const put = buildPutAction();
        await log.append(put);

        const again = await log.append(put);
        expect(again.added).toEqual([]);
        expect(again.position).toBe(1);

        const actions = await log.getAll();
        expect(actions).toHaveLength(1);
        expect(actions[0]!.updates).toHaveLength(1);
      });

      it("does not advance lastPosition on a repeated id", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.append(buildPatchAction());
        await log.append({ ...buildPutAction(), updates: [buildPerGroupDelete()] });
        expect(await log.lastPosition()).toBe(2);
      });
    });

    describe("appendMany", () => {
      it("appends every Action in order and returns their entries", async () => {
        const log = await factory();
        const first = buildPutAction();
        const second = buildPatchAction();

        const entries = await log.appendMany([first, second]);

        expect(entries.map((entry) => entry.action.id)).toEqual(["a_1", "a_2"]);
        expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
        expect(entries[0]!.added).toEqual(first.updates);
        expect((await log.getAll()).map((action) => action.id)).toEqual(["a_1", "a_2"]);
        expect(await log.lastPosition()).toBe(2);
      });

      it("merges a repeated id inside one batch", async () => {
        const log = await factory();
        const put = buildPutAction();

        const entries = await log.appendMany([put, { ...put, updates: [buildPerGroupDelete()] }]);

        expect(entries.map((entry) => entry.position)).toEqual([1, 1]);
        expect(entries[1]!.added.map((update) => update.id)).toEqual(["u_delete"]);
        expect(await log.lastPosition()).toBe(1);
      });

      it("is a no-op for an empty batch", async () => {
        const log = await factory();
        expect(await log.appendMany([])).toEqual([]);
        expect(await log.lastPosition()).toBe(0);
      });
    });

    describe("readTail", () => {
      it("returns every Action after the position in append order", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.append(buildPatchAction());

        const tail = await log.readTail(0);
        expect(tail.map((entry) => entry.position)).toEqual([1, 2]);
        expect(tail.map((entry) => entry.action.id)).toEqual(["a_1", "a_2"]);
      });

      it("excludes entries at or before the position", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.append(buildPatchAction());

        const tail = await log.readTail(1);
        expect(tail.map((entry) => entry.action.id)).toEqual(["a_2"]);
      });

      it("returns an empty tail past the last position", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        expect(await log.readTail(1)).toEqual([]);
      });

      it("carries the merged Update list of a repeated id", async () => {
        const log = await factory();
        const put = buildPutAction();
        await log.append(put);
        await log.append({ ...put, updates: [buildPerGroupDelete()] });

        const tail = await log.readTail(0);
        expect(tail).toHaveLength(1);
        expect(tail[0]!.position).toBe(1);
        expect(tail[0]!.added.map((update) => update.id).sort()).toEqual(["u_1", "u_delete"]);
      });
    });

    describe("lastPosition", () => {
      it("is 0 before anything is appended", async () => {
        const log = await factory();
        expect(await log.lastPosition()).toBe(0);
      });

      it("is the last assigned position", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        expect(await log.lastPosition()).toBe(1);
        await log.append(buildPatchAction());
        expect(await log.lastPosition()).toBe(2);
      });
    });

    describe("getAll", () => {
      it("returns empty array when no actions appended", async () => {
        const log = await factory();
        const actions = await log.getAll();
        expect(actions).toEqual([]);
      });
    });

    describe("getForEntity", () => {
      it("returns actions affecting the entity", async () => {
        const log = await factory();
        const action = buildPutAction();
        await log.append(action);
        const found = await log.getForEntity("todo_1");
        expect(found).toEqual([action]);
      });

      it("returns empty for unknown entity", async () => {
        const log = await factory();
        const found = await log.getForEntity("unknown");
        expect(found).toEqual([]);
      });

      it("excludes actions that touch other entities only", async () => {
        const log = await factory();
        await log.append({
          id: "a_other",
          actor_id: "a_user1",
          hlc: makeHlc(1),
          gsn: 1,
          updates: [
            {
              id: "u_other",
              subject_id: "todo_2",
              subject_type: "todo",
              method: "put",
              data: { fields: {} },
            },
          ],
        });
        const found = await log.getForEntity("todo_1");
        expect(found).toEqual([]);
      });

      it("sorts returned actions by gsn ascending", async () => {
        const log = await factory();
        await log.append({ ...buildPutAction(), id: "a_2", gsn: 2 });
        await log.append({ ...buildPutAction(), id: "a_1", gsn: 1 });
        const found = await log.getForEntity("todo_1");
        expect(found.map((a: Action) => a.gsn)).toEqual([1, 2]);
      });

      it("returns an action with multiple subjects to every entity it touches", async () => {
        const log = await factory();
        const HLC_BASE = 1_711_036_800_000;
        await log.append({
          id: "a_multi",
          actor_id: "a_user1",
          hlc: makeHlc(HLC_BASE),
          gsn: 1,
          updates: [
            {
              id: "u_multi_1",
              subject_id: "todo_1",
              subject_type: "todo",
              method: "put",
              data: { fields: {} },
            },
            {
              id: "u_multi_2",
              subject_id: "todo_2",
              subject_type: "todo",
              method: "put",
              data: { fields: {} },
            },
          ],
        });
        expect((await log.getForEntity("todo_1")).map((a: Action) => a.id)).toEqual(["a_multi"]);
        expect((await log.getForEntity("todo_2")).map((a: Action) => a.id)).toEqual(["a_multi"]);
      });
    });

    describe("clear", () => {
      it("removes all stored actions", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.clear();
        const actions = await log.getAll();
        expect(actions).toEqual([]);
      });

      it("resets the position cursor", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.clear();
        expect(await log.lastPosition()).toBe(0);
        expect(await log.readTail(0)).toEqual([]);
      });
    });
  });
};
