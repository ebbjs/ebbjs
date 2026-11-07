import type { CursorRecord } from "../types/cursor-store";

/**
 * A resume record with absent fields omitted rather than set to `undefined`,
 * so the memory and IndexedDB adapters return the same shape for the same
 * state and a stored row never carries a field it does not hold.
 */
export const compactCursorRecord = (record: CursorRecord): CursorRecord => {
  const compact: { -readonly [K in keyof CursorRecord]: CursorRecord[K] } = {};
  if (record.cursor !== undefined) compact.cursor = record.cursor;
  if (record.seed !== undefined) compact.seed = record.seed;
  if (record.through !== undefined) compact.through = record.through;
  return compact;
};

/** Whether a record holds nothing and so should not be stored at all. */
export const isEmptyCursorRecord = (record: CursorRecord): boolean =>
  record.cursor === undefined && record.seed === undefined && record.through === undefined;
