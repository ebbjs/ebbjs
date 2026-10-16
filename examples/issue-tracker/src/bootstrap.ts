/**
 * Bootstrap: create the typed client, seed the actor's workspace and the
 * shared fixtures, run the handshake, then open the SSE subscription.
 * Returns the client plus its teardown so the caller owns the lifecycle
 * across actor switches.
 *
 * The seed is submitted through `client.seed()` — one Action built from
 * the plain `SeedData` in `./seed`, going through the same write path as
 * any other client write. The shared fixtures are attributed to the
 * `demo-seeder` service actor, so they need their own short-lived client
 * and are not tied to the signed-in actor's lifecycle.
 */

import { createClient, type NamespacedClient } from "@ebbjs/client";
import { schema, type Schema } from "./schema";
import { SEEDER_ACTOR_ID, buildActorSeed, buildSharedSeed } from "./seed";

export interface BootstrapResult {
  readonly client: NamespacedClient<Schema>;
  readonly groupIds: readonly string[];
  readonly unsubscribe: () => void;
}

export async function bootstrap(opts: {
  serverUrl: string;
  actorId: string;
}): Promise<BootstrapResult> {
  const { serverUrl, actorId } = opts;
  const client = createClient({ serverUrl, actorId, schema });

  await client.seed(buildActorSeed(actorId));

  const seeder = createClient({ serverUrl, actorId: SEEDER_ACTOR_ID, schema });
  try {
    await seeder.seed(buildSharedSeed());
  } finally {
    seeder.close();
  }

  const { groups } = await client.handshake();
  const groupIds = groups.map((group) => group.id);
  if (groupIds.length === 0) {
    client.close();
    throw new Error(
      `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
    );
  }

  const unsubscribe = client.subscribe(groupIds, 0, () => undefined);
  return { client, groupIds, unsubscribe };
}
