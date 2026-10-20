/**
 * Group synchronization shared by bootstrap and the integration tests:
 * the handshake that lists an actor's groups, the bounded catch-up
 * drain, and the sweep that materializes every group.
 */

import type { SyncClient } from "@ebbjs/client";

/** The client surface a group sync needs. */
export type GroupSyncClient = Pick<SyncClient, "handshake" | "catchUp">;

/** Catch-up passes before a group is declared stuck. */
const CATCH_UP_ATTEMPTS = 50;

/** The group ids the signed-in actor can currently see. */
export async function handshakeGroupIds(client: GroupSyncClient): Promise<readonly string[]> {
  const { groups } = await client.handshake();
  return groups.map((group) => group.id);
}

/** Drive `catchUp` until the server reports `upToDate: true`. */
export async function catchUpGroup(client: GroupSyncClient, groupId: string): Promise<void> {
  for (let attempt = 0; attempt < CATCH_UP_ATTEMPTS; attempt++) {
    const { upToDate } = await client.catchUp(groupId);
    if (upToDate) return;
  }
  throw new Error(
    `catchUpGroup: group ${groupId} did not catch up after ${CATCH_UP_ATTEMPTS} attempts`,
  );
}

/** Handshake and materialize every group the client belongs to. */
export async function syncAllGroups(client: GroupSyncClient): Promise<readonly string[]> {
  const groupIds = await handshakeGroupIds(client);
  for (const groupId of groupIds) {
    await catchUpGroup(client, groupId);
  }
  return groupIds;
}
