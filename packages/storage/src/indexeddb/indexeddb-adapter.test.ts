import { describe, expect, it } from "vitest";
import { makeHlc } from "@ebbjs/core";
import type { ConflictSubjectState, OutboxConflict } from "../types/outbox-store";
import type { StorageAdapter } from "../types/storage-adapter";
import { defineAdapterTests } from "../testing/adapter.test-suite";
import {
  HLC_BASE,
  buildDeletedTodoEntity,
  buildOutboxConflict,
  buildPutAction,
  buildTodoEntity,
} from "../testing/fixtures";
import { createIndexedDBAdapter, type IndexedDBAdapterOptions } from "./indexeddb-adapter";

/**
 * Each test gets a uniquely-named IndexedDB database so they cannot
 * collide with one another. fake-indexeddb (loaded via test-setup.ts)
 * installs the API on globalThis; happy-dom supplies the surrounding
 * DOM globals.
 */
let adapterCount = 0;

const factory = async (): Promise<StorageAdapter> => {
  const dbName = `ebb-adapter-${Date.now()}-${++adapterCount}`;
  const options: IndexedDBAdapterOptions = { dbName };
  return createIndexedDBAdapter(options);
};

defineAdapterTests({
  name: "IndexedDB",
  factory,
});

describe("IndexedDB adapter persistence", () => {
  it("round-trips a conflict payload's populated, null, and tombstoned subjectStates", async () => {
    const dbName = `ebb-adapter-reload-${Date.now()}-${++adapterCount}`;
    const subjectStates: readonly ConflictSubjectState[] = [
      // Both sides materialized, the common case.
      {
        subjectId: "todo_1",
        subjectType: "todo",
        before: buildTodoEntity("todo_1", "mine", makeHlc(HLC_BASE)),
        after: buildTodoEntity("todo_1", "theirs", makeHlc(HLC_BASE, 1)),
      },
      // `before: null` — a patch or delete whose base row was never cached.
      {
        subjectId: "todo_2",
        subjectType: "todo",
        before: null,
        after: buildTodoEntity("todo_2", "theirs", makeHlc(HLC_BASE, 1)),
      },
      // The missed window deleted the row, so `after` is a tombstone.
      {
        subjectId: "todo_3",
        subjectType: "todo",
        before: buildTodoEntity("todo_3", "mine", makeHlc(HLC_BASE)),
        after: buildDeletedTodoEntity("todo_3", "mine", makeHlc(HLC_BASE, 1)),
      },
      // `after: null` is in the payload type even though detection does
      // not produce it: storage round-trips whatever the type permits,
      // not only today's producer output.
      {
        subjectId: "todo_4",
        subjectType: "todo",
        before: buildTodoEntity("todo_4", "mine", makeHlc(HLC_BASE)),
        after: null,
      },
    ];
    const conflict: OutboxConflict = {
      ...buildOutboxConflict(),
      subjects: subjectStates.map((state) => state.subjectId),
      subjectStates,
    };
    const entry = {
      action: buildPutAction(),
      status: "conflicted" as const,
      enqueuedAtHlc: buildPutAction().hlc,
      basedOnGsn: 0,
      conflict,
    };

    const first = await createIndexedDBAdapter({ dbName });
    await first.outbox.put(entry);

    const reopened = await createIndexedDBAdapter({ dbName });

    expect(await reopened.outbox.get(entry.action.id)).toEqual(entry);
  });
});
