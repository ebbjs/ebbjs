/**
 * Unit tests for the reactive query-result cache (#512).
 *
 * The cache is keyed by the lowered query, derives its status from the
 * replica's revision, and invalidates coarse-first: a replica change re-runs
 * only entries whose `readTypes` intersect the change's type. A re-run that
 * produces an equal result does not notify.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Entity } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";

import { createQueryCache, queryKey, type QuerySource } from "../query-cache";
import { emptyQuery, type Query } from "../query";

const todoQuery = (): Query => emptyQuery("todo");

const row = (id: string, title = id): Entity => ({
  id,
  type: "todo",
  data: { fields: { title: { value: title, update_id: `u_${id}`, hlc: makeHlc(1) } } },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
});

let gsn = 0;

const ingest = (
  replica: ReturnType<typeof createReplica>,
  type: string,
  id: string,
  title = id,
): void => {
  gsn += 1;
  const entity = row(id, title);
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
    [
      {
        id: `u_${gsn}`,
        subject_id: id,
        subject_type: type,
        method: "put",
        data: { fields: entity.data.fields },
      },
    ],
    gsn,
  );
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sourceWith = (rows: () => readonly Entity[]): QuerySource<Entity> & { runs: number } => {
  const source = {
    runs: 0,
    ready: async (): Promise<void> => {},
    isReady: (): boolean => true,
    execute: async (): Promise<readonly Entity[]> => {
      source.runs += 1;
      return rows();
    },
  };
  return source;
};

/** A source whose run is held open, so the `stale` window is observable. */
const deferredSource = (): QuerySource<Entity> & {
  runs: number;
  resolve: (rows: readonly Entity[]) => void;
} => {
  let release: ((rows: readonly Entity[]) => void) | null = null;
  const source = {
    runs: 0,
    ready: async (): Promise<void> => {},
    isReady: (): boolean => true,
    execute: (): Promise<readonly Entity[]> => {
      source.runs += 1;
      return new Promise<readonly Entity[]>((resolve) => {
        release = resolve;
      });
    },
    resolve: (rows: readonly Entity[]) => {
      const resolve = release;
      release = null;
      resolve?.(rows);
    },
  };
  return source;
};

describe("queryKey", () => {
  it("is canonical over object key order and distinct per surface", () => {
    const a: Query = {
      source: "todo",
      groups: [[{ kind: "field", field: "status", value: "open" }]],
      order: { field: "title", direction: "asc" },
      limit: 5,
      joins: [],
    };
    const b: Query = {
      joins: [],
      limit: 5,
      order: { direction: "asc", field: "title" },
      groups: [[{ value: "open", field: "status", kind: "field" }]],
      source: "todo",
    };
    expect(queryKey("rows", a)).toBe(queryKey("rows", b));
    expect(queryKey("rows", a)).not.toBe(queryKey("collection", a));
  });

  it("distinguishes an undefined predicate value from an absent one", () => {
    const withUndefined: Query = {
      ...emptyQuery("todo"),
      groups: [[{ kind: "field", field: "title", value: undefined }]],
    };
    const absent = {
      ...emptyQuery("todo"),
      groups: [[{ kind: "field", field: "title" }]],
    } as unknown as Query;
    expect(queryKey("rows", withUndefined)).not.toBe(queryKey("rows", absent));
  });
});

describe("query cache: status and subscription", () => {
  it("starts unloaded, never as an empty result, then settles current", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", todoQuery(), source);

    expect(store.getSnapshot()).toEqual({
      data: undefined,
      status: "unloaded",
      loading: true,
      error: null,
    });

    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await flush();

    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(seen).toEqual(["current"]);
  });

  it("notifies a listener that joins while the first run is in flight", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    let release: ((rows: readonly Entity[]) => void) | null = null;
    const finish = (rows: readonly Entity[]): void => {
      const resolve = release;
      release = null;
      resolve?.(rows);
    };
    let runs = 0;
    const source: QuerySource<Entity> = {
      ready: async () => {},
      isReady: () => true,
      execute: () => {
        runs += 1;
        if (runs === 1) {
          return new Promise<readonly Entity[]>((resolve) => {
            release = resolve;
          });
        }
        return [row("todo_1")];
      },
    };

    const store = cache.watch("rows", todoQuery(), source);
    store.subscribe(() => {});
    await flush();
    expect(runs).toBe(1);

    // A second listener joins before the change lands, while the first run
    // is still in flight; it still has to see the first result.
    const seen: string[] = [];
    store.subscribe(() => seen.push("late"), { initial: false });
    ingest(replica, "todo", "todo_1");
    finish([row("todo_1")]);
    await flush();
    expect(seen).toContain("late");
  });

  it("notifies every listener that opted into the first run", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    const store = cache.watch(
      "rows",
      todoQuery(),
      sourceWith(() => [row("todo_1")]),
    );
    const seen: string[] = [];
    store.subscribe(() => seen.push("first"));
    store.subscribe(() => seen.push("second"));
    await flush();
    expect(seen.sort()).toEqual(["first", "second"]);
  });

  it("shares one entry and one run between identical queries", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);

    const first = cache.watch("rows", todoQuery(), source);
    first.subscribe(() => {});
    await flush();

    const second = cache.watch(
      "rows",
      todoQuery(),
      sourceWith(() => [row("todo_2")]),
    );
    expect(second.getSnapshot().data).toEqual([row("todo_1")]);
    expect(source.runs).toBe(1);
  });

  it("leaves an unsubscribed entry stale and re-runs it on remount", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    let rows: readonly Entity[] = [row("todo_1")];
    const source = sourceWith(() => rows);
    const first = cache.watch("rows", todoQuery(), source);
    const detach = first.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);
    detach();

    ingest(replica, "todo", "todo_2");
    rows = [row("todo_1"), row("todo_2")];
    expect(source.runs).toBe(1);
    expect(first.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(first.getSnapshot().data).toEqual([row("todo_1")]);

    const second = cache.watch("rows", todoQuery(), source);
    expect(second.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    const detachSecond = second.subscribe(() => {});
    await flush();
    expect(second.getSnapshot().status).toBe("current");
    expect(second.getSnapshot().data).toEqual([row("todo_1"), row("todo_2")]);
    detachSecond();
  });

  it("reads a cached result on remount without re-running", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);

    const first = cache.watch("rows", todoQuery(), source);
    const detach = first.subscribe(() => {});
    await flush();
    detach();

    const remount = sourceWith(() => [row("todo_9")]);
    const second = cache.watch("rows", todoQuery(), remount);
    expect(second.getSnapshot()).toMatchObject({ status: "current", loading: false });
    expect(second.getSnapshot().data).toEqual([row("todo_1")]);
    expect(remount.runs).toBe(0);
  });
});

describe("query cache: coarse invalidation", () => {
  it("re-runs on a readTypes hit, keeps data usable while stale, and notifies on the status change", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = deferredSource();
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await flush();

    source.resolve([row("todo_1")]);
    await flush();
    expect(store.getSnapshot().status).toBe("current");
    expect(notified).toBe(1);

    ingest(replica, "todo", "todo_2");
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(source.runs).toBe(2);
    // The pending async refresh publishes `stale` so a mounted view can show
    // the still-usable result while the new one is in flight.
    await flush();
    expect(notified).toBe(2);

    source.resolve([row("todo_1"), row("todo_2")]);
    await flush();
    expect(store.getSnapshot().status).toBe("current");
    expect(notified).toBe(3);
  });

  it("settles a published stale snapshot back to current when the async re-run is equal", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = deferredSource();
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await flush();
    source.resolve([row("todo_1")]);
    await flush();
    expect(notified).toBe(1);

    // The change re-runs to the same rows, but the pending refresh still
    // publishes `stale`; its settle must wake the view back to `current`.
    ingest(replica, "todo", "todo_1");
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(notified).toBe(2);

    source.resolve([row("todo_1")]);
    await flush();
    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(notified).toBe(3);
  });

  it("advances the revision and stays silent when no change touches readTypes", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await flush();
    expect(source.runs).toBe(1);

    ingest(replica, "note", "note_1");
    expect(source.runs).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });
    expect(notified).toBe(1);
  });

  it("re-runs on a relationship-row change when the query reads an edge", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);
    const query: Query = {
      ...emptyQuery("todo"),
      groups: [[{ kind: "relationship", as: "owner", type: "todo", anyOf: ["user_1"] }]],
    };
    const store = cache.watch("rows", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    ingest(replica, "relationship", "rel_1");
    expect(source.runs).toBe(2);
  });

  it("does not notify when the re-run produces an equal result", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await flush();
    expect(notified).toBe(1);
    const beforeData = store.getSnapshot().data;

    ingest(replica, "todo", "todo_1", "todo_1");
    await flush();
    expect(source.runs).toBe(2);
    expect(store.getSnapshot().data).toBe(beforeData);
    expect(store.getSnapshot().status).toBe("current");
    expect(notified).toBe(1);
  });
});

describe("query cache: failure", () => {
  it("surfaces a failed run and clears it on the next success", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    let shouldFail = true;
    const source: QuerySource<Entity> = {
      ready: async () => {},
      isReady: () => true,
      execute: async () => {
        if (shouldFail) throw new Error("boom");
        return [row("todo_1")];
      },
    };
    const store = cache.watch("rows", todoQuery(), source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await flush();

    expect(store.getSnapshot()).toMatchObject({ status: "failed", loading: false });
    expect(store.getSnapshot().error?.message).toBe("boom");
    expect(notified).toBe(1);

    shouldFail = false;
    ingest(replica, "todo", "todo_2");
    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: "current", error: null });
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(notified).toBe(2);
  });
});
