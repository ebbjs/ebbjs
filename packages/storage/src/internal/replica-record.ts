import type { Entity } from "@ebbjs/core";
import type { ReplicaRecord } from "../types/replica-store";

/**
 * The record shape this build writes. A record written by another format reads
 * as absent, so a shape change cannot smuggle a stale base into the replica.
 */
export const REPLICA_RECORD_FORMAT = 4;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isRowShape = (value: unknown): value is Entity =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { exists?: unknown }).exists === "boolean" &&
  ((value as { created_hlc?: unknown }).created_hlc === null ||
    typeof (value as { created_hlc?: unknown }).created_hlc === "string");

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

const isNotResidentShape = (value: unknown): value is Record<string, readonly string[]> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (components) =>
      Array.isArray(components) && components.every((component) => typeof component === "string"),
  );
};

/**
 * A record is readable only when it names a format this build understands
 * and is structurally whole. Anything else — a bad format, a negative or
 * fractional watermark, a non-array entity set, a malformed row, a malformed
 * not-resident map, or a malformed component-version map — reads as absent, so
 * load falls back to full replay.
 */
export const isValidReplicaRecord = (value: unknown): value is ReplicaRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReplicaRecord>;
  if (record.format !== REPLICA_RECORD_FORMAT) return false;
  if (!isNonNegativeInteger(record.position)) return false;
  if (!isNonNegativeInteger(record.revision)) return false;
  if (!Array.isArray(record.entities)) return false;
  if (record.notResident !== undefined && !isNotResidentShape(record.notResident)) return false;
  if (!isComponentVersionsShape(record.componentVersions)) return false;
  return record.entities.every(isRowShape);
};
