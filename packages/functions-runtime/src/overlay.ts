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
 * Existence is the create's to state: a component write that reaches the host
 * without one is a value over a row this invocation cannot claim to have made.
 */

import {
  compare,
  componentField,
  isComponentUpdate,
  isFieldMap,
  isRowCreate,
  mergeFieldValue,
  updateComponentValue,
  type FieldValue,
  type RowCreate,
  type Update,
} from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";

/** What the overlay reads: this invocation's buffered Updates and the host's view. */
export interface OverlaySource {
  /** The buffered Updates addressing `id`, in wire order. */
  updatesFor(id: string): readonly Update[];
  /** The model of the last buffered write for `id`. */
  modelOf(id: string): string | undefined;
  /** The host's view of `id` (`ctx.get` without the overlay). */
  readHost(id: string): Promise<EntityResponse | null>;
}

export interface Overlay {
  read(id: string): Promise<EntityResponse | null>;
}

/** The row fact the buffer holds for `id`, or `undefined` when it holds none. */
const createOf = (writes: readonly Update[]): RowCreate | undefined => writes.find(isRowCreate);

/** The leaf an Update carries, or `undefined` for a keyed or dropped value. */
const leafOf = (update: Update): FieldValue | undefined => {
  const value = updateComponentValue(update);
  return value === undefined || isFieldMap(value) ? undefined : value;
};

/**
 * Read one entity through the overlay. An id with no buffered write is the
 * host view itself — the same object, not a copy.
 */
const readOverlay = async (source: OverlaySource, id: string): Promise<EntityResponse | null> => {
  const writes = source.updatesFor(id);
  if (writes.length === 0) return source.readHost(id);
  if (writes[writes.length - 1]?.method === "delete") return null;

  // A buffered create is this invocation's own row and its creation time, so
  // the host has nothing to add — and no read is needed (or meaningful).
  const create = createOf(writes);
  const host = create === undefined ? await source.readHost(id) : null;
  let fields: Record<string, FieldValue> | null =
    host === null ? {} : ((host.data.fields ?? {}) as Record<string, FieldValue>);
  let createdHlc = create?.hlc ?? (host === null ? "" : String(host.created_hlc ?? ""));
  let updatedHlc = host === null ? "" : String(host.updated_hlc ?? "");

  for (const update of writes) {
    if (update.method === "delete") {
      fields = null;
      continue;
    }
    if (!isComponentUpdate(update)) continue;
    const field = componentField(update.component);
    const current: Record<string, FieldValue> = fields ?? {};
    if (update.method === "drop") {
      const { [field]: _dropped, ...rest } = current;
      fields = rest;
    } else {
      const incoming = update.data;
      const previous = current[field];
      // Both value methods compare leaves: a `replace` is the same LWW compare
      // as a `merge` (see the server's `apply_component` and the storage
      // materializer), so an older write never overwrites a newer value the
      // buffer already holds. Only a `drop` or `delete` reverts a component.
      const next = previous === undefined ? incoming : mergeFieldValue(previous, incoming);
      fields = { ...current, [field]: next };
    }
    const stamp = leafOf(update)?.hlc;
    if (stamp === undefined) continue;
    if (updatedHlc === "" || compare(stamp, updatedHlc) > 0) updatedHlc = stamp;
  }

  if (fields === null) return null;

  return {
    id,
    model: source.modelOf(id) ?? host?.model ?? "",
    data: { fields },
    created_hlc: createdHlc,
    // A zero-component create has no write of its own to stamp the row, so the
    // creation time is the newest fact the buffer holds.
    updated_hlc: updatedHlc === "" ? createdHlc : updatedHlc,
    deleted_hlc: null,
    // A row created by this invocation has not been assigned a GSN yet.
    last_gsn: host?.last_gsn ?? 0,
  };
};

export const createOverlay = (source: OverlaySource): Overlay => ({
  read: (id: string) => readOverlay(source, id),
});
