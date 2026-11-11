/**
 * Tests for the three read-only sync-state hooks: `useOutbox`,
 * `useConflicts`, and `useEbbStatus`.
 *
 * They share one shape — `useSyncObservable` over an observable the client
 * composes and republishes — so they share a client and a write fixture here
 * rather than three copies of each.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, defineModel, defineSchema, e, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useConflicts, useEbbStatus, useOutbox } from "../index";

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

const enqueue = (client: SyncClient, action: WireAction) =>
  act(async () => {
    await client.outbox.enqueue(action);
  });

const hold = (client: SyncClient) =>
  act(async () => {
    await client.outbox.detectConflicts(
      [
        writeTitle({
          id: "act_peer",
          actorId: "bob",
          value: "theirs",
          hlc: "20",
          gsn: 9,
        }),
      ],
      "cu_1",
    );
  });

afterEach(cleanup);

function OutboxProbe() {
  const { pending, acknowledged, error, conflicted, flushLatency } = useOutbox();
  const depth = `${pending}/${acknowledged}/${error}/${conflicted}`;
  return (
    <div>
      <span data-testid="depth">{depth}</span>
      <span data-testid="latency">{flushLatency ?? "none"}</span>
    </div>
  );
}

function ConflictProbe() {
  const { count } = useConflicts();
  return <span data-testid="count">{count}</span>;
}

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

describe("useOutbox", () => {
  it("renders the outbox depth and re-renders when the buffer changes", async () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <OutboxProbe />
      </EbbProvider>,
    );
    expect(screen.getByTestId("depth").textContent).toBe("0/0/0/0");
    expect(screen.getByTestId("latency").textContent).toBe("none");

    await enqueue(
      client,
      writeTitle({ id: "a_1", actorId: "alice", value: "mine", hlc: "10", gsn: 0 }),
    );
    expect(screen.getByTestId("depth").textContent).toBe("1/0/0/0");

    await enqueue(
      client,
      writeTitle({ id: "a_2", actorId: "alice", value: "mine too", hlc: "11", gsn: 0 }),
    );
    expect(screen.getByTestId("depth").textContent).toBe("2/0/0/0");
  });
});

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

    await enqueue(
      client,
      writeTitle({ id: "act_local", actorId: "alice", value: "mine", hlc: "10", gsn: 0 }),
    );
    expect(screen.getByTestId("count").textContent).toBe("0");

    await hold(client);

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(listSpy).not.toHaveBeenCalled();
    expect(rehydrateSpy).not.toHaveBeenCalled();
  });
});

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

    await enqueue(
      client,
      writeTitle({ id: "act_local", actorId: "alice", value: "mine", hlc: "10", gsn: 0 }),
    );
    expect(screen.getByTestId("pending").textContent).toBe("1");

    await hold(client);
    expect(screen.getByTestId("conflicts").textContent).toBe("1");

    act(() => client.setState("offline"));
    expect(screen.getByTestId("connection").textContent).toBe("offline");
    // The hold moved the write out of `pending`; the conflict stays visible.
    expect(screen.getByTestId("pending").textContent).toBe("0");
    expect(screen.getByTestId("conflicts").textContent).toBe("1");
  });
});
