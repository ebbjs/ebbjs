/**
 * Bootstrap: create the typed client, seed the actor's workspace and the
 * shared fixtures, run the handshake, then open the SSE subscription.
 *
 * Returns the actor's client, the shared workspace's service client, and
 * a `refresh` that re-handshakes and re-subscribes. A membership change
 * needs the refresh: the actor's group set has changed, so the
 * subscription must span the new workspace before its entities arrive
 * without a reload.
 *
 * The seed is submitted through `client.seed()` — one Action built from
 * the plain `SeedData` in `./seed`, going through the same write path as
 * any other client write. The shared fixtures are attributed to the
 * `demo-seeder` service actor, whose client stays open for the session so
 * it can invite actors into the shared workspace (groups are closed by
 * default, #126).
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
import { workspaceActions } from "./workspace";

/** The typed client the demo passes around: schema-bound with the workspace Actions. */
export type IssueTrackerClient = NamespacedClient<Schema, typeof workspaceActions>;

/**
 * Durable per-actor storage, falling back to memory off the browser.
 * Exported so the persistence test can reopen the same database.
 */
export async function createAppStorage(actorId: string): Promise<StorageAdapter> {
  if (typeof indexedDB === "undefined") {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    return createMemoryAdapter();
  }
  const { createIndexedDBAdapter } = await import("@ebbjs/storage/indexeddb");
  return createIndexedDBAdapter({ dbName: `ebb-issue-tracker-${actorId}` });
}

export interface BootstrapResult {
  readonly client: IssueTrackerClient;
  /** The shared workspace's service actor; used to invite members. */
  readonly seeder: IssueTrackerClient;
  readonly groupIds: readonly string[];
  /** The group new issues are filed into (the actor's default workspace). */
  readonly defaultGroupId: string;
  /** Re-handshake and re-subscribe after a membership change. */
  refresh(): Promise<readonly string[]>;
  close(): void;
}

/** Handshake and materialize every group the client belongs to. */
async function drain(client: IssueTrackerClient): Promise<readonly string[]> {
  const { groups } = await client.handshake();
  for (const group of groups) {
    for (let i = 0; i < 50; i++) {
      const { upToDate } = await client.catchUp(group.id);
      if (upToDate) break;
    }
  }
  return groups.map((group) => group.id);
}

export async function bootstrap(opts: {
  serverUrl: string;
  actorId: string;
}): Promise<BootstrapResult> {
  const { serverUrl, actorId } = opts;
  const storage = await createAppStorage(actorId);
  const client = createClient({ serverUrl, actorId, schema, storage, actions: workspaceActions });

  await client.seed(buildActorSeed(actorId));

  const seeder = createClient({
    serverUrl,
    actorId: SEEDER_ACTOR_ID,
    schema,
    actions: workspaceActions,
  });
  await seeder.seed(buildSharedSeed());
  await drain(seeder);

  let unsubscribe: () => void = () => {};
  const subscribe = async (): Promise<readonly string[]> => {
    const { groups } = await client.handshake();
    const groupIds = groups.map((group) => group.id);
    if (groupIds.length === 0) {
      throw new Error(
        `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
      );
    }
    unsubscribe();
    unsubscribe = client.subscribe(groupIds, 0, () => undefined);
    return groupIds;
  };

  const groupIds = await subscribe();
  const defaultGroupId = groupIds[0];
  if (defaultGroupId === undefined) {
    throw new Error(`bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`);
  }
  return {
    client,
    seeder,
    groupIds,
    defaultGroupId,
    refresh: subscribe,
    close() {
      unsubscribe();
      client.close();
      seeder.close();
    },
  };
}
