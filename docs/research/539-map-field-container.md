# Map-field container for the replica (#539): shard(64) above the flip point

Research note and decision record for [issue #539](https://github.com/ebbjs/ebbjs/issues/539).
It builds on the #496 write-path research (`docs/research/496-map-field-write-path.md`
on branch `research/496-map-field-write-path`) and ships the P1b recommendation:
a sharded resident container behind a `toWire` / `fromWire` boundary, with the
wire format unchanged.

**Decision.** The replica's map fields stay plain objects below
**`MAP_FIELD_FLIP_POINT = 500`** keys and become a **shard(64)** container at or
above it. The constant, the container, and the adoption rule are in
`packages/storage/src/internal/map-field.ts`; the flip-point test pins the
threshold at 500.

## Why this shape

The #496 note measured the winning one-key patch of an N-key map: a plain object
is `~229 µs` at N=1000 and `~3.9 ms` at N=10000; shard(64) is flat at
`~5–14 µs`; HAMT is `~0.2 µs` but pays **1.8× resident memory** and a ~150-line
implementation or a new dependency. The container therefore only has to remove
the O(N) copy, and that is exactly what copying the touched shard does.

Two constraints shaped the integration:

- **The public `Entity` type must not change.** It carries
  `FieldValue.map: Record<string, FieldValue>` and every consumer reads `.map`
  (`parseContentField`, `projectFieldValue`, React, the derived-body accessor).
  A container that needed a conversion at the read boundary would move the O(N)
  cost from the write path to every read, defeating the replica's synchronous
  read contract.
- **A retained row must not observe a later write.** The #496 read model owns
  its rows and hands them out shared; the container is copy-on-write, never
  in-place.

The container is a `FieldMap` first: an own enumerable `map` getter materializes
the flat wire record on demand and caches it per version. Every existing reader
therefore sees the same flat record, and `JSON.stringify` / structured clone
produce the same wire shape. Only the write path and the record / cold-read
boundaries call explicit helpers.

## Boundaries

| boundary              | call                                                       | frequency           |
| --------------------- | ---------------------------------------------------------- | ------------------- |
| patch merge           | `mergeResidentFieldValue` copies the touched shard(s) only | per keystroke       |
| put / `load` / `open` | `adoptMapFields` adopts a plain map at or above 500 keys   | per install         |
| `toRecord`            | `withWireMapFields` flattens containers to the wire shape  | per snapshot        |
| consumer read         | the lazy `map` getter materializes the flat record once    | per changed version |

Adoption is opt-in: `applyUpdate` / `mergeFields` keep the plain wire shape by
default, and the replica passes `RESIDENT_MAP_FIELDS`. The legacy in-memory and
IndexedDB adapters deep-clone every row, so they never build the container and
their persisted shape stays flat.

The wire format is unchanged: `{ map: { key: leaf } }`, same leaves, same merge
rule. The cross-language merge vectors (`fixtures/merge_vectors.json`) pass both
on the container and on the plain path, and nested plain maps inside a shard
still merge recursively.

## Measured flip point

`pnpm --filter @ebbjs/storage benchmark:map-field` (this branch; one process,
leaves shaped like real run nodes). Winning one-key patch, µs/op, patched key
and a sibling observed:

| rep                           | N=100 | N=300 | N=500 |  N=1000 |  N=2000 |   N=5000 |  N=10000 |
| ----------------------------- | ----: | ----: | ----: | ------: | ------: | -------: | -------: |
| plain object                  |   1.8 |   2.7 |   1.6 | **217** | **497** | **1935** | **3961** |
| sharded container             |   2.7 |   2.7 |   1.9 | **2.5** | **7.6** |   **17** |   **35** |
| sharded merge + first read    |    14 |    13 |    24 |      56 |     657 |     1894 |     4038 |
| adopt from wire (µs, once)    |    29 |    55 |   128 |     397 |    1415 |     3191 |     7081 |
| `toWire` at record (µs, once) |   0.5 |   0.4 |   0.5 |     0.8 |      56 |      378 |      973 |

Below the flip point the plain object is cheaper because sharding always pays
the 64-slot shard array (`N/K + K` property writes). Above it the write is flat
in N: the touched shard holds `N/64` keys, so N=10000 copies ~156 keys instead
of 10000. Adoption and `toWire` are O(N) but happen once per install / snapshot,
never per keystroke.

The merge-plus-read row is the local-keystroke number: a reader that
materializes the flat record pays O(N) again, so the advantage is gone by
N≈2000 (657 µs versus 497 µs plain) and the write win is largest for updates
whose map is not read. The write itself is flat at every N; the container does
not make the projection path sub-linear.

The N=300–500 plain-object numbers are lower than the #496 note's table on this
machine; this harness's cliff (the dictionary-mode transition) lands between 500
and 1000. The threshold sits at 500 so a document is adopted before it reaches
the cliff. The exact crossing is machine-shaped; the decision only needs "below
~500 keep the object, above it stop copying the map".

## Read caching

An immutable container version is also a cache key. `parseContentField` and
`projectFieldValue` cache their result per field object, and
`TextDocument.hydrate` skips a repeat hydrate of the same version when the
document state has not changed since. `pnpm --filter @ebbjs/client
benchmark:map-read`:

| read                                 | N=500 | N=1000 | N=5000 | N=10000 |
| ------------------------------------ | ----: | -----: | -----: | ------: |
| `parseContentField`, new version     |   353 |    312 |   2040 |    5146 |
| `parseContentField`, same version    |     0 |      0 |      0 |       0 |
| `projectFieldValue`, new version     |   175 |    363 |   1881 |    4471 |
| `projectFieldValue`, same version    |     0 |      0 |      0 |       0 |
| `TextDocument.hydrate`, new version  |   208 |    375 |   2649 |    6755 |
| `TextDocument.hydrate`, same version |   0.1 |    0.1 |      0 |       0 |

A _new_ version still costs the O(N) parse/projection — the output has N
entries — but an unchanged version is a cache hit. One write followed by many
renders therefore pays the read cost once, not once per render. The cache
assumes field values are immutable, which the merge already guarantees: a
no-op reuses the field by reference, a winning patch produces a new object.

## Deliberate limits

- **Key order.** Above the flip point the flat record's key order is the shard
  order (deterministic per key hash), not insertion order. Map keys are merged
  as an unordered set by the protocol, so this is semantically irrelevant, but a
  snapshot taken before and after adoption can differ in key order.
- **Readers still materialize on a new version.** A projection, hydrate, or
  `JSON.stringify` of a changed map field walks all N keys once per version, as
  it does today. The container removes the per-write copy, and the read caches
  above remove repeat reads of an unchanged version; the first read after a
  write still pays O(N). Making readers iterate shards directly is a follow-up
  slice.
- **Nested maps.** Only a top-level map field is sharded. A nested map inside a
  shard stays a plain record and merges under the core rule; #504's block tree
  can revisit recursive sharding if a nested map ever gets large.
- **No HAMT.** At the measured memory budget, 1.8× resident bytes on the one
  field that is already the biggest held thing is a worse trade than the flat
  17–35 µs sharded write. Revisit if documents routinely exceed ~10k runs and
  writes become the hottest loop.
- **No server change.** `FieldMerge.merge` in Elixir already shares structure;
  the server's map cost is JSON, not the merge (#496 §3.6).
