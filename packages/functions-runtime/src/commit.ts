/**
 * The errors a handler can see from `ctx`, and the commit frame helpers.
 *
 * A commit refusal is mapped onto the shapes a client already knows: a
 * rejected Action becomes an {@link ActionRejectedError} carrying the server's
 * `rejected[]`, exactly as `POST /sync/actions` reports it, and anything else
 * becomes a {@link HostCallError} carrying the host's code, status, and
 * details.
 */

import { createHash } from "node:crypto";

import type { Action, Update } from "@ebbjs/core";
import { ActionRejectedError, type Rejection } from "@ebbjs/write";

/** What `ctx.commit()` resolves to. */
export interface CommitOutcome {
  readonly replayed: boolean;
}

/**
 * The Action id for one invocation, matching the server:
 * `"a_" <> first16(lowercase_hex(sha256(invocation_id)))`, i.e. `a_` plus the
 * first sixteen hexadecimal characters of the digest.
 *
 * Deriving the id rather than minting a random one is what makes a retry
 * carrying the same `Idempotency-Key` dedupe: the server sees the same
 * `action_id` and drops the second submission before claiming a GSN.
 */
export const actionIdForInvocation = (invocationId: string): string =>
  `a_${createHash("sha256").update(invocationId, "utf8").digest("hex").slice(0, 16)}`;

/** The one Action an invocation submits: the core shape, `hlc` in string form, `gsn: 0`. */
export const commitAction = (options: {
  readonly invocationId: string;
  readonly actorId: string;
  readonly hlc: string;
  readonly updates: readonly Update[];
}): Action => ({
  id: actionIdForInvocation(options.invocationId),
  actor_id: options.actorId,
  hlc: options.hlc,
  gsn: 0,
  updates: [...options.updates],
});

/** Read the success reply value (`%{"replayed" => boolean}`). */
export const readCommitOutcome = (value: unknown): CommitOutcome => ({
  replayed:
    typeof value === "object" &&
    value !== null &&
    (value as { replayed?: unknown }).replayed === true,
});

/**
 * A host call that failed for a reason other than a rejected Action. Carries
 * the host's error code, status, and details so a handler can tell a
 * validation failure from an outage.
 */
export class HostCallError extends Error {
  /** The host's error code (`"internal"`, `"unknown_op"`, ...). */
  readonly code: string;
  /** The HTTP-shaped status the host paired with the code. */
  readonly status: number;
  /** The host's human-readable detail, when it sent one. */
  readonly details: string | null;

  constructor(options: {
    readonly code: string;
    readonly status: number;
    readonly details: string | null;
  }) {
    super(options.details ?? options.code);
    this.name = "HostCallError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

/** The host's refusal envelope, when the value looks like one. */
interface ErrorEnvelope {
  readonly code: string;
  readonly status: number;
  readonly details: string | null;
  readonly rejected: readonly unknown[] | undefined;
}

const asEnvelope = (error: unknown): ErrorEnvelope | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const envelope = error as {
    error?: unknown;
    status?: unknown;
    details?: unknown;
    rejected?: unknown;
  };
  return {
    code: typeof envelope.error === "string" ? envelope.error : "host_error",
    status: typeof envelope.status === "number" ? envelope.status : 500,
    details: typeof envelope.details === "string" ? envelope.details : null,
    rejected: Array.isArray(envelope.rejected) ? envelope.rejected : undefined,
  };
};

const asRejection = (value: unknown): Rejection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as { id?: unknown; reason?: unknown; details?: unknown };
  if (typeof entry.id !== "string" || typeof entry.reason !== "string") return undefined;
  return entry.details === undefined || typeof entry.details === "string" || entry.details === null
    ? { id: entry.id, reason: entry.reason, details: entry.details }
    : { id: entry.id, reason: entry.reason };
};

/**
 * Map a failed host call onto the error a handler sees. A rejection envelope
 * with a per-Update `rejected[]` becomes {@link ActionRejectedError}; a
 * transport-level `Error` is rethrown untouched; anything else is a
 * {@link HostCallError}.
 */
export const callFailure = (error: unknown, op: string): unknown => {
  if (error instanceof Error) return error;
  const envelope = asEnvelope(error);
  if (envelope === undefined) return error;
  const rejected = (envelope.rejected ?? []).flatMap((entry) => {
    const rejection = asRejection(entry);
    return rejection === undefined ? [] : [rejection];
  });
  if (envelope.code === "rejected" || envelope.status === 422) {
    if (rejected.length > 0) return new ActionRejectedError(rejected);
  }
  return new HostCallError({
    code: envelope.code,
    status: envelope.status,
    details: envelope.details ?? `${op} failed`,
  });
};
