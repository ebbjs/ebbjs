/**
 * CursorStore — per-group GSN cursor tracking for sync resumption.
 *
 * Stores the highest observed GSN per group, allowing the client to
 * resume sync from the correct checkpoint after disconnection.
 *
 * ## Methods
 * - `get(groupId)` — returns the cursor (GSN) for a group, or null if none
 * - `set(groupId, cursor)` — updates the cursor for a group
 */
export interface CursorStore {
  get(groupId: string): Promise<number | null>;
  set(groupId: string, cursor: number): Promise<void>;
}
