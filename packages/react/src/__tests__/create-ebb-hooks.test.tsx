/**
 * Tests for `createEbbHooks` — `useClient` and `useQuery` bound to one client
 * type, so a component needs no generic and no callback annotation.
 *
 * The binding is the point: React context erases types, and TypeScript does
 * not partially infer type arguments, so `useQuery` cannot take the schema as
 * a type argument without dropping the row types. Binding `q` once is what
 * makes both call sites plain.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, defineEntity, defineSchema, e, type NamespacedClient } from "@ebbjs/client";
import { EbbProvider, createEbbHooks } from "../index";

const todo = defineEntity("todo", { title: e.string(), completed: e.boolean() });

const schema = defineSchema({ entities: { todo }, version: 1 });

type Schema = typeof schema;
type Client = NamespacedClient<Schema>;

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "alice", schema });

/** Bound once, at module scope — the pattern the hook factory documents. */
const { useClient: useEbb, useQuery } = createEbbHooks<Client>();

let seedPosition = 0;

/** Fold a todo into the replica the way a real write does. */
async function seedTodo(client: Client, id: string, title: string): Promise<void> {
  seedPosition += 1;
  const hlc = String(BigInt(seedPosition) << 16n);
  const fields = {
    title: { value: title, update_id: `u_${id}`, hlc },
    completed: { value: false, update_id: `u_${id}`, hlc },
  };
  client.replica.ingest(
    { id: `a_seed_${seedPosition}`, actor_id: "seed", hlc, gsn: seedPosition, updates: [] },
    [
      {
        id: `u_seed_${seedPosition}`,
        subject_id: id,
        subject_type: "todo",
        method: "put",
        data: { fields },
      },
    ],
    seedPosition,
  );
  await client.storage.entities.set({
    id,
    type: "todo",
    data: { fields },
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: seedPosition,
  });
}

const flush = () => act(async () => {});

afterEach(cleanup);

function TodoList() {
  const client = useEbb();
  // No annotation, no type argument: `q` and the row fields are inferred.
  const { data, status } = useQuery((q) => q.todo.query());
  const titles = (data ?? []).map((row) => row.title);
  return (
    <div>
      <span data-testid="actor">{client.actorId}</span>
      <span data-testid="status">{status}</span>
      <span data-testid="titles">{titles.join(",")}</span>
    </div>
  );
}

describe("createEbbHooks", () => {
  it("hands the component the provider's client without a generic", async () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <TodoList />
      </EbbProvider>,
    );
    await flush();
    expect(screen.getByTestId("actor").textContent).toBe("alice");
  });

  it("runs a query whose `q` and rows are typed with no annotation", async () => {
    const client = makeClient();
    await seedTodo(client, "todo_1", "Ship it");

    render(
      <EbbProvider client={client}>
        <TodoList />
      </EbbProvider>,
    );
    await flush();

    expect(screen.getByTestId("titles").textContent).toBe("Ship it");
    expect(screen.getByTestId("status").textContent).toBe("current");
  });

  it("exposes a read-only root, not the client", () => {
    // A compile-time assertion: these lines never run, they only type-check.
    function TypeProbe() {
      useQuery((q) => {
        // @ts-expect-error — a write verb is not on the read root
        void q.todo.update;
        // @ts-expect-error — no such namespace
        void q.bogus;
        return q.todo.query();
      });
      return null;
    }
    expect(TypeProbe).toBeTypeOf("function");
  });
});
