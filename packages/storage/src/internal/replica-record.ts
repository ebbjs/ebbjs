import type { Entity } from "@ebbjs/core";
import type { ReplicaRecord } from "../types/replica-store";

/**
 * The record shape this build writes. A record written by another format
 * is treated as absent rather than partially hydrated, so a shape change
 * can never smuggle a stale base into the replica.
 */
export const REPLICA_RECORD_FORMAT = 1;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isRowShape = (value: unknown): value is Entity =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { type?: unknown }).type === "string";

/**
 * A record is readable only when it names a format this build understands
 * and is structurally whole. Anything else — a bad format, a negative or
 * fractional watermark, a non-array entity set, a malformed row — reads
 * as absent, so load falls back to full replay.
 */
export const isValidReplicaRecord = (value: unknown): value is ReplicaRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReplicaRecord>;
  if (record.format !== REPLICA_RECORD_FORMAT) return false;
  if (!isNonNegativeInteger(record.position)) return false;
  if (!isNonNegativeInteger(record.revision)) return false;
  if (!Array.isArray(record.entities)) return false;
  return record.entities.every(isRowShape);
};
