/**
 * The sync server's routes, as paths.
 *
 * One module names every route the client calls, so a route is a change
 * here rather than a string literal per caller — and a test mock that has
 * to tell two routes apart (the group listing and group catch-up share the
 * `/sync/groups/` prefix) dispatches on the same builders the client does,
 * instead of re-deriving a prefix that silently stops matching.
 *
 * Each builder returns a path beginning with `/`; the caller prefixes
 * `normalizeBaseUrl(serverUrl)`.
 */

/** Path prefix shared by every group-scoped route. */
export const GROUP_ROUTE_PREFIX = "/sync/groups/";

/** Path suffix of the group listing, which shares that prefix with catch-up. */
export const GROUP_LISTING_SUFFIX = "/entities";

/** `POST /sync/handshake` — identity and membership exchange. */
export const handshake = (): string => "/sync/handshake";

/** `GET /sync/groups/:group_id?offset=N` — one page of missed Actions. */
export const catchUp = (groupId: string, offset: number): string =>
  `${GROUP_ROUTE_PREFIX}${encodeURIComponent(groupId)}?offset=${offset}`;

/** `POST /sync/actions` — submit a batch of Actions. */
export const actions = (): string => "/sync/actions";

/**
 * `GET /sync/groups/:group_id/entities` — the group's current row set,
 * paged by an opaque resume token.
 */
export const groupListing = (groupId: string, token?: string, limit?: number): string => {
  const query = new URLSearchParams();
  if (token !== undefined) query.set("cursor", token);
  if (limit !== undefined) query.set("limit", String(limit));
  const search = query.size === 0 ? "" : `?${query.toString()}`;
  return `${GROUP_ROUTE_PREFIX}${encodeURIComponent(groupId)}${GROUP_LISTING_SUFFIX}${search}`;
};

/** `GET /entities/:id` — one materialized entity. */
export const entity = (id: string): string => `/entities/${encodeURIComponent(id)}`;

/** `POST /entities/query` — query entities by model. */
export const entityQuery = (): string => "/entities/query";

/** `POST /functions/:name` — invoke a deployed function. */
export const invokeFunction = (name: string): string => `/functions/${encodeURIComponent(name)}`;

/**
 * `GET /sync/live?groups=…&cursor=…` — the SSE stream.
 *
 * There is deliberately no `actor_id=` query param: identity travels in the
 * header, which a fetch-based stream can set.
 */
export const live = (groups: readonly string[], cursor: number): string => {
  const params = new URLSearchParams({ groups: groups.join(","), cursor: String(cursor) });
  return `/sync/live?${params.toString()}`;
};

/** Whether `url` addresses the group listing rather than group catch-up. */
export const isGroupListingUrl = (url: string): boolean =>
  url.includes(GROUP_ROUTE_PREFIX) && url.includes(GROUP_LISTING_SUFFIX);
