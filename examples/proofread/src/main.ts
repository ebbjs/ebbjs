/**
 * Calls the deployed proofreading function with the generated contract map.
 *
 * The map is the whole client-side surface: its keys and types come from the
 * function definitions, so the call below is checked without importing
 * `@ebbjs/server` or the function module at runtime.
 */
import { createClient } from "@ebbjs/client";

import { functions } from "./ebb-functions.generated";
import { schema } from "./schema";

export interface ProofreadRun {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly documentId: string;
  readonly workspaceId: string;
  /** Same key on a retry so the server replays instead of writing twice. */
  readonly idempotencyKey?: string;
}

export type ProofreadClient = ReturnType<typeof createProofreadClient>;

export const createProofreadClient = (serverUrl: string, actorId: string) =>
  createClient({ serverUrl, actorId, schema, functions });

export const proofread = async (run: ProofreadRun) => {
  const client = createProofreadClient(run.serverUrl, run.actorId);
  const { commentCount, replayed } = await client.functions.proofreadDocument(
    {
      documentId: run.documentId,
      workspaceId: run.workspaceId,
    },
    { idempotencyKey: run.idempotencyKey },
  );
  return { commentCount, replayed };
};
