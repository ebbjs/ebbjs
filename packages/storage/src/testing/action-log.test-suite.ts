import { describe, expect, it } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";
import { buildPutAction } from "./fixtures";

export interface ActionLogTestSuiteOptions {
  name: string;
  factory: () => Promise<ActionLog> | ActionLog;
}

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
    });

    describe("clear", () => {
      it("removes all stored actions", async () => {
        const log = await factory();
        await log.append(buildPutAction());
        await log.clear();
        const actions = await log.getAll();
        expect(actions).toEqual([]);
      });
    });
  });
};
