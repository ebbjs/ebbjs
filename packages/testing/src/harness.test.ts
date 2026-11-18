/**
 * Unit tests for the readiness probe. They stub `fetch`, so no release and no
 * port are involved: the subject is which route and status the harness waits
 * for, and how long it waits.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_READY_CHECK, DEFAULT_READY_TIMEOUT_MS, waitForReady } from "./harness";

const status = (code: number): Response => new Response(null, { status: code });

/** A `fetch` that answers with `codes` in order, repeating the last one. */
const fetchAnswering = (codes: readonly number[]): { urls: string[] } => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return status(codes[Math.min(urls.length - 1, codes.length - 1)] ?? 500);
  });
  return { urls };
};

describe("waitForReady", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls the default route until it answers with a 404", async () => {
    const { urls } = fetchAnswering([200, 500, DEFAULT_READY_CHECK.expectedStatus]);

    await waitForReady("http://localhost:1", 5_000);

    expect(urls).toHaveLength(3);
    expect(urls.every((url) => url === `http://localhost:1${DEFAULT_READY_CHECK.path}`)).toBe(true);
  });

  it("honours a caller's own readyCheck", async () => {
    const { urls } = fetchAnswering([404, 503, 200]);

    await waitForReady("http://localhost:1", 5_000, { path: "/health", expectedStatus: 200 });

    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe("http://localhost:1/health");
  });

  it("gives up once the timeout passes, naming the budget it waited", async () => {
    const { urls } = fetchAnswering([500]);

    await expect(waitForReady("http://localhost:1", 400)).rejects.toThrow(/within 400ms/);
    expect(urls.length).toBeGreaterThan(1);
  });

  it("gives a starting release two minutes by default", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_READY_CHECK.expectedStatus).toBe(404);
  });
});
