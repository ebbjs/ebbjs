/**
 * Tests for `EbbProvider` and `useClient` — the context every other hook reads
 * its client from. `useConnection` has its own suite next door.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useClient } from "../index";
import { makeClient, renderWithClient } from "./support";

afterEach(cleanup);

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
