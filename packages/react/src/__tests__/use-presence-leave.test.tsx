/**
 * Tests for leaving presence on `pagehide` — the provider's wiring and the
 * explicit `usePresenceLeave()`.
 *
 * A leave is a `POST /sync/presence` with a `null` value marked `keepalive`,
 * so the assertions read the requests a server would see: when the page is
 * only hidden, when it is gone, and when it was never really there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { Type } from "@sinclair/typebox";
import { createClient, definePresence } from "@ebbjs/client";
import type { SyncClient } from "@ebbjs/client";

import { EbbProvider, usePresenceLeave } from "../index";

const presence = definePresence({
  camera: Type.Object({ x: Type.Number(), y: Type.Number(), zoom: Type.Number() }),
  cursor: Type.Object({ anchorId: Type.String(), anchorOffset: Type.Number() }),
});

const cursor = { anchorId: "r_1", anchorOffset: 0 };

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function harness() {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    /** The presence writes the client issued, in order. */
    presenceCalls: () => calls.filter((call) => call.url.includes("/sync/presence")),
  };
}

const makeClient = (fetchImpl: typeof fetch, actorId = "alice") =>
  createClient({ serverUrl: "http://localhost:4000", actorId, fetchImpl, presence });

/** The private receive seam the live stream feeds; tests fold packets in here. */
interface PresenceRuntimeSeam {
  ingest(payload: unknown): void;
}

const runtimeOf = (client: SyncClient): PresenceRuntimeSeam =>
  (client as unknown as { presenceRuntime: PresenceRuntimeSeam }).presenceRuntime;

const bodyOf = (call: RecordedCall): unknown => JSON.parse(String(call.init.body));

const pageHide = (persisted = false): void =>
  act(() => {
    const event = new Event("pagehide") as PageTransitionEvent;
    // happy-dom's PageTransitionEvent drops `persisted`, and that flag is the
    // difference between a page that is gone and one that may come back.
    Object.defineProperty(event, "persisted", { value: persisted });
    window.dispatchEvent(event);
  });

/** Let any fire-and-forget leave settle before asserting it did not happen. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

afterEach(cleanup);

function Leaving() {
  usePresenceLeave();
  return null;
}

describe("leaving presence on pagehide", () => {
  it("leaves every claimed target when the page hides, and nothing before", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <span>inside</span>
      </EbbProvider>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    expect(h.presenceCalls()).toHaveLength(1);

    pageHide();

    // The handler must issue the POST synchronously: the document can be torn
    // down before any promise resumes.
    expect(h.presenceCalls()).toHaveLength(2);
    await waitFor(() => expect(h.presenceCalls()).toHaveLength(2));
    const leave = h.presenceCalls()[1]!;
    expect(leave.init.keepalive).toBe(true);
    expect(bodyOf(leave)).toEqual({
      entity_id: "plan_1",
      data: { channel: "cursor", value: null },
    });
    client.close();
  });

  it("stops listening once the provider unmounts", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    const { unmount } = render(
      <EbbProvider client={client}>
        <span>inside</span>
      </EbbProvider>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    const before = h.presenceCalls().length;

    unmount();
    pageHide();
    await settle();

    expect(h.presenceCalls()).toHaveLength(before);
    client.close();
  });

  it("removes the actor from a peer as soon as the page hides", async () => {
    const h = harness();
    const drew = makeClient(h.fetchImpl, "drew");
    const alice = makeClient(h.fetchImpl, "alice");
    render(
      <EbbProvider client={drew}>
        <span>inside</span>
      </EbbProvider>,
    );

    drew.presence.set("plan_1", "cursor", cursor);
    await drew.presence.flush();

    // What the server broadcasts to a subscriber: the sender's body plus the
    // actor id it authenticated.
    const present = bodyOf(h.presenceCalls()[0]!) as { entity_id: string; data: unknown };
    runtimeOf(alice).ingest({ actor_id: "drew", ...present });
    expect(alice.presence.forEntity("plan_1", "cursor").size).toBe(1);

    pageHide();
    const leave = bodyOf(h.presenceCalls()[1]!) as { entity_id: string; data: unknown };
    runtimeOf(alice).ingest({ actor_id: "drew", ...leave });

    // No TTL and no debounce: the leave's null is what drops the peer.
    expect(alice.presence.forEntity("plan_1", "cursor").size).toBe(0);
    drew.close();
    alice.close();
  });

  it("does not leave when the page enters the back/forward cache", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <span>inside</span>
      </EbbProvider>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    const before = h.presenceCalls().length;

    // The document may be restored, and nothing re-announces presence on
    // `pageshow`, so retracting now would show a false absence on Back.
    pageHide(true);
    await settle();

    expect(h.presenceCalls()).toHaveLength(before);
    client.close();
  });

  it("leaves only once when the page hides twice", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <span>inside</span>
      </EbbProvider>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    const before = h.presenceCalls().length;

    pageHide();
    await waitFor(() => expect(h.presenceCalls()).toHaveLength(before + 1));
    pageHide();
    await settle();

    expect(h.presenceCalls()).toHaveLength(before + 1);
    client.close();
  });

  it("installs one listener through a StrictMode double mount", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <StrictMode>
        <EbbProvider client={client}>
          <span>inside</span>
        </EbbProvider>
      </StrictMode>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    const before = h.presenceCalls().length;

    pageHide();
    await waitFor(() => expect(h.presenceCalls()).toHaveLength(before + 1));
    await settle();

    expect(h.presenceCalls()).toHaveLength(before + 1);
    client.close();
  });

  it("behaves the same when a component calls usePresenceLeave() itself", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <Leaving />
      </EbbProvider>,
    );

    client.presence.set("plan_1", "camera", { x: 1, y: 2, zoom: 3 });
    await client.presence.flush();
    const before = h.presenceCalls().length;

    pageHide();
    await waitFor(() => expect(h.presenceCalls()).toHaveLength(before + 1));

    const leave = h.presenceCalls()[before]!;
    expect(leave.init.keepalive).toBe(true);
    expect(bodyOf(leave)).toEqual({
      entity_id: "plan_1",
      data: { channel: "camera", value: null },
    });
    client.close();
  });

  it("writes nothing when the page hides with no claimed targets", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <Leaving />
      </EbbProvider>,
    );

    pageHide();
    await settle();

    expect(h.presenceCalls()).toHaveLength(0);
    client.close();
  });

  it("treats a hidden tab as no leave: the peer ages out on the TTL instead", async () => {
    const h = harness();
    const client = makeClient(h.fetchImpl);
    render(
      <EbbProvider client={client}>
        <span>inside</span>
      </EbbProvider>,
    );

    client.presence.set("plan_1", "cursor", cursor);
    await client.presence.flush();
    const before = h.presenceCalls().length;

    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();

    expect(h.presenceCalls()).toHaveLength(before);
    client.close();
  });
});
