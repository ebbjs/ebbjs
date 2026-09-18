#!/usr/bin/env node
/**
 * Ebb client smoke test.
 *
 * Boots an ebb server, seeds a group + entity, then exercises the read path
 * of `@ebbjs/client`:
 *
 *   1. handshake()
 *   2. catchUp()
 *   3. subscribe() — fires when another client writes an Action
 *
 * Run with `pnpm --filter ebb-client-smoke start`.
 *
 * ## Prerequisites
 *
 * The ebb server release must be built first:
 *
 *   cd ebb_server && MIX_ENV=prod mix release --overwrite
 *   mkdir -p ../packages/server/dist
 *   cp -r _build/prod/rel/ebb_server ../packages/server/dist/ebb_server
 *
 * Or use `pnpm --filter @ebbjs/server build:local`.
 *
 * The script will print progress to stdout. On success it prints a final
 * "✓ smoke test passed" and exits with 0; on failure it prints a stack and
 * exits non-zero.
 */

import { seed, startServer } from "@ebbjs/server";
import { createClient } from "@ebbjs/client";
import { createAction, createClock } from "@ebbjs/core";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { buildSmokeSeed, SMOKE_ACTOR_ID, SMOKE_GROUP_ID, SMOKE_ENTITY_ID } from "./seed";

const DATA_DIR = process.env.EBB_CLIENT_SMOKE_DATA_DIR ?? "/tmp/ebb-smoke-data";
// The ebb_server release ignores EBB_PORT (config-driven) and always binds
// 4000 in prod. The harness accepts a port parameter but it's a no-op.
// See ebb_server/lib/ebb_server/application.ex.
const PORT = Number(process.env.EBB_CLIENT_SMOKE_PORT ?? 4000);
const SERVER_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/server/dist/ebb_server/bin/ebb_server",
);

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log("[smoke]", ...args);
};

async function main(): Promise<void> {
  log(`data dir: ${DATA_DIR}, port: ${PORT}`);

  if (!existsSync(SERVER_BIN)) {
    log(`error: ebb_server release not found at ${SERVER_BIN}`);
    log("build it first:");
    log("  cd ebb_server && MIX_ENV=prod mix release --overwrite");
    log("  mkdir -p ../packages/server/dist");
    log("  cp -r _build/prod/rel/ebb_server ../packages/server/dist/ebb_server");
    log("or run: pnpm --filter @ebbjs/server build:local");
    process.exit(1);
  }

  // 1. Boot the server.
  log("starting ebb_server...");
  const server = await startServer({ dataDir: DATA_DIR, port: PORT });
  log(`server ready at ${server.url}`);

  try {
    // 2. Seed a group + member + entity.
    log("seeding smoke data...");
    await seed(server.url, SMOKE_ACTOR_ID, buildSmokeSeed());
    log("seed complete");

    // 3. Create the client under test.
    const client = createClient({
      serverUrl: server.url,
      actorId: SMOKE_ACTOR_ID,
    });

    // 4. Handshake.
    log("handshaking...");
    const handshake = await client.handshake();
    const group = handshake.groups.find((g) => g.id === SMOKE_GROUP_ID);
    if (!group) {
      throw new Error(
        `expected group ${SMOKE_GROUP_ID} in handshake; got ${JSON.stringify(handshake.groups)}`,
      );
    }
    log(`handshake OK; actorId=${handshake.actorId}, groups=${handshake.groups.length}`);

    // 5. Catch-up.
    log("catching up...");
    const catchResult = await client.catchUp(SMOKE_GROUP_ID, 0);
    log(`caught up ${catchResult.actions.length} action(s); upToDate=${catchResult.upToDate}`);
    if (catchResult.actions.length === 0) {
      throw new Error("expected at least one action in catch-up");
    }

    // 6. Read the materialized entity from storage.
    const entity = await client.readLocalEntity(SMOKE_ENTITY_ID);
    if (!entity) {
      throw new Error(`entity ${SMOKE_ENTITY_ID} not materialized after catch-up`);
    }
    log(`materialized entity: id=${entity.id}, type=${entity.type}`);
    const titleField = (entity.data.fields as Record<string, { value?: unknown }>).title;
    if (!titleField || titleField.value !== "Hello, ebb") {
      throw new Error(`expected entity title "Hello, ebb"; got ${JSON.stringify(titleField)}`);
    }
    log("entity materialization OK");

    // 7. Open a subscription that fires on incoming data events.
    log("opening SSE subscription...");
    const events: string[] = [];
    let resolveLiveEvent!: () => void;
    const liveEvent = new Promise<void>((resolve) => {
      resolveLiveEvent = resolve;
    });

    const unsubscribe = client.subscribe([SMOKE_GROUP_ID], 0, (ev) => {
      events.push(ev.type);
      if (ev.type === "data") {
        log(`received SSE event: action id=${ev.action.id}`);
        resolveLiveEvent();
      }
    });

    // 8. Wait until the SSE stream is live before writing.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (client.state === "live") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    log("subscription is live");

    // 9. Send a new Action from a separate client (simulating another actor).
    log("writing a follow-up action from another actor...");
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
          data: {
            title: {
              value: "Updated via SSE",
              update_id: "upd_followup",
              hlc: clock.l ? `${clock.l.toString()}:0` : "0",
            },
          },
        },
      ],
    });
    const writeResult = await client.write([action]);
    if (writeResult.rejected.length > 0) {
      throw new Error(`write rejected: ${JSON.stringify(writeResult.rejected)}`);
    }
    log("write OK");

    // 10. Wait for the SSE-driven materialization.
    await Promise.race([
      liveEvent,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("timeout waiting for SSE event")), 10_000),
      ),
    ]);
    log("SSE event received");

    // 11. Verify the entity was updated via the SSE path.
    // Poll briefly to allow the materialization to settle.
    let updated: typeof entity | null = null;
    for (let i = 0; i < 50; i++) {
      const e = await client.readLocalEntity(SMOKE_ENTITY_ID);
      if (
        e &&
        (e.data.fields as Record<string, { value?: unknown }>).title?.value === "Updated via SSE"
      ) {
        updated = e;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!updated) {
      throw new Error("entity not updated via SSE within timeout");
    }
    log("entity updated via SSE");

    unsubscribe();
    log("events received:", events);

    // 12. Done.
    log("✓ smoke test passed");
  } finally {
    log("shutting down server...");
    await server.kill();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
