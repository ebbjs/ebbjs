import { describe, expect, it } from "vitest";
import { buildPutAction } from "../testing/fixtures";
import { openTestDb } from "./test-db";

describe("EbbDBSchema", () => {
  describe("actions store", () => {
    it("has a subject_id index for getForEntity range scans", async () => {
      const db = await openTestDb("schema");
      const tx = db.transaction("actions", "readonly");
      const indexes = Array.from(tx.store.indexNames);
      expect(indexes).toContain("subject_id");
    });
  });

  describe("relationships store", () => {
    it("is created at the current schema version", async () => {
      const db = await openTestDb("schema");
      expect(Array.from(db.objectStoreNames)).toContain("relationships");
    });
  });

  describe("outbox store", () => {
    it("is created at the current schema version and keyed by action id", async () => {
      const db = await openTestDb("schema");
      expect(Array.from(db.objectStoreNames)).toContain("outbox");

      const action = buildPutAction();
      await db.put("outbox", { action, status: "pending", enqueuedAtHlc: action.hlc });
      expect(await db.get("outbox", "a_1")).toBeDefined();
    });
  });

  describe("conflicts store", () => {
    it("is created at the current schema version and keyed by action id", async () => {
      const db = await openTestDb("schema");
      expect(Array.from(db.objectStoreNames)).toContain("conflicts");

      const action = buildPutAction();
      await db.put("conflicts", {
        action,
        losses: [
          {
            slot: { subjectId: "todo_1", field: "title", path: [] },
            winner: { update_id: "u_2", hlc: action.hlc, value: "Updated" },
          },
        ],
        detectedAtHlc: action.hlc,
      });
      expect(await db.get("conflicts", "a_1")).toBeDefined();
    });
  });
});
