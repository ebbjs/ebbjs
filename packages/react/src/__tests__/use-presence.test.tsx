/**
 * Tests for `usePresence` — the peers observed on one presence channel of one
 * entity, subscribed through the client's presence store.
 *
 * The receive half is driven by folding `presence` packets into the client's
 * runtime, the same shape `handleSSEEvent` folds in from the live stream, so
 * the assertions read what a component sees for a peer that arrives, moves,
 * ages out, or is dropped with the stream.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { Type } from "@sinclair/typebox";
import {
  createClient,
  defineEntity,
  definePresence,
  defineSchema,
  e,
  type NamespacedClient,
  type SyncClient,
} from "@ebbjs/client";

import { EbbProvider, createEbbHooks, usePresence } from "../index";

const todo = defineEntity("todo", { title: e.string() });
const schema = defineSchema({ entities: { todo }, version: 1 });

const cameraSchema = Type.Object({ x: Type.Number(), y: Type.Number(), zoom: Type.Number() });
const cursorSchema = Type.Object({ anchorId: Type.String(), anchorOffset: Type.Number() });

const presence = definePresence({
  camera: cameraSchema,
  cursor: cursorSchema,
  // Expires quickly so the store's sweep is observable with real timers.
  blink: { schema: Type.Object({ n: Type.Number() }), ttlMs: 200 },
});

type PresenceClient = NamespacedClient<
  typeof schema,
  Record<string, never>,
  Record<string, never>,
  typeof presence
>;

const makeClient = (): PresenceClient =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "alice", schema, presence });

/** The client's private receive runtime; the live stream is the only public way in. */
interface PresenceRuntimeSeam {
  ingest(payload: unknown): void;
  reset(): void;
}

const runtimeOf = (client: PresenceClient): PresenceRuntimeSeam =>
  (client as unknown as { presenceRuntime: PresenceRuntimeSeam }).presenceRuntime;

/** A `presence` packet, shaped the way the server broadcasts it. */
const packet = (actorId: string, entityId: string, channel: string, value: unknown) => ({
  actor_id: actorId,
  entity_id: entityId,
  data: { channel, value },
});

/** Bound once, at module scope — the pattern the hook factory documents. */
const { usePresence: useBoundPresence } = createEbbHooks<PresenceClient>();

afterEach(cleanup);

function Cameras({ planId }: { planId: string }) {
  const peers = useBoundPresence(planId, "camera");
  return (
    <ul data-testid="cameras">
      {[...peers].map(([actorId, peer]) => (
        <li key={actorId}>{`${actorId}:${peer.data.x},${peer.data.y},${peer.data.zoom}`}</li>
      ))}
    </ul>
  );
}

function CursorCount({ onRender }: { onRender: () => void }) {
  onRender();
  const peers = useBoundPresence("plan_1", "cursor");
  return <span data-testid="cursor-count">{peers.size}</span>;
}

function Blinkers() {
  const peers = useBoundPresence("plan_1", "blink");
  return <span data-testid="blinkers">{peers.size}</span>;
}

function CameraActors({ entityId }: { entityId: string }) {
  const peers = useBoundPresence(entityId, "camera");
  return <span data-testid="camera-actors">{[...peers.keys()].join(",")}</span>;
}

describe("usePresence", () => {
  it("renders the peers on one channel, typed from the declared schema", () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <Cameras planId="plan_1" />
      </EbbProvider>,
    );
    expect(screen.getByTestId("cameras").textContent).toBe("");

    act(() =>
      runtimeOf(client).ingest(packet("a_bob", "plan_1", "camera", { x: 1, y: 2, zoom: 3 })),
    );
    expect(screen.getByTestId("cameras").textContent).toBe("a_bob:1,2,3");

    act(() =>
      runtimeOf(client).ingest(packet("a_bob", "plan_1", "camera", { x: 4, y: 5, zoom: 6 })),
    );
    expect(screen.getByTestId("cameras").textContent).toBe("a_bob:4,5,6");

    act(() => runtimeOf(client).ingest(packet("a_bob", "plan_1", "camera", null)));
    expect(screen.getByTestId("cameras").textContent).toBe("");
  });

  it("does not re-render for another entity or another channel", () => {
    const client = makeClient();
    let renders = 0;
    render(
      <EbbProvider client={client}>
        <CursorCount onRender={() => renders++} />
      </EbbProvider>,
    );
    const initial = renders;

    act(() =>
      runtimeOf(client).ingest(packet("a_bob", "plan_1", "camera", { x: 1, y: 2, zoom: 3 })),
    );
    act(() =>
      runtimeOf(client).ingest(
        packet("a_bob", "plan_2", "cursor", { anchorId: "r_1", anchorOffset: 0 }),
      ),
    );
    expect(renders).toBe(initial);
    expect(screen.getByTestId("cursor-count").textContent).toBe("0");

    act(() =>
      runtimeOf(client).ingest(
        packet("a_bob", "plan_1", "cursor", { anchorId: "r_1", anchorOffset: 0 }),
      ),
    );
    expect(renders).toBeGreaterThan(initial);
    expect(screen.getByTestId("cursor-count").textContent).toBe("1");
  });

  it("drops a peer when its channel's TTL elapses", async () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <Blinkers />
      </EbbProvider>,
    );

    act(() => runtimeOf(client).ingest(packet("a_bob", "plan_1", "blink", { n: 1 })));
    expect(screen.getByTestId("blinkers").textContent).toBe("1");

    await waitFor(() => expect(screen.getByTestId("blinkers").textContent).toBe("0"));
  });

  it("switches targets and resubscribes when the entity prop changes", () => {
    const client = makeClient();
    const { rerender } = render(
      <EbbProvider client={client}>
        <CameraActors entityId="plan_1" />
      </EbbProvider>,
    );

    act(() =>
      runtimeOf(client).ingest(packet("a_bob", "plan_1", "camera", { x: 1, y: 2, zoom: 3 })),
    );
    act(() =>
      runtimeOf(client).ingest(packet("a_carol", "plan_2", "camera", { x: 4, y: 5, zoom: 6 })),
    );
    expect(screen.getByTestId("camera-actors").textContent).toBe("a_bob");

    rerender(
      <EbbProvider client={client}>
        <CameraActors entityId="plan_2" />
      </EbbProvider>,
    );
    expect(screen.getByTestId("camera-actors").textContent).toBe("a_carol");

    // The new target's subscription is live, and the old one is gone.
    act(() =>
      runtimeOf(client).ingest(packet("a_dave", "plan_2", "camera", { x: 7, y: 8, zoom: 9 })),
    );
    act(() =>
      runtimeOf(client).ingest(packet("a_erin", "plan_1", "camera", { x: 0, y: 0, zoom: 1 })),
    );
    expect(screen.getByTestId("camera-actors").textContent).toBe("a_carol,a_dave");
  });

  it("drops every peer when the live stream resets", () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <Blinkers />
      </EbbProvider>,
    );

    act(() => runtimeOf(client).ingest(packet("a_bob", "plan_1", "blink", { n: 1 })));
    expect(screen.getByTestId("blinkers").textContent).toBe("1");

    act(() => runtimeOf(client).reset());
    expect(screen.getByTestId("blinkers").textContent).toBe("0");
  });

  it("keeps the snapshot referentially stable while the peers are unchanged", () => {
    const client = makeClient();

    // `getSnapshot` must not mint a map per call: a new reference on an
    // unrelated re-render is what makes `useSyncExternalStore` loop.
    function BumpableSnapshot() {
      const [, setBump] = useState(0);
      const peers = useBoundPresence("plan_1", "camera");
      const previous = useRef(peers);
      const stable = previous.current === peers;
      previous.current = peers;
      return (
        <button
          data-testid="bump"
          data-stable={String(stable)}
          onClick={() => setBump((n) => n + 1)}
        />
      );
    }

    render(
      <EbbProvider client={client}>
        <BumpableSnapshot />
      </EbbProvider>,
    );
    act(() => screen.getByTestId("bump").click());
    expect(screen.getByTestId("bump").dataset["stable"]).toBe("true");
  });

  it("types the channel and payload from the client's registry", () => {
    // A compile-time assertion: these lines never run, they only type-check.
    function TypeProbe() {
      const cameras = useBoundPresence("plan_1", "camera");
      const zoom: number | undefined = [...cameras.values()][0]?.data.zoom;

      // @ts-expect-error — `bogus` is not a declared channel
      useBoundPresence("plan_1", "bogus");

      // @ts-expect-error — a camera peer carries the camera schema, not the cursor's
      void [...cameras.values()][0]?.data.anchorId;

      const raw = usePresence<{ anchorId: string }>("plan_1", "cursor");
      const anchorId: string | undefined = [...raw.values()][0]?.data.anchorId;

      return [zoom, anchorId] as const;
    }
    expect(TypeProbe).toBeTypeOf("function");
  });

  it("accepts a typed-presence client wherever a SyncClient is expected", () => {
    const client = makeClient();
    // The assignability the client's unified presence surface exists for: a
    // registered client is a plain client, so the provider keeps one constraint.
    const plain: SyncClient = client;
    // @ts-expect-error — the class's private fields make a lookalike not a client
    const lookalike: SyncClient = { actorId: "alice" };

    expect(plain).toBe(client);
    expect(lookalike).toBeDefined();
  });

  it("leaves an unregistered client's channels dynamic", () => {
    // A compile-time assertion: these lines never run, they only type-check.
    const plain = createEbbHooks<NamespacedClient<typeof schema>>();
    function TypeProbe() {
      const peers = plain.usePresence("plan_1", "anything");
      const data: unknown = [...peers.values()][0]?.data;
      return data;
    }
    expect(TypeProbe).toBeTypeOf("function");
  });
});
