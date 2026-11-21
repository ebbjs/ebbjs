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

import { createQueryCache, type QuerySource } from "../query-cache";
import { EBB_COMPONENTS } from "@ebbjs/core";
import { flushTasks, isPlatformModel, linkAction, rowComponents } from "../test-utils";
import { emptyQuery, type Query } from "../query";
import { planQuery } from "../query-plan";
import { queryCacheKey, selectionReadComponents } from "../selection";

const todoQuery = (): Query => emptyQuery("todo");

const row = (id: string, title = id): Entity => ({
  id,
  model: "todo",
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
/** Merge one edge key onto its source row. */
const writeLink = (
  replica: ReturnType<typeof createReplica>,
  sourceId: string,
  as: string,
  type: string,
  targetId: string,
): void => {
  gsn += 1;
  const action = linkAction({
    id: `a_${gsn}`,
    hlc: makeHlc(gsn),
    gsn,
    sourceId,
    edges: [{ as, type, targetId }],
  });
  replica.ingest(action, action.updates, gsn);
};

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

describe("queryCacheKey", () => {
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
    expect(queryCacheKey("rows", a)).toBe(queryCacheKey("rows", b));
    expect(queryCacheKey("rows", a)).not.toBe(queryCacheKey("collection", a));
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
    expect(queryCacheKey("rows", withUndefined)).not.toBe(queryCacheKey("rows", absent));
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
    await flushTasks();

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
    await flushTasks();
    expect(runs).toBe(1);

    // A second listener joins before the change lands, while the first run
    // is still in flight; it still has to see the first result.
    const seen: string[] = [];
    store.subscribe(() => seen.push("late"), { initial: false });
    ingest(replica, "todo", "todo_1");
    finish([row("todo_1")]);
    await flushTasks();
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
    await flushTasks();
    expect(seen.sort()).toEqual(["first", "second"]);
  });

  it("shares one entry and one run between identical queries", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica);
    const source = sourceWith(() => [row("todo_1")]);

    const first = cache.watch("rows", todoQuery(), source);
    first.subscribe(() => {});
    await flushTasks();

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
    await flushTasks();
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
    await flushTasks();
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
    await flushTasks();

    source.resolve([row("todo_1")]);
    await flushTasks();
    expect(store.getSnapshot().status).toBe("current");
    expect(notified).toBe(1);

    ingest(replica, "todo", "todo_2");
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(source.runs).toBe(2);
    // The pending async refresh publishes `stale` so a mounted view can show
    // the still-usable result while the new one is in flight.
    await flushTasks();
    expect(notified).toBe(2);

    source.resolve([row("todo_1"), row("todo_2")]);
    await flushTasks();
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
    await flushTasks();
    source.resolve([row("todo_1")]);
    await flushTasks();
    expect(notified).toBe(1);

    // The change re-runs to the same rows, but the pending refresh still
    // publishes `stale`; its settle must wake the view back to `current`.
    ingest(replica, "todo", "todo_1");
    await flushTasks();
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(notified).toBe(2);

    source.resolve([row("todo_1")]);
    await flushTasks();
    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data).toEqual([row("todo_1")]);
    expect(notified).toBe(3);
  });

  it("stays stale through an unrelated batch while the re-run is in flight", async () => {
    const replica = createReplica();
    ingest(replica, "todo", "todo_1");
    const cache = createQueryCache(replica);
    const source = deferredSource();
    const store = cache.watch("rows", todoQuery(), source);
    store.subscribe(() => {});
    await flushTasks();
    source.resolve([row("todo_1")]);
    await flushTasks();
    expect(store.getSnapshot().status).toBe("current");

    // A relevant change starts a run that stays pending, so the visible result
    // still reflects the older revision.
    ingest(replica, "todo", "todo_1", "todo_1 next");
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(source.runs).toBe(2);

    // A peer write touches nothing this result reads; it must not claim the
    // pending run has caught up.
    ingest(replica, "note", "note_1");
    expect(store.getSnapshot()).toMatchObject({ status: "stale", loading: false });
    expect(source.runs).toBe(2);

    source.resolve([row("todo_1", "todo_1 next")]);
    await flushTasks();
    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });
    expect(store.getSnapshot().data).toEqual([row("todo_1", "todo_1 next")]);
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
    await flushTasks();
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
    await flushTasks();
    expect(source.runs).toBe(1);

    // An edge lands on its source row as the `ebb/link` component.
    writeLink(replica, "todo_1", "owner", "todo", "user_1");
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
    await flushTasks();
    expect(notified).toBe(1);
    const beforeData = store.getSnapshot().data;

    ingest(replica, "todo", "todo_1", "todo_1");
    await flushTasks();
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
    await flushTasks();
    expect(source.runs).toBe(1);

    // A collection result is the matching id set, so a title write is not a
    // component the plan read.
    write(replica, "todo_1", "todo", { title: "Ship it" });
    expect(source.runs).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ status: "current", loading: false });

    write(replica, "todo_1", "todo", { status: "done" });
    expect(source.runs).toBe(2);
  });

  it("re-runs a full-scan collection only when the model's row set changes", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    const query = emptyQuery("todo");
    // A scan with no predicate names no component: its id set depends on the
    // model's membership, not on any value it carries.
    expect(planQuery(query).readComponents).toEqual([]);
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "todo", { title: "Ship it" });
    expect(source.runs).toBe(1);

    remove(replica, "todo_1");
    expect(source.runs).toBe(2);
  });

  it("reads the whole source model for a projected-row result", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    const query = statusQuery();
    expect(selectionReadComponents(query)).toContain("todo/*");
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", query, source);
    store.subscribe(() => {});
    await flushTasks();
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
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "todo", { draft: "wip" });
    expect(source.runs).toBe(2);
  });

  it("invalidates a component-scoped read on a membership change to its model", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open" });
    const cache = createQueryCache(replica);
    // A plan whose every branch names a component reads those components only;
    // a row entering or leaving the model's set still changes its result.
    const query: Query = {
      ...emptyQuery("todo"),
      groups: [[{ kind: "field", field: "status", value: "open" }]],
    };
    expect(planQuery(query).readComponents).toEqual(["todo/status"]);
    const source = sourceWith(() => ["todo_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    // A delete names no component: a membership change reaches the read
    // through the model, and one of another model does not.
    write(replica, "note_1", "note", { status: "open" });
    expect(source.runs).toBe(1);

    const before = replica.revision;
    remove(replica, "todo_1");
    expect(replica.changesSince(before)).toMatchObject([
      { kind: "membership", membership: "left", models: ["todo"] },
    ]);
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
    expect(planQuery(query).readComponents).toEqual(["ebb/membership"]);
    const source = sourceWith(() => ["todo_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, "eg_1", "membership", { entity_id: "todo_1", group_id: "group_1" });
    expect(source.runs).toBe(2);
  });

  it("does not re-run a component-scoped read on another platform component's write", async () => {
    const replica = createReplica();
    write(replica, "g_1", "group", { name: "Team" });
    // The grant row exists before the read: the write below is then a content
    // change, not a row entering the platform model's set.
    write(replica, "gm_1", "grant", { actor_id: "a", group_id: "g_1", permissions: [] });
    const cache = createQueryCache(replica);
    // A value view reads one component of the shared `ebb` model, not the model.
    const query: Query = {
      ...emptyQuery("ebb", ["ebb/group"]),
      groups: [[{ kind: "field", field: "name", value: "Team" }]],
    };
    const source = sourceWith(() => ["g_1"]);
    const store = cache.watch("collection", query, source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, "gm_1", "grant", { actor_id: "a", group_id: "g_1", permissions: ["ebb.read"] });
    await flushTasks();
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
    await flushTasks();
    expect(source.runs).toBe(1);

    // Detaching the last component leaves a row that exists with nothing
    // attached; tombstoning it names no component, so only a whole-model read
    // can see it leave.
    detach(replica, "todo_1", "todo", "status");
    const before = replica.revision;
    remove(replica, "todo_1");
    expect(replica.changesSince(before)).toMatchObject([
      { kind: "membership", membership: "left", models: ["todo"] },
    ]);
    await flushTasks();
    expect(source.runs).toBe(3);
  });

  it("does not re-run a model read when an ebb/* overlay lands on its row", async () => {
    const replica = createReplica();
    write(replica, "todo_1", "todo", { status: "open", title: "Ship" });
    const cache = createQueryCache(replica);
    // An `ebb/*` component may sit on a row of any model and never determines
    // the row's model (the prefix is the model namespace), so a `todo/*` read's components
    // are untouched by an edge write.
    const source = sourceWith(() => [row("todo_1")]);
    const store = cache.watch("rows", emptyQuery("todo"), source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    write(replica, "todo_1", "ebb", { link: "x" });
    expect(source.runs).toBe(1);
  });

  it("re-runs a rows read for a row the replica does not retain", async () => {
    // Every `document/*` component is materialized on demand, so the replica
    // keeps the row without keeping a value of it — and `iterate` still answers
    // with it, which is all a rows read scans.
    const replica = createReplica({
      materialization: { holds: (component) => !component.startsWith("document/") },
    });
    const cache = createQueryCache(replica);
    const source = sourceWith(() => replica.iterate("document"));
    const store = cache.watch("rows", emptyQuery("document"), source);
    store.subscribe(() => {});
    await flushTasks();
    expect(source.runs).toBe(1);

    gsn += 1;
    replica.ingest(
      { id: `a_${gsn}`, actor_id: "a", hlc: makeHlc(gsn), gsn, updates: [] },
      [
        {
          id: `u_${gsn}_create`,
          subject_id: "doc_1",
          model: "document",
          method: "create",
          hlc: makeHlc(gsn),
          data: null,
        },
        {
          id: `u_${gsn}_text`,
          subject_id: "doc_1",
          component: componentName("document", "text"),
          method: "replace",
          data: { value: "body", update_id: `u_${gsn}`, hlc: makeHlc(gsn) },
        },
      ],
      gsn,
    );

    await flushTasks();
    expect(source.runs).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ status: "current" });
    expect((store.getSnapshot().data ?? []).map((row) => row.id)).toEqual(["doc_1"]);
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
    await flushTasks();

    expect(store.getSnapshot()).toMatchObject({ status: "failed", loading: false });
    expect(store.getSnapshot().error?.message).toBe("boom");
    expect(notified).toBe(1);

    shouldFail = false;
    ingest(replica, "todo", "todo_2");
    await flushTasks();
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
    await flushTasks();
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
    await flushTasks();
    expect(remountSource.runs).toBe(1);
    expect(second.getSnapshot().data).toEqual([row("todo_2")]);
  });

  it("keeps a result that remounts before its TTL", async () => {
    const replica = createReplica();
    const cache = createQueryCache(replica, undefined, { ttlMs: 1_000 });
    const source = sourceWith(() => [row("todo_1")]);
    const detach = cache.watch("rows", todoQuery(), source).subscribe(() => {});
    await flushTasks();
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
    await flushTasks();

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
    await flushTasks();

    // Prime the cache at revision 1.
    source.resolve([row("todo_1")]);
    await flushTasks();
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
    await flushTasks();
    expect(source.runs).toBe(3);

    source.resolve([row("todo_1", "todo_1 next")]);
    await flushTasks();
    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data).toEqual([row("todo_1", "todo_1 next")]);
  });
});

describe("query cache: lease ownership (#937)", () => {
  /** A replica whose `todo/title` is on demand, so a claim is observable. */
  const lazyReplica = (): ReturnType<typeof createReplica> => {
    const rows: Record<string, Entity> = { todo_1: row("todo_1") };
    return createReplica({
      materialization: { holds: (component) => component !== "todo/title" },
      readComponent: async (id) => rows[id] ?? null,
      residencyTtlMs: 0,
    });
  };

  it("leases the components a live result read and releases them on unsubscribe", async () => {
    const replica = lazyReplica();
    await replica.read("todo_1", ["todo/title"]);
    const cache = createQueryCache(replica);
    const store = cache.watch(
      "rows",
      todoQuery(),
      sourceWith(() => [row("todo_1")]),
    );
    const detach = store.subscribe(() => {});
    await flushTasks();

    // A projected-row result reads its source model whole, so the live entry
    // keeps the row's component resident.
    expect(replica.stats().leases).toMatchObject({
      leased: 1,
      inactive: 0,
      byComponent: { "todo/title": { leased: 1, inactive: 0 } },
    });

    detach();
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1 });
  });

  it("keeps its claims through a failed run and releases them on unsubscribe", async () => {
    const replica = lazyReplica();
    await replica.read("todo_1", ["todo/title"]);
    const cache = createQueryCache(replica);
    let shouldFail = false;
    const source: QuerySource<Entity> = {
      ready: async () => {},
      isReady: () => true,
      execute: () => {
        if (shouldFail) throw new Error("boom");
        return [row("todo_1")];
      },
    };
    const store = cache.watch("rows", todoQuery(), source);
    const detach = store.subscribe(() => {});
    await flushTasks();
    expect(replica.stats().leases.leased).toBe(1);

    shouldFail = true;
    ingest(replica, "todo", "todo_1");
    await flushTasks();
    expect(store.getSnapshot()).toMatchObject({ status: "failed" });
    // A retry is coming, so a failed entry keeps what it read.
    expect(replica.stats().leases.leased).toBe(1);

    detach();
    expect(replica.stats().leases.leased).toBe(0);
  });

  it("releases its claims when the last listener throws on the first result", async () => {
    const replica = lazyReplica();
    await replica.read("todo_1", ["todo/title"]);
    const cache = createQueryCache(replica);
    const store = cache.watch("rows", todoQuery(), {
      ready: async () => {},
      isReady: () => true,
      execute: () => [row("todo_1")],
    });

    // A synchronous source settles inside `subscribe`, so the render throw
    // escapes with the store still holding a claim and no unsubscribe handle.
    expect(() =>
      store.subscribe(() => {
        throw new Error("render");
      }),
    ).toThrow("render");

    await flushTasks();
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1 });
    expect(replica.stats().leases.timers).toBe(0);
  });
});
