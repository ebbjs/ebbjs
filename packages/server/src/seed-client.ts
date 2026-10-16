/**
 * `@ebbjs/server`'s raw-POST seed harness.
 *
 * The fixture builder and rejection policy are the browser-safe
 * `@ebbjs/core/seed` module; this file adds the HTTP submission the
 * server test harness needs and re-exports the core seed names so
 * `@ebbjs/server`'s public surface is unchanged.
 */

import { encodeSync } from "@ebbjs/core";
import {
  assertSeedAccepted,
  buildSeedAction,
  type Action,
  type SeedData,
  type SeedRejection,
} from "@ebbjs/core/seed";

/**
 * `POST /sync/actions` with a pre-built Action, used by {@link seed}.
 */
async function postSeedAction(serverUrl: string, actorId: string, action: Action): Promise<void> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${baseUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": actorId,
    },
    body: body as BodyInit,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Seed failed: ${res.status} ${text}`);
  }

  let parsed: { rejected?: SeedRejection[] } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // A tolerant server may answer with an empty body on success.
  }
  assertSeedAccepted(parsed.rejected ?? []);
}

/** Build and submit a seed Action in one call. */
export async function seed(serverUrl: string, actorId: string, data: SeedData): Promise<void> {
  await postSeedAction(serverUrl, actorId, buildSeedAction(actorId, data));
}

export {
  buildSeedAction,
  assertSeedAccepted,
  isToleratedSeedRejection,
  SeedRejectedError,
  TOLERATED_SEED_REJECTIONS,
} from "@ebbjs/core/seed";

export type {
  Action,
  GroupSeed,
  GroupMemberSeed,
  EntitySeed,
  RelationshipSeed,
  EntityGroupSeed,
  SeedData,
  SeedRejection,
} from "@ebbjs/core/seed";
