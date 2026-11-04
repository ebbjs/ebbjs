import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchLike } from "./api.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Temp projects live under the package so esbuild resolves `@ebbjs/server`
 * from the package's own node_modules while bundling a test config or entry.
 */
export async function tempProject(prefix = "ebb-cli-"): Promise<string> {
  return mkdtemp(join(testRoot, `.tmp-${prefix}`));
}

export async function removeProject(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export interface RecordingFetch {
  fetchImpl: FetchLike;
  calls: FetchCall[];
}

export function recordingFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): RecordingFetch {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const call = { url, init: init ?? {} };
      calls.push(call);
      return handler(call);
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
