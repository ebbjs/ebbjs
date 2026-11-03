/**
 * The read-your-writes overlay.
 *
 * Buffered Updates are applied over the host's view of an id, using the wire's
 * own merge rule (`mergeFieldValue`), so a handler that writes and then reads
 * sees what its Action will store. A row this invocation created is visible
 * before it exists anywhere else; a row it deleted reads as `null`; an id it
 * never touched passes the host view through unchanged.
 */

import { compare, mergeFieldValue, type FieldValue, type Update } from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";
import { projectFieldValue } from "@ebbjs/write";

/** What the overlay reads: this invocation's buffered Updates and the host's view. */
export interface OverlaySource {
  /** The buffered Updates addressing `id`, in wire order. */
  updatesFor(id: string): readonly Update[];
  /** The `subject_type` of the last buffered write for `id`. */
  typeOf(id: string): string | undefined;
  /** The host's view of `id` (`ctx.get` without the overlay). */
  readHost(id: string): Promise<EntityResponse | null>;
}

export interface Overlay {
  read(id: string): Promise<EntityResponse | null>;
}

/** A projected field value read back as a wire value that loses every merge. */
const toWireField = (value: unknown): FieldValue => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return {
      map: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          toWireField(entry),
        ]),
      ),
    };
  }
  // An empty HLC parses as the zero stamp: every buffered write is newer, which
  // is what lets a patch merge over a projected host value.
  return { value, update_id: "", hlc: "" };
};

const toWireFields = (fields: Record<string, unknown>): Record<string, FieldValue> =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, toWireField(value)]));

const project = (fields: Record<string, FieldValue>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, projectFieldValue(value)]));

/** The latest HLC carried by a field map's leaves, or `undefined` when it has none. */
const latestHlc = (fields: Record<string, FieldValue>): string | undefined => {
  let latest: string | undefined;
  const visit = (field: FieldValue): void => {
    if ("map" in field) {
      for (const entry of Object.values(field.map)) visit(entry);
      return;
    }
    if (field.hlc === undefined) return;
    if (latest === undefined || compare(field.hlc, latest) > 0) latest = field.hlc;
  };
  for (const field of Object.values(fields)) visit(field);
  return latest;
};

/**
 * Read one entity through the overlay. An id with no buffered write is the
 * host view itself — the same object, not a copy.
 */
const readOverlay = async (source: OverlaySource, id: string): Promise<EntityResponse | null> => {
  const writes = source.updatesFor(id);
  if (writes.length === 0) return source.readHost(id);

  const firstPut = writes.find((update) => update.method === "put");
  const last = writes[writes.length - 1];
  if (firstPut === undefined && last !== undefined && last.method === "delete") return null;

  const host = firstPut === undefined ? await source.readHost(id) : null;
  if (firstPut === undefined && host === null) return null;

  let fields: Record<string, FieldValue> | null =
    firstPut === undefined ? toWireFields(host?.data.fields ?? {}) : {};
  let createdHlc = firstPut === undefined ? String(host?.created_hlc ?? "") : "";
  let updatedHlc = firstPut === undefined ? String(host?.updated_hlc ?? "") : "";

  for (const update of writes) {
    if (update.method === "delete") {
      fields = null;
      continue;
    }
    const incoming = update.data?.fields ?? {};
    if (update.method === "put") {
      fields = { ...incoming };
    } else {
      const base: Record<string, FieldValue> = fields ?? {};
      const merged: Record<string, FieldValue> = { ...base };
      for (const [key, value] of Object.entries(incoming)) {
        merged[key] = mergeFieldValue(base[key], value);
      }
      fields = merged;
    }
    const stamp = latestHlc(incoming);
    if (stamp === undefined) continue;
    if (updatedHlc === "" || compare(stamp, updatedHlc) > 0) updatedHlc = stamp;
    if (createdHlc === "") createdHlc = stamp;
  }

  if (fields === null) return null;

  return {
    id,
    type: source.typeOf(id) ?? host?.type ?? "",
    data: { fields: project(fields) },
    created_hlc: createdHlc,
    updated_hlc: updatedHlc,
    deleted_hlc: null,
    // A row created by this invocation has not been assigned a GSN yet.
    last_gsn: firstPut === undefined ? (host?.last_gsn ?? 0) : 0,
  };
};

export const createOverlay = (source: OverlaySource): Overlay => ({
  read: (id: string) => readOverlay(source, id),
});
