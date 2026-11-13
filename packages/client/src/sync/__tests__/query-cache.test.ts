/**
 * Unit tests for the reactive query-result cache (#512).
 *
 * The cache is keyed by the lowered query, derives its status from the
 * replica's revision, and invalidates on components: a replica change re-runs
 * only entries whose read set it touches. A re-run that produces an equal
 * result does not notify.
 */

import { describe, expect, it } from "vitest";
import { componentName, makeHlc, type Entity, type FieldValue, type Update } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";

import { createQueryCache, queryKey, type QuerySource } from "../query-cache";
import { EBB_COMPONENTS } from "@ebbjs/core";
import { isPlatformModel, rowComponents } from "../test-utils";
import { emptyQuery, type Query } from "../query";
import { planQuery, rowReadComponentsFor } from "../query-plan";

const todoQuery = (): Query => emptyQuery("todo");

const row = (id: string, title = id): Entity => ({
  id,
  type: "todo",
  data: { fields: { title: { value: title, update_id: `u_${id}`, hlc: makeHlc(1) } } },
  exists: true,
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
  method: "merge" | "replace" = "replace",
): void => {
  gsn += 1;
  const components = isPlatformModel(type)
    ? [[EBB_COMPONENTS[type], { value: {}, update_id: `u_${gsn}`, hlc: makeHlc(gsn) }] as const]
    : Object.entries(row(id, title).data.fields).map(
        ([field, value]) => [componentName(type, field), value] as const,
      );
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
    components.map(([component, value]) => ({
      id: `u_${gsn}_${component}`,
      subject_id: id,
      component,
      method,
      data: value,
    })),
    gsn,
  );
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Write the named components in one action, so the journal reports exactly them. */
const write = (
  replica: ReturnType<typeof createReplica>,
  id: string,
  type: string,
  fields: Record<string, unknown>,
): void => {
  gsn += 1;
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
    rowComponents(type, fields).map(
      ([component, value]): Update => ({
        id: `u_${gsn}_${component}`,
        subject_id: id,
        component,
        method: "replace" as const,
        data: { value, update_id: `u_${gsn}`, hlc: makeHlc(gsn) } as FieldValue,
      }),
    ),
    gsn,
  );
};

/** Detach one component; the row survives with its siblings. */
const detach = (
  replica: ReturnType<typeof createReplica>,
  id: string,
  type: string,
  field: string,
): void => {
  gsn += 1;
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
    [
      {
        id: `u_${gsn}`,
        subject_id: id,
        component: componentName(type, field),
        method: "drop",
        data: null,
      },
    ],
    gsn,
  );
};

/** Tombstone a row; a delete names no component. */
const remove = (replica: ReturnType<typeof createReplica>, id: string): void => {
  gsn += 1;
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
    [{ id: `u_${gsn}`, subject_id: id, method: "delete", data: null }],
    gsn,
  );
};

const sourceWith = <T>(rows: () => readonly T[]): QuerySource<T> & { runs: number } => {
  const source = {
    runs: 0,
    ready: async (): Promise<void> => {},
    isReady: (): boolean => true,
    execute: async (): Promise<readonly T[]> => {
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
});

describe("query cache: invalidation", () => {
  it("re-runs on a read-component hit, keeps data usable while stale, and notifies on the status change", async () => {
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

  it("advances the revision and stays silent when no change touches its reads", async () => {
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

    ingest(replica, "link", "rel_1");
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

describe("query cache: component-granular invalidation", () => {
  const statusQuery = (): Query => ({
    ...emptyQuery("todo"),
    groups: [[{ kind: "field", field: "status", value: "open" }]],
  });

  it("does not re-run a plan that reads another component", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    const query = statusQuery();
    expect(planQuery(query).readComponents).toEqual(["todo/status"]);
    const source = sourceWith(() => ["todo_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    // A collection result is the matching id set, so a title write is not a
    // component the plan read.
    write(replica, "todo_1", "todo", { title: "Ship it" });
    expect(source.runs).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });

    write(replica, "todo_1", "todo", { status: "done" });
    expect(source.runs).toBe(2);
  });

  it("re-runs a full scan on any component of the model it scans", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    const query = emptyQuery("todo");
    expect(planQuery(query).readComponents).toEqual(["todo/*"]);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "todo", { title: "Ship it" });
    expect(source.runs).toBe(2);
  });

  it("reads the whole source model for a projected-row result", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    const query = statusQuery();
    expect(rowReadComponentsFor(query)).toContain("todo/*");
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    // The cached result carries the title, so a title write must re-run it.
    write(replica, "todo_1", "todo", { title: "Ship it" });
    expect(source.runs).toBe(2);
  });

  it("re-runs a plan when a row gains a component it excluded", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open" });
    const cache = createQueryCache(replica);
    const query: Query = {
      ...emptyQuery("todo"),
      groups: [
        [
          { kind: "field", field: "status", value: "open" },
          { kind: "existence", component: "todo/draft", present: false },
        ],
      ],
    };
    // `hasNot` reads the component even though it does not require it: the
    // component appearing is what removes the row from the result.
    expect(planQuery(query).readComponents).toEqual(["todo/status", "todo/draft"]);
    const source = sourceWith(() => ["todo_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "todo", { draft: "wip" });
    expect(source.runs).toBe(2);
  });

  it("re-runs a membership-only plan when membership changes", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open" });
    const cache = createQueryCache(replica);
    const query: Query = {
      ...emptyQuery("todo"),
      groups: [[{ kind: "membership", anyOf: ["group_1"] }]],
    };
    expect(planQuery(query).readComponents).toEqual(["todo/*", "ebb/membership"]);
    const source = sourceWith(() => ["todo_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "eg_1", "membership", { entity_id: "todo_1", group_id: "group_1" });
    expect(source.runs).toBe(2);
  });

  it("does not re-run a component-scoped read on another platform component's write", async () => {
    const replica = createReplica();
    write(replica, "g_1", "group", { name: "Team" });
    const cache = createQueryCache(replica);
    // A value view reads one component of the shared `ebb` model, not the model.
    const query: Query = {
      ...emptyQuery("ebb", ["ebb/group"]),
      groups: [[{ kind: "field", field: "name", value: "Team" }]],
    };
    const source = sourceWith(() => ["g_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "gm_1", "grant", { actor_id: "a", group_id: "g_1", permissions: [] });
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "g_1", "group", { name: "Renamed" });
    expect(source.runs).toBe(2);
  });

  it("invalidates a whole-model read on a change that names no component", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open" });
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", emptyQuery("todo"), source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    // Detaching the last component leaves a row that exists with nothing
    // attached; tombstoning it touches no component, so only a whole-model
    // read can see it leave.
    detach(replica, "todo_1", "todo", "status");
    const before = replica.revision;
    remove(replica, "todo_1");
    expect(replica.changesSince(before)).toMatchObject([{ components: [] }]);
    await flush();
    expect(source.runs).toBe(3);
  });

  it("matches a whole-model read when a cross-model write renames the row", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    // Writing an `ebb/*` component moves the row's model, so the change reports
    // every field under both prefixes; the `todo/*` read still sees its old
    // components.
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", emptyQuery("todo"), source);
    store.subscribe(() => {});
    await flush();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "ebb", { link: "x" });
    expect(source.runs).toBe(2);
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

describe("query cache: inactive result TTL (#499)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("evicts a result after its inactive TTL and remounts unloaded", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 10 });
    const first = cache.watch(
      "rows",
      todoQuery(),
      sourceWith(() => [row("todo_1")]),
    );
    const detach = first.subscribe(() => {});
    await flush();
    expect(first.getSnapshot().status).toBe("current");
    detach();

    await sleep(25);

    const remountSource = sourceWith(() => [row("todo_2")]);
    const second = cache.watch("rows", todoQuery(), remountSource);
    expect(second.getSnapshot()).toMatchObject({
      data: undefined,
      status: "unloaded",
      loading: true,
    });
    second.subscribe(() => {});
    await flush();
    expect(remountSource.runs).toBe(1);
    expect(second.getSnapshot().data).toEqual([row("todo_2")]);
  });

  it("keeps a result that remounts before its TTL", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 1_000 });
    const source = sourceWith(() => [row("todo_1")]);
    const detach = cache.watch("rows", todoQuery(), source).subscribe(() => {});
    await flush();
    detach();

    const remountSource = sourceWith(() => [row("todo_2")]);
    const remount = cache.watch("rows", todoQuery(), remountSource);
    expect(remount.getSnapshot()).toMatchObject({ status: "current", loading: false });
    expect(remount.getSnapshot().data).toEqual([row("todo_1")]);
    expect(remountSource.runs).toBe(0);
  });

  it("does not evict a result while it still has a subscriber", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 10 });
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", todoQuery(), source);
    store.subscribe(() => {});
    await flush();

    await sleep(25);

    const remount = cache.watch(
      "rows",
      todoQuery(),
      sourceWith(() => []),
    );
    expect(remount.getSnapshot().data).toEqual([row("todo_1")]);
    expect(remount.getSnapshot().status).toBe("current");
  });
});

describe("query cache: change-journal floor (#499)", () => {
  it("forces a full re-run when a slow run lets the window trim past its start", async () => {
    const replica = createReplica({ journalCapacity: 2 });
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = deferredSource();
    const store = cache.watch("rows", todoQuery(), source);
    store.subscribe(() => {});
    await flush();

    // Prime the cache at revision 1.
    source.resolve([row("todo_1")]);
    await flush();
    expect(store.getSnapshot().status).toBe("current");
    expect(replica.changeFloor).toBe(0);

    // A relevant change starts the second run at revision 2 and holds it open.
    ingest(replica, "todo", "todo_1", "todo_1 next");
    expect(source.runs).toBe(2);

    // More changes than the journal retains land while that run is pending.
    for (let i = 0; i < 5; i += 1) ingest(replica, "note", `note_${i}`);
    expect(replica.changeFloor).toBeGreaterThan(2);

    // The run settles at revision 2, which is now below the floor. Without the
    // floor the note-only window would not intersect the reads; the gap
    // forces the full re-run instead.
    source.resolve([row("todo_1", "todo_1 next")]);
    await flush();
    expect(source.runs).toBe(3);

    source.resolve([row("todo_1", "todo_1 next")]);
    await flush();
    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data).toEqual([row("todo_1", "todo_1 next")]);
  });
});
