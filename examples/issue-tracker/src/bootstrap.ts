/**
 * Bootstrap: create the clients, seed the actor's workspace and the shared
 * fixtures, handshake, then subscribe.
 *
 * `refresh` re-handshakes and re-subscribes, which a membership change needs:
 * the actor's group set moved, so the subscription must span the new workspace
 * before its entities arrive without a reload. The seeder's client stays open
 * for the session because it invites actors into a closed group (#126). The
 * signed-in client persists to IndexedDB (one database per actor) so the Outbox
 * survives a reload, falling back to memory off the browser.
 */

import { createClient } from "@ebbjs/client";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { demoActions } from "./actions";
import { schema } from "./schema";
import { SEEDER_ACTOR_ID, buildActorSeed, buildSharedSeed, deriveActorSeedIds } from "./seed";
import { handshakeGroupIds, syncAllGroups } from "./sync-groups";

/**
 * The demo's client factory: the one place that knows the schema and the action
 * map, and therefore the client type.
 */
export const createIssueTrackerClient = (opts: {
  serverUrl: string;
  actorId: string;
  storage?: StorageAdapter;
}) => createClient({ ...opts, schema, actions: demoActions });

/** The client type, read off the factory's return value rather than restated. */
export type IssueTrackerClient = ReturnType<typeof createIssueTrackerClient>;

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
  /** The group new issues are filed into (the actor's personal workspace). */
  readonly defaultGroupId: string;
  /** Re-handshake and re-subscribe after a membership change. */
  refresh(): Promise<readonly string[]>;
  close(): void;
}

function noGroupsError(actorId: string): Error {
  return new Error(`bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`);
}

export async function bootstrap(opts: {
  serverUrl: string;
  actorId: string;
}): Promise<BootstrapResult> {
  const { serverUrl, actorId } = opts;
  const storage = await createAppStorage(actorId);
  const client = createIssueTrackerClient({ serverUrl, actorId, storage });
  let seeder: IssueTrackerClient | null = null;
  try {
    await client.seed(buildActorSeed(actorId));

    seeder = createIssueTrackerClient({ serverUrl, actorId: SEEDER_ACTOR_ID });
    await seeder.seed(buildSharedSeed());
    await syncAllGroups(seeder);

    let unsubscribe: () => void = () => {};
    const subscribe = async (): Promise<readonly string[]> => {
      const groupIds = await handshakeGroupIds(client);
      if (groupIds.length === 0) {
        throw noGroupsError(actorId);
      }
      unsubscribe();
      unsubscribe = client.subscribe(groupIds, () => undefined);
      return groupIds;
    };

    const groupIds = await subscribe();
    // The personal workspace is the one the seed derives, not whichever
    // group the handshake happens to list first (its order is unspecified).
    const personalGroupId = deriveActorSeedIds(actorId).groupId;
    const defaultGroupId = groupIds.find((id) => id === personalGroupId) ?? groupIds[0];
    if (defaultGroupId === undefined) {
      throw noGroupsError(actorId);
    }
    const service = seeder;
    return {
      client,
      seeder: service,
      defaultGroupId,
      refresh: subscribe,
      close() {
        unsubscribe();
        client.close();
        service.close();
      },
    };
  } catch (err) {
    client.close();
    seeder?.close();
    throw err;
  }
}
