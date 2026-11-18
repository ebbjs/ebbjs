/**
 * Tests for `useConnection` — the client's connection phase, subscribed
 * through `client.onStateChange`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { useConnection } from "../index";
import { makeClient, renderWithClient } from "./support";

afterEach(cleanup);

function ConnectionProbe() {
  const state = useConnection();
  return <span data-testid="connection-state">{state}</span>;
}

describe("useConnection", () => {
  it("reports the client's current state", () => {
    renderWithClient(makeClient(), <ConnectionProbe />);

    expect(screen.getByTestId("connection-state").textContent).toBe("connecting");
  });

  it("re-renders on connect/disconnect transitions", () => {
    const client = makeClient();
    renderWithClient(client, <ConnectionProbe />);

    act(() => client.setState("live"));
    expect(screen.getByTestId("connection-state").textContent).toBe("live");

    act(() => client.setState("reconnecting"));
    expect(screen.getByTestId("connection-state").textContent).toBe("reconnecting");

    act(() => client.setState("offline"));
    expect(screen.getByTestId("connection-state").textContent).toBe("offline");
  });
});
