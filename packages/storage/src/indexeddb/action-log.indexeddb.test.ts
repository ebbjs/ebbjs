import { defineActionLogTests } from "../testing/action-log.test-suite";
import type { ActionLog } from "../types/action-log";
import { createIndexedDBActionLog } from "./action-log.indexeddb";
import { openTestDb } from "./test-db";

const factory = async (): Promise<ActionLog> => {
  const db = await openTestDb("action-log");
  return createIndexedDBActionLog(db);
};

defineActionLogTests({
  name: "IndexedDB",
  factory,
});
