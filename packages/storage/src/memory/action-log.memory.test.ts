import { describe, it, expect } from "vitest";
import { createMemoryActionLog } from "./action-log.memory";
import type { Action } from "@ebbjs/core";

describe("MemoryActionLog", () => {
  const action: Action = {
    id: "a_1",
    actor_id: "a_user1",
    hlc: "1711036800000",
    gsn: 1,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "put",
        data: { title: { value: "Hello", update_id: "u_1" } },
      },
    ],
  };

  describe("append", () => {
    it("stores the action", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      const actions = await log.getAll();
      expect(actions).toEqual([action]);
    });
  });

  describe("getForEntity", () => {
    it("returns actions affecting the entity", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      const found = await log.getForEntity("todo_1");
      expect(found).toEqual([action]);
    });

    it("returns empty for unknown entity", async () => {
      const log = createMemoryActionLog();
      const found = await log.getForEntity("unknown");
      expect(found).toEqual([]);
    });
  });

  describe("clear", () => {
    it("removes all actions and resets type index", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      await log.clear();
      const actions = await log.getAll();
      expect(actions).toEqual([]);
    });
  });
});
