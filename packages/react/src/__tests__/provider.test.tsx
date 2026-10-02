import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createClient, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useClient, useConnection } from "../index";

afterEach(cleanup);

function makeClient(): SyncClient {
  return createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor" });
}

function renderWithClient(client: SyncClient, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

function ConnectionProbe() {
  const state = useConnection();
  return <span data-testid="connection-state">{state}</span>;
}

function ClientProbe() {
  const client = useClient();
  return <span data-testid="actor-id">{client.actorId}</span>;
}

describe("EbbProvider", () => {
  it("renders its children", () => {
    renderWithClient(makeClient(), <span>inside</span>);

    expect(screen.getByText("inside")).toBeDefined();
  });
});

describe("useClient", () => {
  it("returns the client from the nearest provider", () => {
    renderWithClient(makeClient(), <ClientProbe />);

    expect(screen.getByTestId("actor-id").textContent).toBe("test-actor");
  });

  it("throws a clear error outside a provider", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bare = () => {
      useClient();
      return null;
    };

    expect(() => render(<Bare />)).toThrow(/EbbProvider/);
    errorSpy.mockRestore();
  });
});

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
