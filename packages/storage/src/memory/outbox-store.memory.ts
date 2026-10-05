import { compare } from "@ebbjs/core";

import type { OutboxEntry, OutboxStore } from "../types/outbox-store";

/**
 * MemoryOutboxStore — in-memory implementation of OutboxStore.
 *
 * State is a record keyed by `action.id`; `list()` sorts by
 * `enqueuedAtHlc` on read because HLCs are packed BigInts rendered as
 * decimal strings, so their natural string order is not numeric order.
 */
export const createMemoryOutboxStore = (): OutboxStore => {
  let entries: Readonly<Record<string, OutboxEntry>> = {};

  return {
    async put(entry: OutboxEntry): Promise<void> {
      // Clone so a caller mutating the entry it passed in cannot
      // change what a later read returns.
      entries = { ...entries, [entry.action.id]: structuredClone(entry) };
    },

    async list(): Promise<readonly OutboxEntry[]> {
      return Object.values(entries)
        .map((entry) => structuredClone(entry))
        .sort((a, b) => compare(a.enqueuedAtHlc, b.enqueuedAtHlc));
    },

    async get(actionId: string): Promise<OutboxEntry | null> {
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
