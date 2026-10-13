import { describe, expect, it } from "vitest";
import { buildConflictEntry, buildPutAction } from "../testing/fixtures";
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
      const entry = {
        action,
        status: "pending" as const,
        enqueuedAtHlc: action.hlc,
        basedOnGsn: 0,
      };
      await db.put("outbox", entry);
      expect(await db.get("outbox", "a_1")).toEqual(entry);
    });
  });

  describe("conflicts store", () => {
    it("is created at the current schema version and keyed by action id", async () => {
      const db = await openTestDb("schema");
      expect(Array.from(db.objectStoreNames)).toContain("conflicts");

      const entry = buildConflictEntry();
      await db.put("conflicts", entry);
      expect(await db.get("conflicts", "a_1")).toEqual(entry);
    });
  });
});
