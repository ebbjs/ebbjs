/**
 * THROWAWAY PROTOTYPE — map-field container representations (ebbjs#496).
 *
 * This is a logic/data prototype, not a UI one. It exists to answer one
 * question: how should a large map field (a collaborative-text doc's `content`
 * run map) be represented and merged so a one-key write is sub-linear and does
 * not copy the whole map?
 *
 * It is deliberately throwaway. The wire format and the normative merge rule
 * (`packages/core/src/types/action.ts`) are NOT changed: every representation
 * here is an in-memory container that encodes to / decodes from the existing
 * flat `{ map: { key: leaf } }` wire shape. `mergeTopMap` is the normative
 * map-over-map rule ("union keys, merge each key by the same rule") applied
 * over a pluggable container.
 *
 * Correctness parity against the shared merge vectors and the conflict-slot
 * recursion lives in `map-write-path.ts`.
 *
 * @see packages/client/spike/map-write-path.ts
 */

import { isFieldMap, mergeFieldValue, type FieldValue } from "@ebbjs/core";

/** The wire shape of a map field: a flat, JSON-compatible key → leaf record. */
export type WireMap = Record<string, FieldValue>;

// ---------------------------------------------------------------------------
// Container interface
// ---------------------------------------------------------------------------

/**
 * A resident container for a map field's entries. `V` is the container; the
 * values stay wire-shaped `FieldValue`s, so nested maps (rare) are handled by
 * the normative recursive merge and only the top-level run map is specialized.
 */
export interface MapContainer<V> {
  readonly name: string;
  empty(): V;
  size(value: V): number;
  get(value: V, key: string): FieldValue | undefined;
  /**
   * Return a container with every `[key, value]` set. Implementations may
   * share structure; callers must treat `value` as immutable. A batch is
   * supplied so that a multi-key patch (an insert that also splits its
   * parent) copies each shared region at most once.
   */
  setMany(value: V, entries: Iterable<readonly [string, FieldValue]>): V;
  /** Deep-clone the container, preserving entry references. Used to model
   * the current merge, which rebuilds the map even when nothing changed. */
  copy(value: V): V;
  entries(value: V): Iterable<readonly [string, FieldValue]>;
  /** Encode to the flat wire shape (snapshot / wire). O(size). */
  toWire(value: V): WireMap;
  /** Decode from the flat wire shape (hydrate). O(size). */
  fromWire(wire: WireMap): V;
}

// ---------------------------------------------------------------------------
// Value equality — the read model's observable-content check, as a fallback
// ---------------------------------------------------------------------------

/**
 * Structural equality for a field value. Mirrors the read-model prototype's
 * `fieldValueEqual`: reference fast path first, because the normative merge
 * returns the existing leaf when the incoming one loses.
 */
export const fieldValueDeepEqual = (a: FieldValue, b: FieldValue): boolean => {
  if (a === b) return true;
  const aMap = isFieldMap(a);
  const bMap = isFieldMap(b);
  if (aMap !== bMap) return false;
  if (!aMap || !bMap) return false;
  const aKeys = Object.keys(a.map);
  const bKeys = Object.keys(b.map);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const other = b.map[key];
    if (other === undefined || !fieldValueDeepEqual(a.map[key]!, other)) return false;
  }
  return true;
};

/** True when `merged` adds or changes anything relative to `prev`. */
const mergeChanged = (prev: FieldValue | undefined, merged: FieldValue): boolean => {
  if (prev === undefined) return true;
  if (prev === merged) return false;
  return !fieldValueDeepEqual(prev, merged);
};

// ---------------------------------------------------------------------------
// The normative map merge, over a pluggable container
// ---------------------------------------------------------------------------

export interface MapMergeResult<V> {
  readonly value: V;
  /** True when the merge added or changed at least one key. */
  readonly changed: boolean;
  /**
   * True when `value` is the exact input container (nothing changed and the
   * caller opted into reuse). The version-handle read model can then bump
   * nothing without a structural scan.
   */
  readonly reused: boolean;
}

/**
 * Merge `incoming` (wire-shaped) over `existing` (a resident container) using
 * the normative rule: union the key sets, merge each key by `mergeFieldValue`.
 *
 * `reuseOnNoop=false` models today's `mergeFieldValue`, which rebuilds
 * `{ ...existing.map }` unconditionally. `reuseOnNoop=true` is the cheap fix:
 * when no key changed, return the input container unchanged.
 */
export const mergeTopMap = <V>(
  ops: MapContainer<V>,
  existing: V | undefined,
  incoming: WireMap,
  reuseOnNoop: boolean,
): MapMergeResult<V> => {
  const base = existing ?? ops.empty();
  const updates: Array<readonly [string, FieldValue]> = [];
  let changed = false;

  for (const key of Object.keys(incoming)) {
    const prev = existing === undefined ? undefined : ops.get(existing, key);
    const merged = mergeFieldValue(prev, incoming[key]!);
    if (mergeChanged(prev, merged)) changed = true;
    updates.push([key, merged]);
  }

  if (!changed && reuseOnNoop) {
    return { value: base, changed: false, reused: existing !== undefined };
  }
  return { value: ops.setMany(base, updates), changed, reused: false };
};

// ---------------------------------------------------------------------------
// A. Plain object — the baseline, and the current wire/resident shape
// ---------------------------------------------------------------------------

export const objContainer: MapContainer<WireMap> = {
  name: "object",
  empty: () => ({}),
  size: (value) => Object.keys(value).length,
  get: (value, key) => value[key],
  setMany: (value, entries) => {
    const out: WireMap = { ...value };
    for (const [key, field] of entries) out[key] = field;
    return out;
  },
  copy: (value) => ({ ...value }),
  entries: (value) => Object.entries(value),
  toWire: (value) => value,
  fromWire: (wire) => wire,
};

// ---------------------------------------------------------------------------
// B. Native Map — no property/dictionary-mode cliff, but still a flat O(N) copy
// ---------------------------------------------------------------------------

export const mapContainer: MapContainer<Map<string, FieldValue>> = {
  name: "Map",
  empty: () => new Map(),
  size: (value) => value.size,
  get: (value, key) => value.get(key),
  setMany: (value, entries) => {
    const out = new Map(value);
    for (const [key, field] of entries) out.set(key, field);
    return out;
  },
  copy: (value) => new Map(value),
  entries: (value) => value.entries(),
  toWire: (value) => Object.fromEntries(value),
  fromWire: (wire) => new Map(Object.entries(wire)),
};

/**
 * In-place `Map` mutation — the floor, and the option the shared-row read
 * contract currently forbids. No copy at all; the merge cost is the changed
 * keys only. Included so the benchmark can show what copy-on-write costs
 * relative to mutating.
 */
export const mapMutContainer: MapContainer<Map<string, FieldValue>> = {
  ...mapContainer,
  name: "Map(mut)",
  setMany: (value, entries) => {
    for (const [key, field] of entries) value.set(key, field);
    return value;
  },
  copy: (value) => new Map(value),
};

// ---------------------------------------------------------------------------
// C. Chunked / sharded plain objects — copy one shard + the shard array
// ---------------------------------------------------------------------------

const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export type ShardState = readonly WireMap[];

export const shardContainer = (shards: number): MapContainer<ShardState> => {
  const shardOf = (key: string): number => fnv1a(key) % shards;
  return {
    name: `shard(${shards})`,
    empty: () => Array.from({ length: shards }, () => ({})),
    size: (value) => {
      let total = 0;
      for (const shard of value) total += Object.keys(shard).length;
      return total;
    },
    get: (value, key) => value[shardOf(key)]![key],
    setMany: (value, entries) => {
      const out = [...value];
      const touched: Array<Set<string>> = Array.from({ length: shards }, () => new Set());
      const incoming = new Map<string, FieldValue>();
      for (const [key, field] of entries) {
        touched[shardOf(key)]!.add(key);
        incoming.set(key, field);
      }
      for (let i = 0; i < shards; i++) {
        if (touched[i]!.size === 0) continue;
        const shard: WireMap = { ...value[i]! };
        for (const key of touched[i]!) shard[key] = incoming.get(key)!;
        out[i] = shard;
      }
      return out;
    },
    copy: (value) => [...value],
    entries: function* (value) {
      for (const shard of value) yield* Object.entries(shard) as Array<[string, FieldValue]>;
    },
    toWire: (value) => Object.assign({}, ...value),
    fromWire: (wire) => {
      const out: WireMap[] = Array.from({ length: shards }, () => ({}));
      for (const [key, field] of Object.entries(wire)) out[shardOf(key)]![key] = field;
      return out;
    },
  };
};

// ---------------------------------------------------------------------------
// D. Persistent HAMT — structural sharing, O(log32 N) node copies per write
// ---------------------------------------------------------------------------

const HAM_BITS = 5;
const HAM_MASK = 0x1f;

type HamLeaf = {
  readonly t: 0;
  readonly hash: number;
  readonly key: string;
  readonly value: FieldValue;
};
type HamColl = {
  readonly t: 1;
  readonly hash: number;
  readonly entries: ReadonlyArray<readonly [string, FieldValue]>;
};
type HamBranch = { readonly t: 2; readonly bitmap: number; readonly children: readonly HamNode[] };
type HamNode = HamLeaf | HamColl | HamBranch;

export interface HamState {
  readonly root: HamNode | undefined;
  readonly size: number;
}

const popcount = (x: number): number => {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
};

const hamGet = (
  node: HamNode | undefined,
  hash: number,
  key: string,
  shift: number,
): FieldValue | undefined => {
  let current = node;
  while (current !== undefined) {
    if (current.t === 0) {
      return current.hash === hash && current.key === key ? current.value : undefined;
    }
    if (current.t === 1) {
      if (current.hash !== hash) return undefined;
      for (const [k, v] of current.entries) if (k === key) return v;
      return undefined;
    }
    const bit = 1 << ((hash >>> shift) & HAM_MASK);
    if ((current.bitmap & bit) === 0) return undefined;
    current = current.children[popcount(current.bitmap & (bit - 1))];
  }
  return undefined;
};

/** Build the branch that holds leaf `a` and the new `[hash,key,value]` leaf. */
const spliceLeaf = (
  a: HamLeaf,
  hash: number,
  key: string,
  value: FieldValue,
  shift: number,
): HamNode => {
  const incoming: HamLeaf = { t: 0, hash, key, value };
  if (a.hash === hash) {
    return {
      t: 1,
      hash,
      entries: [
        [a.key, a.value],
        [key, value],
      ],
    };
  }
  const aBit = 1 << ((a.hash >>> shift) & HAM_MASK);
  const nBit = 1 << ((hash >>> shift) & HAM_MASK);
  if (aBit === nBit) {
    return { t: 2, bitmap: aBit, children: [spliceLeaf(a, hash, key, value, shift + HAM_BITS)] };
  }
  const low = aBit < nBit ? a : incoming;
  const high = aBit < nBit ? incoming : a;
  return { t: 2, bitmap: aBit | nBit, children: [low, high] };
};

/** As `spliceLeaf`, but `node` is a collision node with its own hash. */
const spliceNode = (
  node: HamColl,
  hash: number,
  key: string,
  value: FieldValue,
  shift: number,
): HamNode => {
  const incoming: HamLeaf = { t: 0, hash, key, value };
  const oBit = 1 << ((node.hash >>> shift) & HAM_MASK);
  const nBit = 1 << ((hash >>> shift) & HAM_MASK);
  if (oBit === nBit) {
    return { t: 2, bitmap: oBit, children: [spliceNode(node, hash, key, value, shift + HAM_BITS)] };
  }
  const low = oBit < nBit ? node : incoming;
  const high = oBit < nBit ? incoming : node;
  return { t: 2, bitmap: oBit | nBit, children: [low, high] };
};

const hamSet = (
  node: HamNode | undefined,
  hash: number,
  key: string,
  value: FieldValue,
  shift: number,
): { readonly node: HamNode; readonly added: boolean } => {
  if (node === undefined) return { node: { t: 0, hash, key, value }, added: true };

  if (node.t === 0) {
    if (node.hash === hash && node.key === key) {
      if (node.value === value) return { node, added: false };
      return { node: { ...node, value }, added: false };
    }
    return { node: spliceLeaf(node, hash, key, value, shift), added: true };
  }

  if (node.t === 1) {
    if (node.hash !== hash) {
      return { node: spliceNode(node, hash, key, value, shift), added: true };
    }
    const index = node.entries.findIndex(([k]) => k === key);
    if (index >= 0) {
      if (node.entries[index]![1] === value) return { node, added: false };
      const entries = node.entries.slice();
      entries[index] = [key, value];
      return { node: { ...node, entries }, added: false };
    }
    return { node: { ...node, entries: [...node.entries, [key, value]] }, added: true };
  }

  const bit = 1 << ((hash >>> shift) & HAM_MASK);
  const position = popcount(node.bitmap & (bit - 1));
  if ((node.bitmap & bit) === 0) {
    const children = node.children.slice();
    children.splice(position, 0, { t: 0, hash, key, value });
    return { node: { t: 2, bitmap: node.bitmap | bit, children }, added: true };
  }
  const child = node.children[position]!;
  const result = hamSet(child, hash, key, value, shift + HAM_BITS);
  if (!result.added && result.node === child) return { node, added: false };
  const children = node.children.slice();
  children[position] = result.node;
  return { node: { ...node, children }, added: result.added };
};

function* hamEntries(node: HamNode | undefined): Generator<readonly [string, FieldValue]> {
  if (node === undefined) return;
  if (node.t === 0) {
    yield [node.key, node.value];
    return;
  }
  if (node.t === 1) {
    yield* node.entries;
    return;
  }
  for (const child of node.children) yield* hamEntries(child);
}

export interface HamStats {
  readonly depth: number;
  readonly branches: number;
  readonly leaves: number;
  readonly collisions: number;
  /** Branching nodes touched on the path to one key (the copy set for a write). */
  readonly pathNodes: number;
}

const walkHam = (
  node: HamNode | undefined,
  depth: number,
  acc: { depth: number; branches: number; leaves: number; collisions: number },
): void => {
  if (node === undefined) return;
  if (depth > acc.depth) acc.depth = depth;
  if (node.t === 0) acc.leaves += 1;
  else if (node.t === 1) acc.collisions += 1;
  else {
    acc.branches += 1;
    for (const child of node.children) walkHam(child, depth + 1, acc);
  }
};

/** Node/depth stats, and the node count on the path to `key` (one write's copy set). */
export const hamStats = (state: HamState, key: string): HamStats => {
  const acc = { depth: 0, branches: 0, leaves: 0, collisions: 0 };
  walkHam(state.root, 0, acc);
  let pathNodes = 0;
  let node = state.root;
  const hash = fnv1a(key);
  let shift = 0;
  while (node !== undefined) {
    pathNodes += 1;
    if (node.t !== 2) break;
    const bit = 1 << ((hash >>> shift) & HAM_MASK);
    if ((node.bitmap & bit) === 0) break;
    node = node.children[popcount(node.bitmap & (bit - 1))];
    shift += HAM_BITS;
  }
  return { ...acc, pathNodes };
};

export const hamContainer: MapContainer<HamState> = {
  name: "hamt",
  empty: () => ({ root: undefined, size: 0 }),
  size: (value) => value.size,
  get: (value, key) => hamGet(value.root, fnv1a(key), key, 0),
  setMany: (value, entries) => {
    let root = value.root;
    let size = value.size;
    for (const [key, field] of entries) {
      const result = hamSet(root, fnv1a(key), key, field, 0);
      root = result.node;
      if (result.added) size += 1;
    }
    return { root, size };
  },
  copy: (value) => value,
  entries: (value) => hamEntries(value.root),
  toWire: (value) => {
    const out: WireMap = {};
    for (const [key, field] of hamEntries(value.root)) out[key] = field;
    return out;
  },
  fromWire: (wire) => {
    let root: HamNode | undefined;
    let size = 0;
    for (const [key, field] of Object.entries(wire)) {
      const result = hamSet(root, fnv1a(key), key, field as FieldValue, 0);
      root = result.node;
      if (result.added) size += 1;
    }
    return { root, size };
  },
};

// ---------------------------------------------------------------------------
// Helpers the benchmark needs
// ---------------------------------------------------------------------------

/**
 * The O(N) structural scan the read model's `contentChanged` does today when
 * it has no "did anything change?" flag from the merge. Iterates both
 * containers; every unchanged entry is a reference hit, so the cost is the
 * traversal, not a deep compare.
 */
export const scanChangedRep = <V>(ops: MapContainer<V>, prev: V, next: V): boolean => {
  if (prev === next) return false;
  const nextEntries = new Map<string, FieldValue>();
  for (const [key, value] of ops.entries(next)) nextEntries.set(key, value);
  let count = 0;
  for (const [key, value] of ops.entries(prev)) {
    count += 1;
    const other = nextEntries.get(key);
    if (other === undefined || !fieldValueDeepEqual(value, other)) return true;
  }
  return count !== nextEntries.size;
};
