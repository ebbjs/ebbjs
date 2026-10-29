# Adding semantic search to an ebb app

Design synthesis for [ebbjs/ebbjs#495](https://github.com/ebbjs/ebbjs/issues/495)-era work,
and the design input to the still-open semantic-search spike
[#505](https://github.com/ebbjs/ebbjs/issues/505). Companion to
[`semantic-search-web-apps.md`](./semantic-search-web-apps.md), which holds the
primary-source numbers and citations behind every external claim here. #505 has no measured
number yet: everything below is design, not result.

## 1. What has to be indexed (ebb facts)

The stored form is a causal run tree, and it is not the index input. A consumer must
materialize plain text first.

- A document is **one entity**. Its `content` is a **map field**, run id → `RunNode`
  (`packages/client/src/fields/collaborative-text/schema.ts`). `RunNode` as shipped is
  `{ id, hlc, actorId, text, parentId, deleted }` — **text + tree position, no formatting
  payload**. Rich structure (blocks, headings, marks) is an app-level model layered on top,
  not something the run tree guarantees.
- Visible plain text is `reconstruct(state)` / `TextDocument.text`
  (`tree.ts`, `text-document.ts`): DFS over non-deleted runs in `compareRuns` order
  (HLC desc, `actorId` tiebreak), concatenating `text`. It is documented as
  "debugging/consistency checks only" — the live structure is `DocState.index`
  (`index.spans`: ordered run ids + lengths + total length).
- The write path is **run-granular**: wire updates patch individual run keys
  (`wire.ts` `readRunFields`, `applyRunFieldUpdates`), merge is per map key
  (`conflictScope: "field"`), and local edits produce run-level diffs (`diffRunFields`).
  A consumer can observe _which runs changed_ without re-scanning the document.
- **Derived entities already exist.** `e.collaborativeText()` hoists a field out of the
  wire shape and generates a `text_document__<parent>__<field>` entity the client maintains
  and the server persists (`schema/entity.ts` `DerivedFieldDef` / `DerivedAccessors`,
  `schema.ts` `generatedDocEntityName`, created in `sync/operations.ts` + `sync/atomic.ts`).
  This is the precedent for hosting generated per-document artifacts as first-class,
  synced, permissioned entities.

So: **index the materialized text, not the run map.** The run tree's value is change
detection, not content.

## 2. Pipeline

```
doc entity ──materialize──► plain text ──chunk──► chunks ──embed──► vectors
     ▲                                                                   │
     └── run-level deltas mark dirty chunks ◄──── content version ◄────────┘
                                          query: embed query → KNN → top-k ids
                                          render: sync read model (C) → titles/breadcrumbs
```

### 2.1 Materialize

- Walk `index.spans`, join run `text`, skip tombstones. O(text) for one document; cache the
  result keyed by a **content version** so it is computed once per change.
- Do not embed the raw run JSON: run ids, HLCs, `actorId`s, `parentId`s are noise and would
  wreck embedding quality. Join run text with `""` (the exact `reconstruct` semantics);
  never invent separators.
- A content version should be a hash of the materialized string (or of the sorted live run
  map), not the max HLC — an HLC can advance on a tombstone/patch without the text changing.

### 2.2 Chunk

Token-bounded: OpenAI embeddings cap at 8191/8192 tokens; Pinecone recommends starting
fixed-size and testing 128–1024 tokens; LlamaIndex defaults to 1024/20 tokens. Two chunk
identities are possible _in ebb_, and they behave very differently under edits:

| strategy           | identity              | edit cost                             | fits when                                                               |
| ------------------ | --------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| **block-anchored** | app block id (stable) | re-embed the touched block only       | the app models a page as blocks (the epic's `page_content`/block model) |
| **flat re-chunk**  | ordinal (shifts)      | re-embed dirty suffix, boundary churn | the document is one flat run tree (the demo)                            |

Block-anchored is the efficient design: no boundary shift, minimal invalidation. It requires
the app's block model, because the run tree itself has no block boundaries. Flat re-chunk is
the fallback and is what a plain `collaborative-text` body forces.

### 2.3 Embed

| option                          | dims / context         | cost / footprint  | notes                               |
| ------------------------------- | ---------------------- | ----------------- | ----------------------------------- |
| OpenAI `text-embedding-3-small` | 1536 / 8192 tok        | $0.02 per 1M tok  | `dimensions` truncation supported   |
| OpenAI `text-embedding-3-large` | 3072 / 8192 tok        | $0.13 per 1M tok  |                                     |
| `all-MiniLM-L6-v2` (on-device)  | 384 / 256 pieces       | ~23 MB int8 ONNX  | WASM/WebGPU via transformers.js     |
| `bge-small-en-v1.5`             | 384 / 512 tok          | ~133 MB fp32      |                                     |
| `nomic-embed-text-v1.5`         | 768 / 8192 tok, MRL→64 | ~137 MB int8 ONNX |                                     |
| EmbeddingGemma                  | 768 / 2K, MRL→128      | <200 MB quantized | ~200 ms/embed phone CPU (MediaPipe) |

Exact figures and sources: companion note, §2–3. For an offline-capable ebb app the natural
split is **server-computed bulk embeddings synced down as data** (quality, cheap, consistent)
plus an **optional on-device model for the actively-edited document** so offline edits stay
searchable. Scale check from the earlier 10k-doc spike: ~24 KB text/doc ⇒ ~60 M tokens for a
full workspace ⇒ **~$1.20** at `text-embedding-3-small` rates. The cost is latency, quota, and
offline behavior — not money.

### 2.4 Store: vectors are data, the index is a cache

Split the two concerns:

- **Vectors are derived data → sync them as entities.** They then exist on every device and
  offline, are group-scoped and permissioned like any entity, and ride the existing backfill
  machinery (#475). Two shapes:
  - one entity per chunk: `embedding { docId, chunkKey, model, dims, vector, sourceVersion }`;
  - an `embeddings` map field on a derived entity: `embeddings.map[chunkKey] = { vector,
model, sourceVersion }` — per-key LWW merge gives concurrent edits to _different_ chunks
    free convergence, exactly like the run map. Vectors are large opaque values, so per-chunk
    entities may give cleaner sync granularity.
- **The KNN/ANN index is a rebuildable cache → device-local, never synced.** `sqlite-vec` via
  `wa-sqlite` in OPFS is the natural fit (WASM, float/int8/binary, metadata + partition
  columns, brute-force is fine at 10k docs, 32× with binary quantization); `hnswlib-wasm` /
  `usearch` / Orama are alternatives. Never put the index graph in the CRDT.

### 2.5 Versioning and staleness

Every vector carries `model`, `dims`, and `sourceVersion`. At query time compare the
document's current content version to the vector's; stale ⇒ serve-with-flag, or exclude and
fall back to lexical. Model migration = bump `model`, ignore old vectors, run a backfill. This
is ordinary versioned-derived-data work, not a new primitive.

### 2.6 Query, hybrid, render

```
embed query (async) → KNN top-k, partitioned by group (async)
                    → load hit metadata
                    → render synchronously from the resident read model (design C)
```

This is the payoff of the earlier spike: the search half is inherently async, but the result
list — titles, breadcrumbs, parent chain — renders with zero `await`. Add cheap hybrid
retrieval (lexical/BM25 ∪ vector via RRF, Elasticsearch default `k=60`) for proper nouns and
ids; rerank is optional (Cohere Rerank: 4096-token context, auto-chunks >510 tokens).

## 3. Ebb-specific decisions

| #   | decision                     | recommendation                                                                                       | why                                                            |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D1  | synced vectors vs local-only | **vectors as synced derived entities; index local + rebuildable**                                    | offline search, consistency, group permissions, backfill reuse |
| D2  | chunk identity               | **block id if the app has blocks; else content-hash anchors; else re-chunk the doc on debounce**     | avoids re-embedding the world per keystroke                    |
| D3  | invalidation                 | run deltas → `index.spans` → dirty char range → dirty chunks; content-hash skip                      | the run tree already tells you what changed                    |
| D4  | model migration              | `model` + `dims` on every vector, backfill on change                                                 | no in-place "upgrade" is safe                                  |
| D5  | permissions                  | vectors inherit the doc's groups; partition the index by group; server search enforces `<type>.read` | derived-from-body data must not leak                           |
| D6  | offline edits                | last-synced vectors (stale-marked) and/or on-device re-embed of the active doc                       | embeddings cannot sync on an offline edit                      |

## 4. Efficiency plan

- Cache materialized text per document, keyed by content version.
- Map each applied run delta (INSERT/SPLIT/DELETE/EXTEND) to a character range via
  `index.spans`, then to the chunks it touches — recompute only those.
- Debounce embedding by ~1–2 s of idle; skip when the content hash is unchanged.
- Prefer block-level embeddings wherever the app has blocks — the single biggest invalidation
  win.
- Quantize to int8/binary for both the synced vectors and the local index.
- Partition the index by group; filter by group at query time.
- Keep the ANN graph, tokenizer, and model out of the CRDT — all rebuildable from data.

## 5. Permissions and residency

- Vectors are derived from body text, so they must be scoped to the document's group(s). A
  device only holds vectors for groups it subscribes to; server-side search (if any) must
  enforce the same `<type>.read` rule.
- Residency: per-document int8 1536-d vectors are ~15 MB at 10k docs (resident-cheap);
  chunk-level vectors are ~184 MB+ (on-disk index, not resident). Consistent with the earlier
  finding that metadata is 15.1 MB and bodies are 297.9 MB — vectors sit between them and
  belong in the on-disk tier unless per-document.

## 6. What no primary source covers

These are the parts that must be decided and tested for ebb, not looked up:

- materializing a CRDT run tree to plain text for embedding;
- chunk identity and stability under collaborative edits (overlap vs stable anchors);
- on-device vs synced-vector trade-offs for a local-first app;
- browser KNN latency and scale (no first-party numbers for sqlite-vec / hnswlib-wasm /
  Orama / DuckDB-Wasm VSS);
- HNSW delete/re-insert degradation over time.

## 7. Suggested next steps

1. Spike: materialize a real document with `reconstruct`, chunk at ~512 tokens, then measure
   (a) materialize + chunk time, (b) chunks dirtied by one keystroke under **block** vs
   **flat** chunking, (c) sync bytes per vector (int8 1536-d ≈ 1.5 KB).
2. Prototype `sqlite-vec` in OPFS with a group partition; measure KNN latency at 10k chunks.
3. Decide whether a general derived-entity API (beyond `collaborativeText`) is a prerequisite
   for synced vectors, or whether an app-level `embedding` entity type is enough.
