/**
 * Bootstrap: create the typed client, seed the actor's workspace, run the
 * handshake, then open the SSE subscription. Returns the client plus its
 * teardown so the caller owns the lifecycle across actor switches.
 */

import { createClient, type NamespacedClient } from "@ebbjs/client";
import { schema, type Schema } from "./schema";
import { seed } from "./seed";

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

  await seed(serverUrl, actorId);

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
