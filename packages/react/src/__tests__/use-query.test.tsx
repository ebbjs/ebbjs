/**
 * Tests for `useQuery` — subscribe a component to a cached engine query.
 *
 * The hook hands its callback `q`: the provider's client narrowed to every
 * entity namespace's `query()`. `q.todo.query` and `client.todo.query` are the
 * same method, so a hook caller and an imperative caller cannot drift.
 *
 * The result is the engine's cached store, keyed by the lowered query. Status
 * is the cache's, never stored ad hoc — `unloaded` before the first run,
 * `current` at the replica's revision, `stale` when a held result is older than
 * the replica and a re-run is pending.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import {
  createClient,
  defineEntity,
  defineRelationship,
  defineSchema,
  e,
  type NamespacedClient,
  type QueryStatus,
} from "@ebbjs/client";
import { EbbProvider, useClient, useQuery, type QueryRoot } from "../index";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const user = defineEntity("user", {
  name: e.string(),
});

const schema = defineSchema({
  entities: { todo, user },
  relationships: {
    todo_assignee: defineRelationship({
      source: todo,
      target: user,
      as: "assignee",
      sourceCardinality: "one",
    }),
  },
  version: 1,
});

type Schema = typeof schema;

type Client = NamespacedClient<Schema>;

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor", schema });

/** A replica row: what the client's own writes fold into the replica. */
type ReplicaRow = {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly fields: Record<
      string,
      { readonly value: unknown; readonly update_id: string; readonly hlc: string }
    >;
  };
  readonly created_hlc: string;
  readonly updated_hlc: string;
  readonly deleted_hlc: string | null;
  readonly last_gsn: number;
};

const mkRow = (id: string, type: string, fields: Record<string, unknown>): ReplicaRow => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        { value, update_id: `u_${id}`, hlc: "1" },
      ]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
});

const mkTodo = (id: string, title: string, completed: boolean): ReplicaRow =>
  mkRow(id, "todo", { title, completed });

const mkUser = (id: string, name: string): ReplicaRow => mkRow(id, "user", { name });

/** The forward-one edge a `with({ assignee: true })` join reads. */
const mkAssigneeLink = (id: string, todoId: string, userId: string): ReplicaRow =>
  mkRow(id, "relationship", {
    source_id: todoId,
    target_id: userId,
    type: "todo",
    field: "assignee",
  });

let seedPosition = 0;

/**
 * Fold a row into the client's replica, then write it to the shim.
 * `useQuery` reads the replica, so a shim-only row is invisible; the fold uses
 * the same Action / Update path the client's writes do.
 */
const seedRow = async (
  client: Client,
  row: ReplicaRow,
  method: "put" | "delete" = row.deleted_hlc === null ? "put" : "delete",
): Promise<void> => {
  seedPosition += 1;
  const hlc = String(BigInt(seedPosition) << 16n);
  client.replica.ingest(
    {
      id: `a_seed_${seedPosition}`,
      actor_id: "seed",
      hlc,
      gsn: seedPosition,
      updates: [],
    },
    [
      method === "put"
        ? {
            id: `u_seed_${seedPosition}`,
            subject_id: row.id,
            subject_type: row.type,
            method,
            data: { fields: row.data.fields },
          }
        : {
            id: `u_seed_${seedPosition}`,
            subject_id: row.id,
            subject_type: row.type,
            method: "delete",
            data: null,
          },
    ],
    seedPosition,
  );
  await client.storage.entities.set(row);
};

const seed = (client: Client, id: string, title: string, completed: boolean) =>
  seedRow(client, mkTodo(id, title, completed));

/** A todo with `assignee` linked to a user, as a real write would leave it. */
const seedAssigned = async (client: Client, assigneeName: string): Promise<void> => {
  await seedRow(client, mkUser("user_1", assigneeName));
  await seed(client, "todo_1", "Ship it", false);
  await seedRow(client, mkAssigneeLink("rel_1", "todo_1", "user_1"));
};

afterEach(cleanup);

function renderWithClient(client: Client, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

const flush = () => act(async () => {});

/** One render's state, so a test can assert a status transition. */
type RenderSnapshot = { readonly status: QueryStatus; readonly titles: string };

/** Renders the queried rows plus status, loading, and error. */
function TodoList({
  completed,
  onRender,
  renders,
}: {
  completed: boolean;
  onRender: () => void;
  /** Receives every render's status and titles, for transition assertions. */
  renders?: RenderSnapshot[];
}) {
  const { data, status, loading, error } = useQuery(
    (q: QueryRoot<Schema>) => q.todo.query().where("completed", completed),
    [completed],
  );
  const rows = data ?? [];
  renders?.push({ status, titles: rows.map((row) => String(row.title)).join(",") });
  useEffect(() => {
    onRender();
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="unloaded">{String(data === undefined)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error === null ? "" : error.message}</span>
      <span data-testid="ids">{rows.map((row) => row.id).join(",")}</span>
      <span data-testid="titles">{rows.map((row) => String(row.title)).join(",")}</span>
      <span data-testid="completed">{rows.map((row) => String(row.completed)).join(",")}</span>
    </div>
  );
}

describe("useQuery", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it("hands the callback the provider's client as `q`", async () => {
    await seed(client, "todo_1", "Ship it", false);

    const roots: unknown[] = [];
    const queryFns: Array<[unknown, unknown]> = [];

    function Probe() {
      const bound = useClient<Schema>();
      useQuery((q: QueryRoot<Schema>) => {
        roots.push(q);
        queryFns.push([q.todo.query, bound.todo.query]);
        // `q` narrows each namespace to `query()`; writes stay on useClient().
        // @ts-expect-error the q root does not expose mutation verbs.
        void q.todo.update;
        return q.todo.query();
      });
      return null;
    }

    renderWithClient(client, <Probe />);
    await flush();

    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root).toBe(client);
    for (const [fromRoot, fromClient] of queryFns) {
      expect(fromRoot).toBe(fromClient);
      expect(fromRoot).toBe(client.todo.query);
    }
  });

  it("renders the joined rows a `with({ assignee })` selection widens", async () => {
    await seedAssigned(client, "Ada");

    function AssigneeList() {
      const { data, status } = useQuery((q: QueryRoot<Schema>) =>
        q.todo.query().with({ assignee: true }),
      );
      const rows = data ?? [];
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="assignees">
            {rows.map((row) => String(row.assignee?.name ?? "none")).join(",")}
          </span>
        </div>
      );
    }

    renderWithClient(client, <AssigneeList />);
    await flush();

    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("assignees").textContent).toBe("Ada");
  });

  it("types the joined rows from the schema", async () => {
    await seedAssigned(client, "Ada");

    type JoinedIssue = {
      readonly id: string;
      readonly title: string;
      readonly completed: boolean;
      readonly assignee: { readonly id: string; readonly name: string } | null;
    };

    const rendered: (readonly JoinedIssue[] | undefined)[] = [];

    function AssigneeList() {
      // Annotating `q` leaves every type argument to inference, so the join
      // selection narrows `data`.
      const { data } = useQuery((q: QueryRoot<Schema>) => q.todo.query().with({ assignee: true }));
      // Compile-time proof: field and join types flow through `data`...
      const typed: readonly JoinedIssue[] | undefined = data;
      rendered.push(typed);
      // ...and a wrong join shape is rejected.
      // @ts-expect-error the join widens `assignee` to the joined user row, not a name string.
      const wrong: readonly { assignee: string }[] | undefined = data;
      void wrong;
      return <span data-testid="assignee">{data?.[0]?.assignee?.name ?? ""}</span>;
    }

    renderWithClient(client, <AssigneeList />);
    await flush();

    expect(screen.getByTestId("assignee").textContent).toBe("Ada");
    expect(rendered.at(-1)?.[0]?.assignee?.id).toBe("user_1");
  });

  it("reports unloaded while the first run is pending, then the materialized rows", async () => {
    await seed(client, "todo_1", "Ship it", false);

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);

    expect(screen.getByTestId("status").textContent).toBe("unloaded");
    expect(screen.getByTestId("unloaded").textContent).toBe("true");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("titles").textContent).toBe("");

    await flush();

    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("unloaded").textContent).toBe("false");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("ids").textContent).toBe("todo_1");
    expect(screen.getByTestId("titles").textContent).toBe("Ship it");
    expect(screen.getByTestId("completed").textContent).toBe("false");
  });

  it("reads the cached result with status `current` on remount", async () => {
    await seed(client, "todo_active", "Active", false);

    const first = renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("titles").textContent).toBe("Active");
    first.unmount();

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);

    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("unloaded").textContent).toBe("false");
    expect(screen.getByTestId("titles").textContent).toBe("Active");
  });

  it("renders a held result as stale, then current, once it re-runs at the new revision", async () => {
    await seed(client, "todo_1", "Original", false);
    const renders: RenderSnapshot[] = [];

    const first = renderWithClient(
      client,
      <TodoList completed={false} renders={renders} onRender={() => {}} />,
    );
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("current");
    first.unmount();
    renders.length = 0;

    // The replica moves while nothing is subscribed: the cached entry is held
    // at the older revision, so the remount reads usable-but-stale rows.
    await act(async () => {
      await seed(client, "todo_1", "Renamed", false);
    });

    renderWithClient(client, <TodoList completed={false} renders={renders} onRender={() => {}} />);
    await flush();

    // The held rows render once as usable-but-stale, then the synchronous
    // re-run settles them at the replica's revision.
    const staleIndex = renders.findIndex((render) => render.status === "stale");
    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(renders[staleIndex]?.titles).toBe("Original");
    const last = renders.at(-1);
    expect(last?.status).toBe("current");
    expect(last?.titles).toBe("Renamed");
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("titles").textContent).toBe("Renamed");
  });

  it("re-renders when a matching row is created", async () => {
    await seed(client, "todo_1", "First", false);

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();

    await act(async () => {
      await seed(client, "todo_2", "Second", false);
    });

    expect(screen.getByTestId("titles").textContent).toBe("First,Second");
  });

  it("re-renders when a matching row changes a non-filtered field", async () => {
    await seed(client, "todo_1", "Original", false);

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("titles").textContent).toBe("Original");

    // `title` is not part of the filter — a membership-only collection
    // subscribe would not fire here. The projected result must.
    await act(async () => {
      await seed(client, "todo_1", "Renamed", false);
    });

    expect(screen.getByTestId("titles").textContent).toBe("Renamed");
  });

  it("re-renders when a matching row is deleted", async () => {
    await seed(client, "todo_1", "Ship it", false);
    const onRender = vi.fn();

    renderWithClient(client, <TodoList completed={false} onRender={onRender} />);
    await flush();
    expect(screen.getByTestId("titles").textContent).toBe("Ship it");
    const rendersBefore = onRender.mock.calls.length;

    await act(async () => {
      await seedRow(client, { ...mkTodo("todo_1", "Ship it", false), deleted_hlc: "2" }, "delete");
    });

    expect(screen.getByTestId("titles").textContent).toBe("");
    expect(onRender.mock.calls.length).toBeGreaterThan(rendersBefore);
  });

  it("does not re-render on a change that leaves the result set unchanged", async () => {
    await seed(client, "todo_1", "Match", false);
    const onRender = vi.fn();

    renderWithClient(client, <TodoList completed={false} onRender={onRender} />);
    await flush();
    const rendersBefore = onRender.mock.calls.length;

    // A `completed: true` row is outside the `completed: false` filter; a
    // matching row re-materializing with identical fields is also a no-op.
    // Neither may produce a new snapshot.
    await act(async () => {
      await seed(client, "todo_done", "Ignored", true);
      await seed(client, "todo_1", "Match", false);
      await seed(client, "todo_done", "Ignored again", true);
    });

    expect(onRender.mock.calls.length).toBe(rendersBefore);
    expect(screen.getByTestId("titles").textContent).toBe("Match");
  });

  it("releases its engine subscription on unmount", async () => {
    const realWatch = client.queries.watch.bind(client.queries);
    let active = 0;
    vi.spyOn(client.queries, "watch").mockImplementation(((
      ...args: Parameters<typeof realWatch>
    ) => {
      const store = realWatch(...args);
      return {
        getSnapshot: () => store.getSnapshot(),
        subscribe: (listener: () => void, options?: { initial?: boolean }) => {
          active += 1;
          const unsubscribe = store.subscribe(listener, options);
          return () => {
            active -= 1;
            unsubscribe();
          };
        },
      };
    }) as typeof realWatch);

    const { unmount } = renderWithClient(
      client,
      <TodoList completed={false} onRender={() => {}} />,
    );
    await flush();
    expect(active).toBe(1);

    unmount();

    expect(active).toBe(0);
  });

  it("re-subscribes and reflects the new query when deps change", async () => {
    await seed(client, "todo_active", "Active", false);
    await seed(client, "todo_done", "Done", true);

    const { rerender } = renderWithClient(
      client,
      <TodoList completed={false} onRender={() => {}} />,
    );
    await flush();
    expect(screen.getByTestId("titles").textContent).toBe("Active");

    await act(async () => {
      rerender(
        <EbbProvider client={client}>
          <TodoList completed={true} onRender={() => {}} />
        </EbbProvider>,
      );
    });

    expect(screen.getByTestId("titles").textContent).toBe("Done");
    expect(screen.getByTestId("completed").textContent).toBe("true");
  });

  it("surfaces a materialization error and clears it on the next success", async () => {
    await seed(client, "todo_1", "Fine", false);
    const querySpy = vi.spyOn(client.replica, "iterate").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("boom");

    // A later materialization succeeds and clears the error.
    await act(async () => {
      await seed(client, "todo_2", "Recovered", false);
    });
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("titles").textContent).toBe("Fine,Recovered");

    querySpy.mockRestore();
  });
});
