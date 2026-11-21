import type { Entity } from "@ebbjs/core";
import type { ReplicaRecord } from "../types/replica-store";

/**
 * The record shape this build writes. A record written by another format reads
 * as absent, so a shape change cannot smuggle a stale base into the replica.
 *
 * 7 drops a pre-#943 record from the fast path. Format 6 could omit a row's
 * lazily-loaded components and name them in `notResident`; nothing on the row
 * said it was partial, and this build has no such map. Reading one would have
 * adopted a partial row as whole, so the client replays the Action log instead.
 */
export const REPLICA_RECORD_FORMAT = 7;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A row's creation time is a packed HLC string, or `null` before its create. */
const isCreationTime = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isRowShape = (value: unknown): value is Entity =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { model?: unknown }).model === "string" &&
  typeof (value as { exists?: unknown }).exists === "boolean" &&
  isCreationTime((value as { created_hlc?: unknown }).created_hlc);

/** A positive integer version stamp, or `false` for anything else. */
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isComponentVersionsShape = (
  value: unknown,
): value is Record<string, Readonly<Record<string, number>>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (versions) =>
      typeof versions === "object" &&
      versions !== null &&
      !Array.isArray(versions) &&
      Object.values(versions).every(isVersion),
  );
};

/**
 * A record is readable only when it names a format this build understands
 * and is structurally whole. Anything else — a bad format, a negative or
 * fractional watermark, a non-array entity set, a malformed row, or a
 * malformed component-version map — reads as absent, so load falls back to
 * full replay.
 */
export const isValidReplicaRecord = (value: unknown): value is ReplicaRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReplicaRecord>;
  if (record.format !== REPLICA_RECORD_FORMAT) return false;
  if (!isNonNegativeInteger(record.position)) return false;
  if (!isNonNegativeInteger(record.revision)) return false;
  if (!Array.isArray(record.entities)) return false;
  if (!isComponentVersionsShape(record.componentVersions)) return false;
  return record.entities.every(isRowShape);
};
