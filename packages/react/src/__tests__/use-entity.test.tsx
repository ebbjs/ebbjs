/**
 * Tests for `useEntity` — subscribe a component to a single entity row.
 *
 * The hook owns an `EntityRow.subscribe` from `client.<entity>.get(id)`.
 * On a live change it re-runs `get` so relationship accessors survive
 * (a merged snapshot would clobber an accessor that shares a name with a
 * field), and it treats a `deleted_hlc` snapshot as `null`.
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
} from "@ebbjs/client";
import { EbbProvider, useClient, useEntity } from "../index";

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

const mkTodo = (
  id: string,
  title: string,
  completed: boolean,
  deletedHlc: string | null = null,
) => ({
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
  deleted_hlc: deletedHlc,
  last_gsn: 1,
});

type RawTodo = ReturnType<typeof mkTodo>;

const seed = (client: Client, entity: RawTodo) => client.storage.entities.set(entity);

afterEach(cleanup);

function renderWithClient(client: Client, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

/** Renders the row's presence, title, and the built-in `groups` accessor. */
function TodoProbe({ id, onRender }: { id: string; onRender: () => void }) {
  const client = useClient<Schema>();
  const row = useEntity(() => client.todo.get(id), [id]);
  useEffect(() => {
    onRender();
  });
  return (
    <div>
      <span data-testid="present">{String(row !== null)}</span>
      {/* Compile-time proof: the projected field type flows through. */}
      <span data-testid="title">{row?.title ?? ""}</span>
      <span data-testid="accessor">{String(typeof row?.groups)}</span>
    </div>
  );
}

const flush = () => act(async () => {});

describe("useEntity", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it("starts absent, then exposes the loaded row", async () => {
    await seed(client, mkTodo("todo_1", "Ship it", false));

    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    expect(screen.getByTestId("present").textContent).toBe("false");

    await flush();

    expect(screen.getByTestId("present").textContent).toBe("true");
    expect(screen.getByTestId("title").textContent).toBe("Ship it");
  });

  it("stays null when get resolves null", async () => {
    renderWithClient(client, <TodoProbe id="missing" onRender={() => {}} />);
    await flush();

    expect(screen.getByTestId("present").textContent).toBe("false");
    expect(screen.getByTestId("title").textContent).toBe("");
  });

  it("re-renders when the row changes", async () => {
    await seed(client, mkTodo("todo_1", "Original", false));

    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("title").textContent).toBe("Original");

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Renamed", true));
    });

    expect(screen.getByTestId("title").textContent).toBe("Renamed");
  });

  it("returns null after a soft delete, then the row again after a resurrect", async () => {
    await seed(client, mkTodo("todo_1", "Ship it", false));

    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("present").textContent).toBe("true");

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Ship it", false, "2"));
    });
    expect(screen.getByTestId("present").textContent).toBe("false");
    expect(screen.getByTestId("title").textContent).toBe("");

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Back", false));
    });
    expect(screen.getByTestId("present").textContent).toBe("true");
    expect(screen.getByTestId("title").textContent).toBe("Back");
  });

  it("does not re-render when a materialization leaves the projection unchanged", async () => {
    await seed(client, mkTodo("todo_1", "Same", false));
    const onRender = vi.fn();

    renderWithClient(client, <TodoProbe id="todo_1" onRender={onRender} />);
    await flush();
    // The first identical emit still lands (no prior snapshot to compare),
    // so capture the baseline after it settles.
    await act(async () => {
      await seed(client, mkTodo("todo_1", "Same", false));
    });
    const rendersBefore = onRender.mock.calls.length;

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Same", false));
    });

    expect(onRender.mock.calls.length).toBe(rendersBefore);
  });

  it("keeps the relationship accessor across a change", async () => {
    await seed(client, mkTodo("todo_1", "Original", false));

    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("accessor").textContent).toBe("object");

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Changed", false));
    });

    expect(screen.getByTestId("accessor").textContent).toBe("object");
  });

  it("reads a row deleted before mount as its tombstone", async () => {
    // Documented limit: `get` returns tombstones for inspection, so a
    // delete that happened before mount is indistinguishable from a live
    // row here. Closing it needs a client-side liveness signal.
    await seed(client, mkTodo("todo_1", "Gone", false, "2"));

    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();

    expect(screen.getByTestId("present").textContent).toBe("true");
    expect(screen.getByTestId("title").textContent).toBe("Gone");
  });

  it("does not observe a row created after an absent read", async () => {
    // Documented limit: `EntityRow.subscribe` only exists once a row does,
    // so an absent read has nothing to attach to.
    renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("present").textContent).toBe("false");

    await act(async () => {
      await seed(client, mkTodo("todo_1", "Appeared", false));
    });

    expect(screen.getByTestId("present").textContent).toBe("false");
  });

  it("loads the new row when deps change", async () => {
    await seed(client, mkTodo("todo_a", "A", false));
    await seed(client, mkTodo("todo_b", "B", false));

    const { rerender } = renderWithClient(client, <TodoProbe id="todo_a" onRender={() => {}} />);
    await flush();
    expect(screen.getByTestId("title").textContent).toBe("A");

    await act(async () => {
      rerender(
        <EbbProvider client={client}>
          <TodoProbe id="todo_b" onRender={() => {}} />
        </EbbProvider>,
      );
    });

    expect(screen.getByTestId("title").textContent).toBe("B");
  });

  it("unsubscribes from the emitter on unmount", async () => {
    const emitter = client.storage.changeEmitter;
    if (emitter === undefined) throw new Error("memory adapter must ship a change emitter");
    const realOnEntityChange = emitter.onEntityChange.bind(emitter);
    let unsubscribeCalls = 0;
    vi.spyOn(emitter, "onEntityChange").mockImplementation((id, listener) => {
      const unsubscribe = realOnEntityChange(id, listener);
      return () => {
        unsubscribeCalls += 1;
        unsubscribe();
      };
    });
    await seed(client, mkTodo("todo_1", "Ship it", false));

    const { unmount } = renderWithClient(client, <TodoProbe id="todo_1" onRender={() => {}} />);
    await flush();

    unmount();

    expect(unsubscribeCalls).toBeGreaterThanOrEqual(1);
  });
});

/**
 * An accessor and a same-named field collide on a row: `get` spreads the
 * accessor last, so the accessor wins at runtime. Re-loading on change is
 * what keeps that precedence — merging the snapshot's fields would clobber
 * `owner` with the raw field value.
 */
const ownerTodo = defineEntity("todo", {
  title: e.string(),
  owner: e.string().nullable(),
});
const user = defineEntity("user", { name: e.string() });

const collisionSchema = defineSchema({
  entities: { todo: ownerTodo, user },
  relationships: {
    todo_owner: defineRelationship({ source: ownerTodo, target: user, as: "owner" }),
  },
  version: 1,
});

type RawEntity = Parameters<ReturnType<typeof createClient>["storage"]["entities"]["set"]>[0];

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): RawEntity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value, update_id: "u", hlc: "1" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
});

describe("useEntity — accessor/field collision", () => {
  it("keeps the accessor when an entity field shares its name", async () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "test-actor",
      schema: collisionSchema,
    });
    await client.storage.entities.set(mkEntity("todo_1", "todo", { title: "A", owner: "user_1" }));
    await client.storage.entities.set(mkEntity("user_1", "user", { name: "Ada" }));
    await client.storage.entities.set(
      mkEntity("rel_1", "relationship", {
        source_id: "todo_1",
        target_id: "user_1",
        type: "todo",
        field: "owner",
      }),
    );

    const kinds: string[] = [];
    const OwnerProbe = () => {
      const bound = useClient<typeof collisionSchema>();
      const row = useEntity(() => bound.todo.get("todo_1"), []);
      kinds.push(row === null ? "none" : typeof row.owner);
      return null;
    };

    render(
      <EbbProvider client={client}>
        <OwnerProbe />
      </EbbProvider>,
    );
    await flush();
    // A forward-one accessor is a Promise; the raw field value is a string.
    expect(kinds.at(-1)).toBe("object");

    await act(async () => {
      await client.storage.entities.set(
        mkEntity("todo_1", "todo", { title: "B", owner: "user_1" }),
      );
    });

    expect(kinds.at(-1)).toBe("object");
  });
});
