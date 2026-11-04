import { createHash } from "node:crypto";

import type { FunctionEnvelope } from "./envelope.ts";

/**
 * Bumped whenever the hashed payload or the algorithm changes. The value is
 * part of the hash, so old rows stop matching and redeploy instead of being
 * skipped as unchanged.
 */
export const DEPLOYMENT_HASH_VERSION = 1;

/**
 * What a deployment would do, independent of when it was uploaded.
 *
 * The digest covers code bytes; the rest is every envelope field that changes
 * the behaviour of the deployed function. `version` is the upload timestamp
 * and `signature` is not behaviour, so neither is hashed: the timestamp would
 * make every deploy look new. `entry` is the name, constant across a name's
 * history, but it is what the runner executes, so it stays in the payload.
 */
export function deploymentHashFor(envelope: FunctionEnvelope): string {
  const payload = {
    hashVersion: DEPLOYMENT_HASH_VERSION,
    digest: envelope.digest,
    runtime: envelope.runtime,
    contract: envelope.contract,
    access: envelope.access,
    timeoutMs: envelope.timeoutMs,
    memoryBytes: envelope.memoryBytes,
    entry: envelope.entry,
    paramsSchema: envelope.paramsSchema ?? null,
    outputSchema: envelope.outputSchema ?? null,
  };

  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
