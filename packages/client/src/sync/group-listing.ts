/**
 * Cold bootstrap from the group-scoped entity listing (#476).
 *
 * Delivery is deltas only, so a group's own history does not describe its
 * current state: content written before an entity joined the group never
 * appears in it, and a fresh client would have to drain the history it does
 * have one round trip at a time. `GET /sync/groups/:group_id/entities`
 * returns the group's current row set as pages pinned to one server
 * watermark, and this module turns those pages into a log-backed base.
 *
 * ## The seed
 *
 * One page becomes one batch of synthetic snapshot `put`s, appended in a
 * single action-log write and folded into the live replica by the caller's
 * `onAppended` (the same seam #475's backfill uses). The Action id is
 * derived from `(group, entity)`, so redoing a page merges into the entry
 * already written instead of duplicating it.
 *
 * `cursor(G) = W` then means "G's view is complete as of W": every effect
 * at or below W is in the seeded base (or in the log), and the tail owns
 * everything above it. Before W was pinned the client replayed history from
 * its own cursor, which knew nothing about content that predates membership.
 *
 * ## Crash safety
 *
 * W is pinned by the first page and never recomputed by a redo: re-listing
 * at a newer W would skip a delete that landed in between, resurrecting the
 * row. The order within a page is base first, resume record second, because
 * a crash between them re-delivers (safe) rather than leaving a gap.
 *
 * A marker with no watermark is the one window this ordering cannot name:
 * an attempt may have seeded page 1 at a watermark nobody recorded. Its redo
 * seeds the whole group again but leaves the group's cursor where it was, so
 * the tail still covers the unknown window instead of assuming it is done.
 *
 * ## Listing versions
 *
 * A seed writes the version of the listing shape it filled the base from
 * into the group's resume record, and keeps it when the seed completes. A
 * base seeded before this existed carries no version and counts as version
 * 0.
 *
 * A base at an older version has to be **reset, not re-listed**. The seed is
 * put-only: re-listing at a newer W cannot remove a row the server deleted
 * between the two watermarks, and the cursor would then jump past that
 * delete (#744). Tearing the base down is the caller's job, because only the
 * caller owns the rest of the local state — this module must never overlay a
 * page on a stale base and must never claim one is current.
 *
 * Only a base a seed actually built can be stale. A record that holds a
 * cursor but neither a marker nor the folded position a completed seed
 * writes was filled from the log alone — the log is not the path that
 * omitted rows, so it has nothing to redo.
 *
 * ## Server support
 *
 * A server that does not serve the endpoint (404 / 501) or answers with
 * something that is not the envelope leaves the record untouched and the
 * client on the pre-#476 path: catch up from the local cursor and let #475's
 * content backfill supply what the log cannot.
 */

import type { Action, Entity } from "@ebbjs/core";
import type { CursorRecord, LoggedAction, StorageAdapter } from "@ebbjs/storage/types";

import { snapshotActionWithIds, toRuntimeEntity } from "./backfill";
import type { GroupListingResponse } from "./types";

/**
 * Actor id stamped on a seeded snapshot Action. Like the backfill's, it is
 * not a real actor; the constant keeps a synthesized base from looking like
 * a peer's write.
 */
export const LISTING_SEED_ACTOR_ID = "a_seed_listing";

/**
 * Version of the row shape a listing seed fills a base from. Version 1 ships
 * the live relationship rows of each page's sources (#744); a base below it
 * is missing relationship rows the listing never claimed to carry before.
 *
 * A resume record without a version is version 0, so the first bootstrap
 * after this version ships resets a pre-existing base once and re-seeds it.
 */
export const GROUP_LISTING_VERSION = 1;

/**
 * Whether this record's base was seeded by an older listing version, and so
 * has to be reset rather than re-listed or added to.
 *
 * Either field a seed leaves behind identifies the base as listing-built: the
 * marker of an interrupted attempt (which may already hold rows of the older
 * shape) or the folded position of a completed one. A cursor on its own does
 * not — every base gets one from the tail — and a base the log built never
 * missed a row, so it is not stale however old it is.
 */
export const isStaleListingBase = (record: CursorRecord | null): boolean =>
  (record?.seed !== undefined || record?.through !== undefined) &&
  (record.listingVersion ?? 0) < GROUP_LISTING_VERSION;

/**
 * Whether `groupId` needs a listing seed: nothing has completed a view for
 * it yet, or a seed is in flight. One read of the resume record answers the
 * whole trigger.
 */
export const needsGroupListing = (record: CursorRecord | null): boolean =>
  record?.cursor === undefined || record.seed !== undefined;

/**
 * Deterministic seed Action id for one `(group, entity)` pair. Two groups
 * seed the same entity under different ids: each group's view is completed
 * by its own listing, and neither can stand in for the other.
 */
export const listingSeedActionId = (groupId: string, entityId: string): string =>
  `a_seed_${groupId}_${entityId}`;

/**
 * Deterministic seed Update id. It also carries the row's log position,
 * because a redo reads the row again and may find newer content: an id that
 * ignored the position would make the log's merge drop that change, leaving
 * a stale base below a cursor the tail no longer covers.
 */
export const listingSeedUpdateId = (groupId: string, entity: Entity): string =>
  `u_seed_${groupId}_${entity.id}_${entity.last_gsn}`;

/** The synthetic snapshot `put` a page row becomes. */
export const listingSeedAction = (groupId: string, entity: Entity): Action =>
  snapshotActionWithIds(entity, {
    actionId: listingSeedActionId(groupId, entity.id),
    updateId: listingSeedUpdateId(groupId, entity),
    actorId: LISTING_SEED_ACTOR_ID,
  });

/** One seed attempt's outcome. */
export interface GroupListingResult {
  /** True when this call appended at least one seeded row. */
  readonly seeded: boolean;
  /**
   * The GSN the group's view is complete as of after the call, or `null`
   * when the attempt ended without recording one.
   */
  readonly cursor: number | null;
  /** False when the server does not serve the listing endpoint. */
  readonly supported: boolean;
  /**
   * Highest entity log position this group's seeded base folded, `0` when
   * nothing was seeded. The caller bounds its tail re-delivery guard with it.
   */
  readonly through: number;
}

export interface GroupListingOptions {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly fetchImpl: typeof fetch;
  readonly storage: StorageAdapter;
  /** Rows per page to ask the server for; its default when omitted. */
  readonly pageLimit?: number;
  /**
   * Called with a page's log entries once they are durable, so the caller's
   * live replica folds the seeded base without replaying the log.
   */
  readonly onAppended?: (entries: readonly LoggedAction[]) => void;
  /** Called when a page read fails in a way the caller should see. */
  readonly onError?: (error: unknown, groupId: string) => void;
}

export interface GroupListing {
  /**
   * Bring `groupId`'s view complete, seeding from the listing when it has no
   * cursor or a seed is in flight. Idempotent: a group whose view is already
   * complete is left alone.
   *
   * Precondition: a base at an older listing version (`isStaleListingBase`)
   * must be reset by the caller first. This module cannot do it — a put-only
   * seed over a stale base leaves rows the server has since deleted — so a
   * stale base is left untouched and reported as seeded: false, never
   * overlaid and never claimed current.
   */
  bootstrap(groupId: string): Promise<GroupListingResult>;
}

/** One page read, discriminated so the caller can tell "no such endpoint". */
type PageRead =
  | { readonly kind: "page"; readonly page: GroupListingResponse }
  | { readonly kind: "unsupported" }
  | { readonly kind: "bad-token" };

const isListingEnvelope = (body: unknown): body is GroupListingResponse => {
  if (typeof body !== "object" || body === null) return false;
  const page = body as Record<string, unknown>;
  return (
    typeof page.watermark === "number" &&
    typeof page.has_more === "boolean" &&
    Array.isArray(page.entities) &&
    (page.cursor === null || page.cursor === undefined || typeof page.cursor === "string")
  );
};

/** A row the seed can represent: a `put` cannot carry a tombstone. */
const isLive = (entity: Entity): boolean => entity.deleted_hlc === null;

export const createGroupListing = (opts: GroupListingOptions): GroupListing => {
  const { storage, serverUrl, actorId, fetchImpl } = opts;
  const onError =
    opts.onError ??
    ((error: unknown, groupId: string) => {
      // eslint-disable-next-line no-console
      console.warn("[group-listing] seed failed:", groupId, error);
    });

  const readPage = async (groupId: string, token: string | undefined): Promise<PageRead> => {
    const query = new URLSearchParams();
    if (token !== undefined) query.set("cursor", token);
    if (opts.pageLimit !== undefined) query.set("limit", String(opts.pageLimit));
    const search = query.size === 0 ? "" : `?${query.toString()}`;
    const url = `${serverUrl}/sync/groups/${encodeURIComponent(groupId)}/entities${search}`;

    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "x-ebb-actor-id": actorId },
    });
    // An older server has no such route, and a rolling deployment must
    // degrade to the log path rather than break the connection.
    if (response.status === 404 || response.status === 501) return { kind: "unsupported" };
    if (response.status === 400 && token !== undefined) return { kind: "bad-token" };
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`group listing failed: ${response.status} ${text}`);
    }

    const body = await response.json().catch(() => null);
    // A body that is not the envelope is a server the client cannot seed
    // from; the log path still converges.
    if (!isListingEnvelope(body)) return { kind: "unsupported" };
    return { kind: "page", page: body };
  };

  /**
   * Append one page's synthetic bases and return the highest log position it
   * folded. Positions are the server's own row positions, so the caller can
   * bound the tail guard with them.
   */
  const seedPage = async (groupId: string, page: GroupListingResponse): Promise<number> => {
    const entities = page.entities.map(toRuntimeEntity).filter(isLive);
    if (entities.length === 0) return 0;
    const entries = await storage.actions.appendMany(
      entities.map((entity) => listingSeedAction(groupId, entity)),
    );
    opts.onAppended?.(entries);
    return entities.reduce(
      (max, entity) => Math.max(max, Number.isFinite(entity.last_gsn) ? entity.last_gsn : 0),
      0,
    );
  };

  const seed = async (groupId: string): Promise<GroupListingResult> => {
    const record = await storage.cursors.getRecord(groupId);
    // A base at an older listing version is the caller's to reset: a put-only
    // page cannot remove a row the server deleted since that base was built,
    // so this module must not overlay it and must not claim it is current.
    // Returning it untouched is the honest answer; the caller that skipped
    // the reset sees a base it was told to replace.
    if (isStaleListingBase(record)) {
      return {
        seeded: false,
        cursor: record?.cursor ?? null,
        supported: true,
        through: record?.through ?? 0,
      };
    }
    if (!needsGroupListing(record) && record?.cursor !== undefined) {
      return {
        seeded: false,
        cursor: record.cursor,
        supported: true,
        through: record.through ?? 0,
      };
    }

    const resuming = record?.seed !== undefined;
    const pinned = resuming ? record?.seed?.w : undefined;
    const heldCursor = record?.cursor;
    const heldThrough = record?.through;
    // An earlier attempt may have seeded at a watermark it never recorded.
    // This attempt re-reads the whole group, but it must not claim the view
    // is complete past the cursor it actually knows.
    const unpinnedRedo = resuming && pinned === undefined;
    const restore = record ?? {};

    if (!resuming) {
      // Mark the attempt before its first row lands: a crash then leaves
      // this marker, which is what tells the redo it cannot trust a new W.
      // The version rides with it so a base seeded by an interrupted attempt
      // is not mistaken for one built by an older listing shape.
      await storage.cursors.setRecord(groupId, {
        cursor: heldCursor,
        through: heldThrough,
        listingVersion: GROUP_LISTING_VERSION,
        seed: { group_id: groupId },
      });
    }

    let token = pinned === undefined ? undefined : record?.seed?.token;
    let watermark = pinned;
    let through = 0;
    let seeded = false;
    let retriedToken = false;

    for (;;) {
      const read = await readPage(groupId, token);
      if (read.kind === "unsupported") {
        // Nothing was seeded on the first page, so the attempt leaves no
        // trace: restore the record as it was found.
        if (!seeded) await storage.cursors.setRecord(groupId, restore);
        return {
          seeded,
          cursor: heldCursor ?? null,
          supported: false,
          through: heldThrough ?? 0,
        };
      }
      if (read.kind === "bad-token") {
        if (retriedToken) throw new Error(`group listing rejected its own cursor for ${groupId}`);
        retriedToken = true;
        token = undefined;
        continue;
      }

      const page = read.page;
      if (watermark === undefined) watermark = page.watermark;
      const folded = await seedPage(groupId, page);
      through = Math.max(through, folded);
      seeded = folded > 0 || seeded;
      // Pin W as soon as the first page has landed, and advance the resume
      // token with it, so a crash redoes at this W. A token that does not
      // advance ends the listing instead of re-requesting the same page.
      const next =
        page.has_more && typeof page.cursor === "string" && page.cursor !== token
          ? page.cursor
          : undefined;
      await storage.cursors.setRecord(groupId, {
        cursor: heldCursor,
        through: Math.max(heldThrough ?? 0, through),
        listingVersion: GROUP_LISTING_VERSION,
        seed: { group_id: groupId, w: watermark, token: next },
      });
      if (next === undefined) break;
      token = next;
    }

    const cursor = unpinnedRedo ? (heldCursor ?? 0) : (watermark ?? heldCursor ?? 0);
    const reached = Math.max(heldThrough ?? 0, through);
    // One record write clears the marker and publishes the cursor: the
    // coalesced form of "write the cursor, then drop the marker". The version
    // stays: it is what stops the next bootstrap from resetting this base.
    const completed: { cursor: number; through?: number; listingVersion: number } = {
      cursor,
      listingVersion: GROUP_LISTING_VERSION,
    };
    if (reached > 0) completed.through = reached;
    await storage.cursors.setRecord(groupId, completed);
    return { seeded, cursor, supported: true, through: reached };
  };

  return {
    async bootstrap(groupId: string): Promise<GroupListingResult> {
      try {
        return await seed(groupId);
      } catch (error) {
        onError(error, groupId);
        throw error;
      }
    },
  };
};
