/**
 * Tests for `useEbbStatus` — the aggregate sync state a status bar renders in
 * one subscription: connection, last sync time, outbox, and conflicts.
 *
 * The composition lives on `client.status`, so the hook must see each child's
 * change (`connection`, `outbox`, `conflicts`) through the aggregate alone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, defineModel, defineSchema, e, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useEbbStatus } from "../index";

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

function StatusProbe() {
  const { connection, lastSyncedAt, outbox, conflicts } = useEbbStatus();
  return (
    <div>
      <span data-testid="connection">{connection}</span>
      <span data-testid="last-synced">{lastSyncedAt ?? "never"}</span>
      <span data-testid="pending">{outbox.pending}</span>
      <span data-testid="conflicts">{conflicts.count}</span>
    </div>
  );
}

afterEach(cleanup);

describe("useEbbStatus", () => {
  it("composes connection, outbox, and conflicts and follows each change", async () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <StatusProbe />
      </EbbProvider>,
    );
    expect(screen.getByTestId("connection").textContent).toBe("connecting");
    expect(screen.getByTestId("last-synced").textContent).toBe("never");
    expect(screen.getByTestId("pending").textContent).toBe("0");
    expect(screen.getByTestId("conflicts").textContent).toBe("0");

    act(() => client.setState("live"));
    expect(screen.getByTestId("connection").textContent).toBe("live");

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

    act(() => client.setState("offline"));
    expect(screen.getByTestId("connection").textContent).toBe("offline");
    // The hold moved the write out of `pending`; the conflict stays visible.
    expect(screen.getByTestId("pending").textContent).toBe("0");
    expect(screen.getByTestId("conflicts").textContent).toBe("1");
  });
});
