import { defineCursorStoreTests } from "../testing/cursor-store.test-suite";
import type { CursorStore } from "../types/cursor-store";
import { createIndexedDBCursorStore } from "./cursor-store.indexeddb";
import { openTestDb } from "./test-db";

const factory = async (): Promise<CursorStore> => {
  const db = await openTestDb("cursor-store");
  return createIndexedDBCursorStore(db);
};

defineCursorStoreTests({
  name: "IndexedDB",
  factory,
});
