// @vitest-environment happy-dom

/**
 * Onboarding through `App`: the header is the observable — a server-derived
 * (tailscale) identity shows `signed in as …` and no actor picker, while a
 * bypass deployment keeps the picker it has always had. The heavy panels are
 * stubbed because this test is about the identity branch, not the data layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const bootstrapMock = vi.hoisted(() => vi.fn());

vi.mock("../bootstrap", () => ({ bootstrap: bootstrapMock }));
vi.mock("../ConnectionBadge", () => ({ ConnectionBadge: () => null }));
vi.mock("../IssuesPanel", () => ({ IssuesPanel: () => null }));
vi.mock("../MembershipPanel", () => ({ MembershipPanel: () => null }));
vi.mock("../ProfileCard", () => ({ ProfileCard: () => null }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));

import { App } from "../App";
import type { IdentityCache } from "../identity";

const SERVER_URL = "http://localhost:4000";

const memoryCache = (entries: Record<string, string> = {}): IdentityCache => ({
  getItem: (key) => entries[key] ?? null,
  setItem: (key, value) => {
    entries[key] = value;
  },
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fakeBootstrap = () => ({
  client: {},
  seeder: {},
  defaultGroupId: "grp_demo",
  refresh: async () => [],
  close: () => undefined,
});

afterEach(() => {
  cleanup();
  bootstrapMock.mockReset();
  window.history.replaceState({}, "", "/");
});

describe("App onboarding", () => {
  it("uses a tailscale actor and hides the picker", async () => {
    bootstrapMock.mockResolvedValue(fakeBootstrap());

    render(
      <App
        serverUrl={SERVER_URL}
        identityCache={null}
        fetchImpl={async () =>
          json({
            actor_id: "alice@example.com",
            provider: "tailscale",
            display_name: "Alice",
          })
        }
      />,
    );

    await waitFor(() => expect(screen.getByText(/signed in as Alice/)).toBeTruthy());
    expect(screen.queryByText("actor:")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(bootstrapMock).toHaveBeenCalledWith({
      serverUrl: SERVER_URL,
      actorId: "alice@example.com",
    });
  });

  it("keeps the bypass picker and the ?actor= pick when the identity read is rejected", async () => {
    bootstrapMock.mockResolvedValue(fakeBootstrap());
    window.history.replaceState({}, "", "/?actor=bob");

    render(
      <App
        serverUrl={SERVER_URL}
        identityCache={null}
        fetchImpl={async () => new Response("", { status: 401 })}
      />,
    );

    await waitFor(() => expect(screen.getByText("actor:")).toBeTruthy());
    expect(screen.queryByText(/signed in as/)).toBeNull();
    expect(bootstrapMock).toHaveBeenCalledWith({ serverUrl: SERVER_URL, actorId: "bob" });
  });

  it("starts from the cached tailscale actor when offline", async () => {
    bootstrapMock.mockResolvedValue(fakeBootstrap());
    const cache = memoryCache({
      [`ebb-issue-tracker:identity:${SERVER_URL}`]: JSON.stringify({
        actorId: "bob@example.com",
        provider: "tailscale",
        displayName: "Bob",
      }),
    });

    render(
      <App
        serverUrl={SERVER_URL}
        identityCache={cache}
        fetchImpl={async () => {
          throw new TypeError("fetch failed");
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText(/signed in as Bob/)).toBeTruthy());
    expect(bootstrapMock).toHaveBeenCalledWith({
      serverUrl: SERVER_URL,
      actorId: "bob@example.com",
    });
  });
});
