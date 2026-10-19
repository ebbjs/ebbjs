/**
 * Tests for `useQuery` — subscribe a component to a materialized
 * collection query.
 *
 * The hook is backed by `useSyncExternalStore` over the query
 * builder's source-type trigger (`QueryBuilder.subscribe`), not the
 * membership-filtered `EntityNamespace.subscribe`. The distinction is
 * load-bearing: a row that already matches the filter and then
 * changes a non-filtered field (a `title` update on a
 * `completed: false` row) must re-render, and the membership-only
 * listener would stay silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { createClient, defineEntity, defineSchema, e, type NamespacedClient } from "@ebbjs/client";
import { EbbProvider, useClient, useQuery } from "../index";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  entities: { todo },
  version: 1,
});

type Schema = typeof schema;

type Client = NamespacedClient<Schema>;

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor", schema });

type TodoRow = {
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

const mkTodo = (id: string, title: string, completed: boolean): TodoRow => ({
  id,
  type: "todo",
  data: {
    fields: {
      title: { value: title, update_id: `u_${id}`, hlc: "1" },
      completed: { value: completed, update_id: `u_${id}`, hlc: "1" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
});

let seedPosition = 0;

/**
 * Fold a row into the client's replica, then write it to the shim.
 * `useQuery` reads the replica, so a shim-only row is invisible; the
 * fold uses the same Action / Update path the client's writes do.
 */
const seedRow = async (
  client: Client,
  row: ReturnType<typeof mkTodo>,
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

afterEach(cleanup);

function renderWithClient(client: Client, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

/** Renders the queried rows plus `loading` / `error` / commit count. */
function TodoList({ completed, onRender }: { completed: boolean; onRender: () => void }) {
  const client = useClient<Schema>();
  const { data, status, loading, error } = useQuery(
    () => client.todo.query().where("completed", completed),
    [completed],
  );
  const rows = data ?? [];
  useEffect(() => {
    onRender();
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="unloaded">{String(data === undefined)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error === null ? "" : error.message}</span>
      {/* Compile-time proof: the projected field type flows through `data`. */}
      <span data-testid="ids">{rows.map((row) => row.id).join(",")}</span>
      <span data-testid="titles">{rows.map((row) => row.title).join(",")}</span>
      <span data-testid="completed">{rows.map((row) => String(row.completed)).join(",")}</span>
    </div>
  );
}

const flush = () => act(async () => {});

describe("useQuery", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it("starts loading, then exposes the materialized rows", async () => {
    await seed(client, "todo_1", "Ship it", false);

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);

    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("titles").textContent).toBe("");

    await flush();

    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("ids").textContent).toBe("todo_1");
    expect(screen.getByTestId("titles").textContent).toBe("Ship it");
    expect(screen.getByTestId("completed").textContent).toBe("false");
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

    // `title` is not part of the filter — the membership-only collection
    // subscribe would not fire here. The source-type trigger must.
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

    // A `completed: true` row is outside the `completed: false` filter;
    // a matching row re-materializing with identical fields is also a
    // no-op. Neither may produce a new snapshot.
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

  it("does not hand an unloaded query an empty list", async () => {
    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);

    expect(screen.getByTestId("status").textContent).toBe("unloaded");
    expect(screen.getByTestId("unloaded").textContent).toBe("true");
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await flush();
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("unloaded").textContent).toBe("false");
  });

  it("reads the cached result with a status on remount", async () => {
    await seed(client, "todo_active", "Active", false);

    const first = renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("titles").textContent).toBe("Active");
    first.unmount();

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("titles").textContent).toBe("Active");
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

    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("boom");

    // A later materialization succeeds and clears the error.
    await act(async () => {
      await seed(client, "todo_2", "Recovered", false);
    });
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("titles").textContent).toBe("Fine,Recovered");

    querySpy.mockRestore();
  });
});
