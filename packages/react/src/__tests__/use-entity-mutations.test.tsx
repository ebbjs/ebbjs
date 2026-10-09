/**
 * Tests for `useEntityMutations` — referentially stable write
 * pass-throughs for one entity namespace.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createClient,
  defineEntity,
  defineSchema,
  e,
  type EntityFields,
  type NamespacedClient,
} from "@ebbjs/client";
import {
  EbbProvider,
  useClient,
  useEntityMutations,
  type UseEntityMutationsResult,
} from "../index";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({
  entities: { todo },
  version: 1,
});

type Schema = typeof schema;
type TodoFields = EntityFields<typeof todo>;
type Client = NamespacedClient<Schema>;
type Mutations = UseEntityMutationsResult<TodoFields>;

afterEach(cleanup);

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor", schema });

describe("useEntityMutations", () => {
  it("forwards create, update, and delete to the namespace", async () => {
    const client = makeClient();
    const createSpy = vi
      .spyOn(client.todo, "create")
      .mockResolvedValue({ id: "todo_1", rejected: [] });
    const updateSpy = vi.spyOn(client.todo, "update").mockResolvedValue({ rejected: [] });
    const deleteSpy = vi.spyOn(client.todo, "delete").mockResolvedValue({ rejected: [] });

    let mutations: Mutations | null = null;
    const Probe = () => {
      const bound = useClient<Schema>();
      mutations = useEntityMutations(bound.todo);
      return null;
    };
    render(
      <EbbProvider client={client}>
        <Probe />
      </EbbProvider>,
    );
    if (mutations === null) throw new Error("expected mutations");
    // The probe assigns during render; TS can't see through the render call.
    const bound = mutations as Mutations;

    await bound.create({ title: "Ship it", completed: false }, { groups: ["grp_1"] });
    await bound.update("todo_1", { completed: true });
    await bound.delete("todo_1");

    expect(createSpy).toHaveBeenCalledWith(
      { title: "Ship it", completed: false },
      { groups: ["grp_1"] },
    );
    expect(updateSpy).toHaveBeenCalledWith("todo_1", { completed: true });
    expect(deleteSpy).toHaveBeenCalledWith("todo_1");
  });

  it("returns referentially stable functions across re-renders", () => {
    const client = makeClient();
    const seen: Mutations[] = [];
    const Probe = ({ tick }: { tick: number }) => {
      const bound = useClient<Schema>();
      seen.push(useEntityMutations(bound.todo));
      return <span data-testid="tick">{tick}</span>;
    };

    const { rerender } = render(
      <EbbProvider client={client}>
        <Probe tick={0} />
      </EbbProvider>,
    );
    rerender(
      <EbbProvider client={client}>
        <Probe tick={1} />
      </EbbProvider>,
    );
    rerender(
      <EbbProvider client={client}>
        <Probe tick={2} />
      </EbbProvider>,
    );

    expect(screen.getByTestId("tick").textContent).toBe("2");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    const first = seen[0];
    const last = seen[seen.length - 1];
    if (first === undefined || last === undefined) throw new Error("expected renders");
    expect(last.create).toBe(first.create);
    expect(last.update).toBe(first.update);
    expect(last.delete).toBe(first.delete);
  });
});
