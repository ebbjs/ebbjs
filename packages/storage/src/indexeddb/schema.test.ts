import { describe, expect, it } from "vitest";
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
});
