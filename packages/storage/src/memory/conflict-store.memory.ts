import { compare } from "@ebbjs/core";

import type { ConflictEntry, ConflictStore } from "../types/conflict-store";

/**
 * MemoryConflictStore — in-memory implementation of ConflictStore.
 *
 * State is a record keyed by `action.id`; `list()` sorts by
 * `detectedAtHlc` on read because HLCs are packed BigInts rendered as
 * decimal strings, so their natural string order is not numeric order.
 */
export const createMemoryConflictStore = (): ConflictStore => {
  let entries: Readonly<Record<string, ConflictEntry>> = {};

  return {
    async put(entry: ConflictEntry): Promise<void> {
      // Clone so a caller mutating the entry it passed in cannot
      // change what a later read returns.
      entries = { ...entries, [entry.action.id]: structuredClone(entry) };
    },

    async list(): Promise<readonly ConflictEntry[]> {
      return Object.values(entries)
        .map((entry) => structuredClone(entry))
        .sort((a, b) => compare(a.detectedAtHlc, b.detectedAtHlc));
    },

    async get(actionId: string): Promise<ConflictEntry | null> {
      const entry = entries[actionId];
      return entry === undefined ? null : structuredClone(entry);
    },

    async delete(actionId: string): Promise<void> {
      const { [actionId]: _removed, ...rest } = entries;
      entries = rest;
    },

    async clear(): Promise<void> {
      entries = {};
    },
  };
};
