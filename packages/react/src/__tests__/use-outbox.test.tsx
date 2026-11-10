/**
 * Tests for `useOutbox` — the write-buffer depth and flush latency a
 * local-first editor renders as "Saving…" / "12 writes queued".
 *
 * The source is `client.sync.outbox`, the observer the client composes over
 * the buffer and the flush scheduler; the hook adds nothing but the
 * subscription.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, defineModel, defineSchema, e, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useOutbox } from "../index";

const todo = defineModel("todo", { title: e.string(), completed: e.boolean() });

const schema = defineSchema({ models: { todo }, version: 1 });

type WireAction = Parameters<SyncClient["outbox"]["enqueue"]>[0];

const makeClient = (): SyncClient =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "alice", schema });

/** One local write of `todo_1`, in the shape the outbox buffers. */
const writeTitle = (id: string, value: string, hlc: string): WireAction => ({
  id,
  actor_id: "alice",
  hlc,
  gsn: 0,
  updates: [
    {
      id: `u_${id}`,
      subject_id: "todo_1",
      subject_type: "todo",
      method: "put",
      data: { fields: { title: { value, update_id: `u_${id}`, hlc } } },
    },
  ],
});

const enqueue = (client: SyncClient, action: WireAction) =>
  act(async () => {
    await client.outbox.enqueue(action);
  });

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

afterEach(cleanup);

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

    await enqueue(client, writeTitle("a_1", "mine", "10"));
    expect(screen.getByTestId("depth").textContent).toBe("1/0/0/0");

    await enqueue(client, writeTitle("a_2", "mine too", "11"));
    expect(screen.getByTestId("depth").textContent).toBe("2/0/0/0");
  });
});
