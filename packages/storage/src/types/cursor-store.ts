/**
 * CursorStore — per-group sync resume state for the client.
 *
 * One record per group holds the cursor its view is complete as of, and,
 * while a group listing seed is in flight, the marker that pins the seed's
 * watermark so a crash redoes the same listing instead of a newer one
 * (#476). Cursor and marker live in one record because they are one resume
 * concept: the bootstrap trigger is a single read.
 *
 * ## Methods
 * - `get(groupId)` — the group's cursor (GSN), or null if none
 * - `set(groupId, cursor)` — writes the cursor, keeping any seed marker
 * - `getRecord(groupId)` — the whole resume record (`{cursor?, seed?}`)
 * - `setRecord(groupId, record)` — replaces the record; omitting `seed`
 *   clears the marker, which is how the final seed page commits, and
 *   `through` records how far the seed's base folded
 * - `records()` — every group's record, for the handshake's cursor map
 * - `clear()` — drops every group's resume state (a full local sync reset)
 */

/**
 * A listing seed in flight: the watermark the redo must reuse and the
 * server page token to resume from.
 *
 * `w` is absent while page 1's seed has not committed — the attempt then
 * holds no rows that a newer watermark could skip past, so the redo lists
 * from page 1 afresh (see `bootstrapGroupListing`). `token` is absent when
 * `w` is, and otherwise names the page after the last one already seeded.
 */
export interface SeedMarker {
  /** The group being seeded. Guards a record against reuse across groups. */
  readonly group_id: string;
  /** Pinned listing watermark; absent while page 1's seed is uncommitted. */
  readonly w?: number;
  /** Opaque server page token for the next page to list. */
  readonly token?: string;
}

/** One group's durable resume state. */
export interface CursorRecord {
  /** Highest GSN the group's view is complete as of. Absent before any seed or catch-up. */
  readonly cursor?: number;
  /** Present while a listing seed is in flight. */
  readonly seed?: SeedMarker;
  /**
   * Highest entity log position the group's seeded base folded. A row's
   * `last_gsn` at or below it is the server's own state, so a re-delivered
   * `put` / `delete` inside that window is already reflected and must not be
   * folded again (#476). Absent until a listing seed completes; it outlives
   * the marker because the tail re-delivers after the seed finishes.
   */
  readonly through?: number;
}

export interface CursorStore {
  get(groupId: string): Promise<number | null>;
  set(groupId: string, cursor: number): Promise<void>;
  getRecord(groupId: string): Promise<CursorRecord | null>;
  setRecord(groupId: string, record: CursorRecord): Promise<void>;
  records(): Promise<ReadonlyMap<string, CursorRecord>>;
  clear(): Promise<void>;
}
