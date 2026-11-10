/**
 * Tests for `useConflicts` — the count and the conflicts awaiting an
 * application decision.
 *
 * Detection arrives on the outbox's change stream, so the consumer re-renders
 * from the held-outbox state alone. `client.conflicts.list()` is the async
 * read path, and a subscription must never need it: the spy below fails the
 * test if the hook refetches.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, defineModel, defineSchema, e, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useConflicts } from "../index";

const todo = defineModel("todo", { title: e.string(), completed: e.boolean() });

const schema = defineSchema({ models: { todo }, version: 1 });

type WireAction = Parameters<SyncClient["outbox"]["enqueue"]>[0];

const makeClient = (): SyncClient =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "alice", schema });

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

function ConflictProbe() {
  const { count } = useConflicts();
  return <span data-testid="count">{count}</span>;
}

afterEach(cleanup);

describe("useConflicts", () => {
  it("re-renders on a conflict hold without calling list() or rehydrate()", async () => {
    const client = makeClient();
    const listSpy = vi.spyOn(client.conflicts, "list");
    const rehydrateSpy = vi.spyOn(client.conflicts, "rehydrate");
    render(
      <EbbProvider client={client}>
        <ConflictProbe />
      </EbbProvider>,
    );
    expect(screen.getByTestId("count").textContent).toBe("0");

    await act(async () => {
      await client.outbox.enqueue(
        writeTitle({ id: "act_local", actorId: "alice", value: "mine", hlc: "10", gsn: 0 }),
      );
    });
    expect(screen.getByTestId("count").textContent).toBe("0");

    const peer = writeTitle({ id: "act_peer", actorId: "bob", value: "theirs", hlc: "20", gsn: 9 });
    await act(async () => {
      await client.outbox.detectConflicts([peer], "cu_1");
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(listSpy).not.toHaveBeenCalled();
    expect(rehydrateSpy).not.toHaveBeenCalled();
  });
});
