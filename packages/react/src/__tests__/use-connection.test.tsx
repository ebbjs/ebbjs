/**
 * Tests for `useConnection` — the client's connection phase, subscribed
 * through `client.onStateChange`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createClient, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useConnection } from "../index";

afterEach(cleanup);

function makeClient(): SyncClient {
  return createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor" });
}

function ConnectionProbe() {
  const state = useConnection();
  return <span data-testid="connection-state">{state}</span>;
}

describe("useConnection", () => {
  it("reports the client's current state", () => {
    render(
      <EbbProvider client={makeClient()}>
        <ConnectionProbe />
      </EbbProvider>,
    );

    expect(screen.getByTestId("connection-state").textContent).toBe("connecting");
  });

  it("re-renders on connect/disconnect transitions", () => {
    const client = makeClient();
    render(
      <EbbProvider client={client}>
        <ConnectionProbe />
      </EbbProvider>,
    );

    act(() => client.setState("live"));
    expect(screen.getByTestId("connection-state").textContent).toBe("live");

    act(() => client.setState("reconnecting"));
    expect(screen.getByTestId("connection-state").textContent).toBe("reconnecting");

    act(() => client.setState("offline"));
    expect(screen.getByTestId("connection-state").textContent).toBe("offline");
  });
});
