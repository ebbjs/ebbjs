/**
 * Wire `client.subscribe` action receipt into the storage adapter.
 *
 * The existing {@link import("@ebbjs/storage").StorageAdapter} already calls
 * `dirtyTracker.mark(...)` for every `Update` inside `actions.append(...)`,
 * so materialization works without any changes to the storage layer. This
 * module is a thin adapter that converts SSE action events into storage
 * appends and bumps the per-group cursor in `cursors`.
 */

import type { Action } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage";

/**
 * Apply a received Action to local storage.
 *
 * - Appends the action to the action log (which marks affected entities dirty)
 * - Advances the per-group cursor if a group id and a GSN are provided
 *
 * Returns the affected entity IDs so callers (e.g., the SSE loop) can fan
 * out notifications if they need to.
 */
export async function applyAction(
  storage: StorageAdapter,
  action: Action,
  groupId?: string,
): Promise<{ entityId: string; entityType: string }[]> {
  await storage.actions.append(action);
  const affected = action.updates.map((u) => ({
    entityId: u.subject_id,
    entityType: u.subject_type,
  }));
  if (groupId !== undefined && action.gsn > 0) {
    const prev = await storage.cursors.get(groupId);
    if (prev === null || action.gsn > prev) {
      await storage.cursors.set(groupId, action.gsn);
    }
  }
  return affected;
}
