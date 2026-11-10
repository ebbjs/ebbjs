/**
 * Tests for `createEbbHooks`: `useClient`, `useQuery`, and the sync-state
 * hooks bound to one client type, so a component needs no generic and no
 * callback annotation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  createClient,
  defineModel,
  defineSchema,
  e,
  type NamespacedClient,
  type SyncClient,
} from "@ebbjs/client";
/** The `<model>/<field>` component name a write addresses. */
const componentName = (model: string, field: string): `${string}/${string}` => `${model}/${field}`;

import { EbbProvider, createEbbHooks } from "../index";

const todo = defineModel("todo", { title: e.string(), completed: e.boolean() });

const schema = defineSchema({ models: { todo }, version: 1 });

type Schema = typeof schema;
type Client = NamespacedClient<Schema>;

type WireAction = Parameters<SyncClient["outbox"]["enqueue"]>[0];

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "alice", schema });

/** Bound once, at module scope — the pattern the hook factory documents. */
const {
  useClient: useEbb,
  useQuery,
  useOutbox,
  useConflicts,
  useEbbStatus,
} = createEbbHooks<Client>();

/** One `todo_1` title write at an explicit HLC, so LWW is pinnable. */
const writeTitle = (args: {
  id: string;
  actorId: string;
  value: string;
  hlc: string;
  gsn: number;
}): WireAction => ({
  id: args.id,
  actor_id: args.actorId,
  hlc: args.hlc,
  gsn: args.gsn,
  updates: [
    {
      id: `${`u_${args.id}`}_0`,
      subject_id: "todo_1",
      component: "todo/title",
      method: "replace",
      data: { value: args.value, update_id: `u_${args.id}`, hlc: args.hlc },
    },
  ],
});

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
    Object.entries(fields).map(([field, value]) => ({
      id: `u_seed_${seedPosition}_${field}`,
      subject_id: id,
      component: componentName("todo", field),
      method: "replace" as const,
      data: value,
    })),
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

function SyncStateProbe() {
  // No generic, no client: each bound hook reads the provider's client.
  const outbox = useOutbox();
  const conflicts = useConflicts();
  const status = useEbbStatus();
  return (
    <div>
      <span data-testid="pending">{outbox.pending}</span>
      <span data-testid="conflicts">{conflicts.count}</span>
      <span data-testid="connection">{status.connection}</span>
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

  it("binds the sync-state hooks to the same observables", async () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <SyncStateProbe />
      </EbbProvider>,
    );
    expect(screen.getByTestId("pending").textContent).toBe("0");
    expect(screen.getByTestId("conflicts").textContent).toBe("0");
    expect(screen.getByTestId("connection").textContent).toBe("connecting");

    await act(async () => {
      await client.outbox.enqueue(
        writeTitle({ id: "act_local", actorId: "alice", value: "mine", hlc: "10", gsn: 0 }),
      );
    });
    expect(screen.getByTestId("pending").textContent).toBe("1");

    const peer = writeTitle({ id: "act_peer", actorId: "bob", value: "theirs", hlc: "20", gsn: 9 });
    await act(async () => {
      await client.outbox.detectConflicts([peer], "cu_1");
    });
    expect(screen.getByTestId("conflicts").textContent).toBe("1");

    act(() => client.setState("live"));
    expect(screen.getByTestId("connection").textContent).toBe("live");
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
