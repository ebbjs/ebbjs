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

const mkTodo = (id: string, title: string, completed: boolean) => ({
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

const seed = (client: Client, id: string, title: string, completed: boolean) =>
  client.storage.entities.set(mkTodo(id, title, completed));

afterEach(cleanup);

function renderWithClient(client: Client, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

/** Renders the queried rows plus `loading` / `error` / commit count. */
function TodoList({ completed, onRender }: { completed: boolean; onRender: () => void }) {
  const client = useClient<Schema>();
  const { data, loading, error } = useQuery(
    () => client.todo.query().where("completed", completed),
    [completed],
  );
  useEffect(() => {
    onRender();
  });
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error === null ? "" : error.message}</span>
      {/* Compile-time proof: the projected field type flows through `data`. */}
      <span data-testid="titles">{data.map((row) => row.title).join(",")}</span>
      <span data-testid="completed">{data.map((row) => String(row.completed)).join(",")}</span>
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
      await client.storage.entities.set({
        ...mkTodo("todo_1", "Ship it", false),
        deleted_hlc: "2",
      });
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

  it("unsubscribes from the emitter on unmount", async () => {
    const emitter = client.storage.changeEmitter;
    if (emitter === undefined) throw new Error("memory adapter must ship a change emitter");
    const realOnTypeChange = emitter.onTypeChange.bind(emitter);
    let unsubscribeCalls = 0;
    vi.spyOn(emitter, "onTypeChange").mockImplementation((type, listener) => {
      const unsubscribe = realOnTypeChange(type, listener);
      return () => {
        unsubscribeCalls += 1;
        unsubscribe();
      };
    });

    const { unmount } = renderWithClient(
      client,
      <TodoList completed={false} onRender={() => {}} />,
    );
    await flush();

    unmount();

    expect(unsubscribeCalls).toBeGreaterThanOrEqual(1);
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
    const querySpy = vi
      .spyOn(client.storage.entities, "query")
      .mockRejectedValueOnce(new Error("boom"));

    renderWithClient(client, <TodoList completed={false} onRender={() => {}} />);
    await flush();

    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("boom");

    // A later materialization succeeds and clears the error.
    await act(async () => {
      await client.storage.entities.set(mkTodo("todo_2", "Recovered", false));
    });
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("titles").textContent).toBe("Fine,Recovered");

    querySpy.mockRestore();
  });
});
