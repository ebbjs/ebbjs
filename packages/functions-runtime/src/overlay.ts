/**
 * The read-your-writes overlay.
 *
 * Buffered Updates are applied over the host's view of an id, using the wire's
 * own merge rule (`mergeFieldValue`), so a handler that writes and then reads
 * sees what its Action will store. A row this invocation created is visible
 * before it exists anywhere else; a row it deleted reads as `null`; an id it
 * never touched passes the host view through unchanged.
 *
 * The result is the same wire shape the host returns — `data.fields` holds
 * `FieldValue` leaves and maps, never projected primitives — so a read does not
 * change shape depending on whether the invocation wrote to the row. The
 * buffered Updates are per component, so the overlay folds each into its field.
 */

import {
  compare,
  componentField,
  isFieldMap,
  mergeFieldValue,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";

/** What the overlay reads: this invocation's buffered Updates and the host's view. */
export interface OverlaySource {
  /** The buffered Updates addressing `id`, in wire order. */
  updatesFor(id: string): readonly Update[];
  /** The model of the last buffered write for `id`. */
  typeOf(id: string): string | undefined;
  /** The host's view of `id` (`ctx.get` without the overlay). */
  readHost(id: string): Promise<EntityResponse | null>;
}

export interface Overlay {
  read(id: string): Promise<EntityResponse | null>;
}

/** The leaf an Update carries, or `undefined` for a keyed or dropped value. */
const leafOf = (update: Update): FieldValue | undefined => {
  if (update.method === "drop" || update.method === "delete") return undefined;
  return isFieldMap(update.data) ? undefined : update.data;
};

/**
 * Read one entity through the overlay. An id with no buffered write is the
 * host view itself — the same object, not a copy.
 */
const readOverlay = async (source: OverlaySource, id: string): Promise<EntityResponse | null> => {
  const writes = source.updatesFor(id);
  if (writes.length === 0) return source.readHost(id);
  if (writes[writes.length - 1]?.method === "delete") return null;

  // A `replace` as the first buffered write is this invocation's create, so
  // the row exists without the host: no read is needed (or meaningful).
  const createdHere = writes[0]?.method === "replace";
  const host = createdHere ? null : await source.readHost(id);
  // The host's view is the wire shape the entity endpoints publish, so its
  // fields are already `FieldValue`s.
  let fields: Record<string, FieldValue> | null =
    host === null ? {} : ((host.data.fields ?? {}) as Record<string, FieldValue>);
  let exists = host !== null;
  let createdHlc = host === null ? "" : String(host.created_hlc ?? "");
  let updatedHlc = host === null ? "" : String(host.updated_hlc ?? "");

  for (const update of writes) {
    if (update.method === "delete") {
      fields = null;
      exists = false;
      continue;
    }
    const field = componentField(update.component);
    const current: Record<string, FieldValue> = fields ?? {};
    if (update.method === "drop") {
      const { [field]: _dropped, ...rest } = current;
      fields = rest;
    } else {
      const incoming = update.data;
      const previous = current[field];
      const next =
        update.method === "merge" && previous !== undefined
          ? mergeFieldValue(previous, incoming)
          : incoming;
      fields = { ...current, [field]: next };
      if (!exists && update.method === "replace") {
        createdHlc = leafOf(update)?.hlc ?? createdHlc;
      }
      exists = true;
    }
    const stamp = leafOf(update)?.hlc;
    if (stamp === undefined) continue;
    if (updatedHlc === "" || compare(stamp, updatedHlc) > 0) updatedHlc = stamp;
  }

  if (fields === null) return null;

  return {
    id,
    type: source.typeOf(id) ?? host?.type ?? "",
    data: { fields },
    created_hlc: createdHlc,
    updated_hlc: updatedHlc,
    deleted_hlc: null,
    // A row created by this invocation has not been assigned a GSN yet.
    last_gsn: host?.last_gsn ?? 0,
  };
};

export const createOverlay = (source: OverlaySource): Overlay => ({
  read: (id: string) => readOverlay(source, id),
});
