import { openDB, type IDBPDatabase } from "idb";
import { createEbbStores, type EbbDBSchema } from "./schema";

let counter = 0;

/**
 * Opens a fresh, uniquely-named IndexedDB for tests. Each call returns
 * a brand-new DB so tests cannot pollute one another.
 *
 * Schema matches `EbbDBSchema` exactly so test DBs can be passed
 * straight to the production factories without a cast.
 */
export const openTestDb = async (prefix: string): Promise<IDBPDatabase<EbbDBSchema>> => {
  const dbName = `ebb-${prefix}-${Date.now()}-${++counter}`;
  return openDB<EbbDBSchema>(dbName, 2, {
    upgrade: createEbbStores,
  });
};
