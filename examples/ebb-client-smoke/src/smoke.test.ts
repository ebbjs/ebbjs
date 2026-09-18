/**
 * Vitest version of the smoke test.
 *
 * Runs the same flow as `index.ts` but inside vitest so it can be wired into
 * CI. Requires a pre-built `ebb_server` release at
 * `packages/server/dist/ebb_server/bin/ebb_server` (run
 * `pnpm --filter @ebbjs/server build:local` first).
 *
 * Each test starts its own ephemeral server on a random port to keep
 * parallel runs from clobbering each other.
 *
 * ## Skipping
 *
 * Set `EBB_SKIP_SMOKE=1` to skip this test (useful when the server release
 * isn't available — e.g., in CI before the release step).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@ebbjs/client";
import { createAction, createClock } from "@ebbjs/core";
import { buildSmokeSeed, SMOKE_ACTOR_ID, SMOKE_GROUP_ID, SMOKE_ENTITY_ID } from "./seed";

// Lazy-import `@ebbjs/server` so the module is only loaded when the test
// actually runs (avoids vite failing to resolve the package when the
// server dist isn't built).
type ServerModule = typeof import("@ebbjs/server");
type ServerRuntime = {
  seed: ServerModule["seed"];
  startServer: ServerModule["startServer"];
};

let serverModule: ServerRuntime | null = null;

async function loadServerModule(): Promise<ServerRuntime> {
  if (serverModule) return serverModule;
  // Construct the module specifier at runtime so vite's import-analysis
  // can't see it at scan time.
  const specifier = ["@ebbjs", "server"].join("/");
  const mod = (await import(/* @vite-ignore */ specifier)) as ServerModule;
  serverModule = { seed: mod.seed, startServer: mod.startServer };
  return serverModule;
}

const DATA_DIR = process.env.EBB_CLIENT_SMOKE_DATA_DIR ?? `/tmp/ebb-smoke-data-${process.pid}`;
// The ebb_server release ignores EBB_PORT (config-driven) and always binds
// 4000 in prod. See ebb_server/lib/ebb_server/application.ex.
const PORT = Number(process.env.EBB_CLIENT_SMOKE_PORT ?? 4000);
const SERVER_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/server/dist/ebb_server/bin/ebb_server",
);

const skip = process.env.EBB_SKIP_SMOKE === "1" || !existsSync(SERVER_BIN);

let server: { url: string; kill: () => Promise<void> } | null = null;

beforeAll(async () => {
  if (skip) return;
  const { seed, startServer } = await loadServerModule();
  server = await startServer({ dataDir: DATA_DIR, port: PORT });
  await seed(server.url, SMOKE_ACTOR_ID, buildSmokeSeed());
}, 120_000);

afterAll(async () => {
  if (server) await server.kill();
});

const maybeDescribe = skip ? describe.skip : describe;

maybeDescribe("ebb client smoke (against running server)", () => {
  it("handshake returns group membership", async () => {
    const client = createClient({ serverUrl: server.url, actorId: SMOKE_ACTOR_ID });
    const result = await client.handshake();
    expect(result.actorId).toBe(SMOKE_ACTOR_ID);
    const group = result.groups.find((g) => g.id === SMOKE_GROUP_ID);
    expect(group).toBeDefined();
    client.close();
  });

  it("catchUp materializes the seeded entity", async () => {
    const client = createClient({ serverUrl: server.url, actorId: SMOKE_ACTOR_ID });
    const result = await client.catchUp(SMOKE_GROUP_ID, 0);
    expect(result.actions.length).toBeGreaterThan(0);
    const entity = await client.readLocalEntity(SMOKE_ENTITY_ID);
    expect(entity).not.toBeNull();
    expect(entity!.id).toBe(SMOKE_ENTITY_ID);
    const titleField = (entity!.data.fields as Record<string, { value?: unknown }>).title;
    expect(titleField?.value).toBe("Hello, ebb");
    client.close();
  });

  it("subscribe delivers an incoming action via SSE", async () => {
    const client = createClient({ serverUrl: server.url, actorId: SMOKE_ACTOR_ID });
    let resolve!: () => void;
    const received = new Promise<void>((r) => {
      resolve = r;
    });
    const unsubscribe = client.subscribe([SMOKE_GROUP_ID], 0, (ev) => {
      if (ev.type === "data") {
        resolve();
      }
    });

    // Wait for the SSE stream to be live before writing.
    await new Promise<void>((r) => {
      const tick = (): void => {
        if (client.state === "live") r();
        else setTimeout(tick, 10);
      };
      tick();
    });

    const otherActor = "actor_smoke_other";
    const clock = createClock();
    const { action } = createAction({
      actorId: otherActor,
      clock,
      updates: [
        {
          id: "upd_followup",
          subject_id: SMOKE_ENTITY_ID,
          subject_type: "todo",
          method: "patch",
          // User-entity updates must nest fields under `data.fields`
          // (mirrors ActionValidator.well_formed_data?/1 in ebb_server and
          // extractPatchFields in @ebbjs/storage). Without the wrapper, the
          // patch silently no-ops in the client materializer.
          data: {
            fields: {
              title: {
                value: "Updated via SSE",
                update_id: "upd_followup",
                hlc: clock.l ? `${clock.l.toString()}:0` : "0",
              },
            },
          },
        },
      ],
    });
    const writeResult = await client.write([action]);
    expect(writeResult.rejected).toEqual([]);

    await Promise.race([
      received,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("timeout waiting for SSE event")), 10_000),
      ),
    ]);

    // Allow the storage append + materialize to settle.
    let updated = false;
    for (let i = 0; i < 50; i++) {
      const e = await client.readLocalEntity(SMOKE_ENTITY_ID);
      if (
        e &&
        (e.data.fields as Record<string, { value?: unknown }>).title?.value === "Updated via SSE"
      ) {
        updated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(updated).toBe(true);

    unsubscribe();
  });
});
