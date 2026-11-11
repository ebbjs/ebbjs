/**
 * Tests for `EbbProvider` and `useClient` — the context every other hook reads
 * its client from. `useConnection` has its own suite next door.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createClient, type SyncClient } from "@ebbjs/client";
import { EbbProvider, useClient } from "../index";

afterEach(cleanup);

function makeClient(): SyncClient {
  return createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor" });
}

function renderWithClient(client: SyncClient, ui: ReactNode) {
  return render(<EbbProvider client={client}>{ui}</EbbProvider>);
}

function ClientProbe() {
  const client = useClient();
  return <span data-testid="actor-id">{client.actorId}</span>;
}

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
