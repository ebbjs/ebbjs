import { isFieldMap, mergeFieldValue, type FieldMap, type FieldValue } from "@ebbjs/core";

/**
 * The resident container for a map field above {@link MAP_FIELD_FLIP_POINT}.
 *
 * A one-key patch of an N-key map on a plain object copies every property.
 * This container spreads the keys over shard records and copies only the shards
 * a winning key lands in, so a keystroke stops scaling with N. Below the flip
 * point the plain object wins, because sharding always pays the shard array.
 *
 * It stays a `FieldMap`: an own enumerable `map` getter materializes the flat
 * wire record on demand and caches it, so existing readers, `JSON.stringify`,
 * and structured clone see the shape they already expect, and the wire format
 * never changes. The shards live in a WeakMap so the container's enumerable
 * shape is exactly a plain map field. Copy-on-write keeps a retained row
 * intact: only the touched shards are new.
 */

/** A flat, wire-shaped map field: the only shape that crosses the boundary. */
type WireMap = Record<string, FieldValue>;

/** The property count at which the container starts beating the plain object. */
export const MAP_FIELD_FLIP_POINT = 500;

/** Shard bucket count. K=64 minimised `N/K + K` over the measured N range. */
export const MAP_FIELD_SHARD_COUNT = 64;

type Shards = readonly WireMap[];

const shardsByField = new WeakMap<FieldMap, Shards>();

const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const shardIndex = (key: string): number => fnv1a(key) % MAP_FIELD_SHARD_COUNT;

const emptyShards = (): WireMap[] =>
  Array.from({ length: MAP_FIELD_SHARD_COUNT }, (): WireMap => ({}));

/**
 * Build a container over `shards`. `flattened` is the container's own flat
 * record when the caller already has one to hand over.
 */
const createSharded = (shards: Shards, flattened?: WireMap): FieldMap => {
  let wire = flattened;
  const field: FieldMap = {
    get map(): WireMap {
      if (wire === undefined) {
        const out: WireMap = {};
        for (const shard of shards) Object.assign(out, shard);
        wire = out;
      }
      return wire;
    },
  };
  shardsByField.set(field, shards);
  return field;
};

/** Whether a field value is a resident sharded container rather than a plain map. */
export const isShardedMapField = (field: FieldValue): boolean =>
  isFieldMap(field) && shardsByField.has(field);

/** The shard records behind a container. Exposed so tests can see the copy-on-write layout. */
export const mapFieldShards = (field: FieldMap): Shards => {
  const shards = shardsByField.get(field);
  if (shards === undefined) throw new Error("not a sharded map field");
  return shards;
};

/** Read one key without materializing the flat record. */
export const mapFieldGet = (field: FieldMap, key: string): FieldValue | undefined => {
  const shards = shardsByField.get(field);
  return shards === undefined ? field.map[key] : shards[shardIndex(key)][key];
};

/** The `toWire` boundary: the flat record, materialized once per version. */
export const mapFieldToWire = (field: FieldMap): WireMap => field.map;

/**
 * The `fromWire` boundary: adopt a flat record as a container, once. The
 * container keeps its own flat copy, so a caller's later mutation of `wire`
 * cannot show through.
 */
export const mapFieldFromWire = (wire: WireMap): FieldMap => {
  const shards = emptyShards();
  const flattened: WireMap = {};
  for (const [key, value] of Object.entries(wire)) {
    shards[shardIndex(key)][key] = value;
    flattened[key] = value;
  }
  return createSharded(shards, flattened);
};

/** Adopt a plain map as a container once it reaches the measured flip point. */
export const adoptMapField = (field: FieldValue): FieldValue => {
  if (!isFieldMap(field) || isShardedMapField(field)) return field;
  return Object.keys(field.map).length >= MAP_FIELD_FLIP_POINT
    ? mapFieldFromWire(field.map)
    : field;
};

/** Adopt every map field at or above the flip point, sharing the record otherwise. */
export const adoptMapFields = (fields: Record<string, FieldValue>): Record<string, FieldValue> => {
  let adopted: Record<string, FieldValue> | undefined;
  for (const [name, field] of Object.entries(fields)) {
    const next = adoptMapField(field);
    if (next === field) continue;
    if (adopted === undefined) adopted = { ...fields };
    adopted[name] = next;
  }
  return adopted ?? fields;
};

/** Flatten containers back to the wire shape, sharing the record when there are none. */
export const toWireMapFields = (fields: Record<string, FieldValue>): Record<string, FieldValue> => {
  let wire: Record<string, FieldValue> | undefined;
  for (const [name, field] of Object.entries(fields)) {
    if (!isFieldMap(field) || !isShardedMapField(field)) continue;
    if (wire === undefined) wire = { ...fields };
    wire[name] = { map: mapFieldToWire(field) };
  }
  return wire ?? fields;
};

/**
 * Merge an incoming wire-shaped map into a container, copying only the shards
 * the winning keys land in. Returns the existing container by reference when no
 * key changed, preserving the merge's no-op signal.
 */
const mergeShardedMapField = (existing: FieldMap, incoming: FieldMap): FieldMap => {
  const shards = mapFieldShards(existing);
  const next = [...shards];
  const touched = new Map<number, WireMap>();

  for (const [key, value] of Object.entries(incoming.map)) {
    const index = shardIndex(key);
    const current = touched.get(index) ?? shards[index];
    const previous = current[key];
    const merged = mergeFieldValue(previous, value);
    if (merged === previous) continue;
    let shard = touched.get(index);
    if (shard === undefined) {
      shard = { ...shards[index] };
      touched.set(index, shard);
    }
    shard[key] = merged;
  }

  if (touched.size === 0) return existing;
  for (const [index, shard] of touched) next[index] = shard;
  return createSharded(next);
};

/**
 * The normative merge over a resident field value. A container takes the
 * sharded path; a plain value keeps `mergeFieldValue`'s result and adopts a
 * container when the merged map reaches the flip point.
 */
export const mergeResidentFieldValue = (
  existing: FieldValue | undefined,
  incoming: FieldValue,
): FieldValue => {
  if (existing !== undefined && isFieldMap(existing) && isShardedMapField(existing)) {
    return isFieldMap(incoming) ? mergeShardedMapField(existing, incoming) : incoming;
  }
  const merged = mergeFieldValue(existing, incoming);
  return merged === existing ? merged : adoptMapField(merged);
};
