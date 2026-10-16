/**
 * Bootstrap: create the typed client, seed the actor's workspace and the
 * shared fixtures, run the handshake, then open the SSE subscription.
 * Returns the client plus its teardown so the caller owns the lifecycle
 * across actor switches.
 *
 * The seed is submitted through `client.seed()` — one Action built from
 * the plain `SeedData` in `./seed`, going through the same write path as
 * any other client write. The shared fixtures are attributed to the
 * `demo-seeder` service actor, so they need their own short-lived client
 * and are not tied to the signed-in actor's lifecycle.
 *
 * The signed-in client persists to IndexedDB (one database per actor) so
 * the Outbox survives a page reload: an unacknowledged write is rehydrated
 * and flushed once the subscription reconnects. Runtimes without
 * IndexedDB fall back to the in-memory adapter.
 */

import { createClient, type NamespacedClient } from "@ebbjs/client";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { schema, type Schema } from "./schema";
import { SEEDER_ACTOR_ID, buildActorSeed, buildSharedSeed } from "./seed";

/** Durable per-actor storage, falling back to memory off the browser. */
async function createAppStorage(actorId: string): Promise<StorageAdapter> {
  if (typeof indexedDB === "undefined") {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    return createMemoryAdapter();
  }
  const { createIndexedDBAdapter } = await import("@ebbjs/storage/indexeddb");
  return createIndexedDBAdapter({ dbName: `ebb-issue-tracker-${actorId}` });
}

export interface BootstrapResult {
  readonly client: NamespacedClient<Schema>;
  readonly groupIds: readonly string[];
  /** The group new issues are filed into (the actor's default workspace). */
  readonly defaultGroupId: string;
  readonly unsubscribe: () => void;
}

export async function bootstrap(opts: {
  serverUrl: string;
  actorId: string;
}): Promise<BootstrapResult> {
  const { serverUrl, actorId } = opts;
  const storage = await createAppStorage(actorId);
  const client = createClient({ serverUrl, actorId, schema, storage });

  await client.seed(buildActorSeed(actorId));

  const seeder = createClient({ serverUrl, actorId: SEEDER_ACTOR_ID, schema });
  try {
    await seeder.seed(buildSharedSeed());
  } finally {
    seeder.close();
  }

  const { groups } = await client.handshake();
  const groupIds = groups.map((group) => group.id);
  const defaultGroupId = groupIds[0];
  if (defaultGroupId === undefined) {
    client.close();
    throw new Error(
      `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
    );
  }

  const unsubscribe = client.subscribe(groupIds, 0, () => undefined);
  return { client, groupIds, defaultGroupId, unsubscribe };
}
