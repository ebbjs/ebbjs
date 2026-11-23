/**
 * One inactive lifetime (#941): checked by `tsc --noEmit`.
 *
 * `residencyTtlMs` is the only option that decides how long an unwatched read
 * stays warm, and the results view takes no lifetime option of its own.
 */

import { describe, it } from "vitest";

import { createReplica } from "@ebbjs/storage/replica";

import { createClient } from "../client";
import { createQueryResults } from "../query-results";

const replica = createReplica();

describe("one inactive lifetime", () => {
  it("rejects a second query TTL on the client options", () => {
    // @ts-expect-error — `residencyTtlMs` owns the lifetime; `queryTtlMs` is gone.
    createClient({ serverUrl: "http://x", actorId: "actor_1", queryTtlMs: 1_000 });
  });

  it("rejects a lifetime option on the results view", () => {
    // @ts-expect-error — the store is a view; the registry owns the lifetime.
    createQueryResults(replica, undefined, { ttlMs: 1_000 });
  });
});
