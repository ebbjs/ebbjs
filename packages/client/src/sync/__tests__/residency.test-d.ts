/**
 * One inactive lifetime (#941): checked by `tsc --noEmit`.
 *
 * `residencyTtlMs` is the only option that decides how long an unwatched read
 * stays warm, and the query cache takes no lifetime option of its own.
 */

import { describe, it } from "vitest";

import { createReplica } from "@ebbjs/storage/replica";

import { createClient } from "../client";
import { createQueryCache } from "../query-cache";

const replica = createReplica();

describe("one inactive lifetime", () => {
  it("rejects a second query TTL on the client options", () => {
    // @ts-expect-error — `residencyTtlMs` owns the lifetime; `queryTtlMs` is gone.
    createClient({ serverUrl: "http://x", actorId: "actor_1", queryTtlMs: 1_000 });
  });

  it("rejects a lifetime option on the query cache", () => {
    // @ts-expect-error — the cache is a view; the registry owns the lifetime.
    createQueryCache(replica, undefined, { ttlMs: 1_000 });
  });
});
