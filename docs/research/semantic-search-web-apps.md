# Semantic search over document bodies in a web/offline app

Scope: how to add semantic search over document bodies to an app built on ebb
(documents stored as a map of collaborative "runs"; storage adapters IndexedDB
and in-memory; entities/actions sync over the wire). This note covers only
primary sources: official documentation, first-party source code, specifications,
first-party APIs and engineering blogs. Each claim below is followed by the URL
of the source that owns it. Any number that could not be traced to a primary
source is marked `unverified`. All pages and APIs were retrieved on 2026-10-17;
pricing and model suites on vendor pricing pages change frequently, so treat
prices as snapshots. The stored run/CRDT form is not directly indexable — a
consumer must materialize plain text first — and that fact is taken as given and
is not researched here.

---

## 1. Materializing plain text from rich/collaborative structures and chunking

### What the primary sources say

**Embedding inputs are bounded by tokens, and chunks must be produced in token
space.** OpenAI's cookbook states the embedding context length is measured in
tokens, not string length, and demonstrates tokenizing with `tiktoken`
(`cl100k_base`) and splitting the token stream into fixed token windows; it also
shows averaging chunk embeddings (weighted by chunk length, then L2-normalized)
or keeping them separate, and notes "In some cases, it may make sense to split
chunks on paragraph boundaries or sentence boundaries to help preserve the
meaning of the text."
(https://github.com/openai/openai-cookbook/blob/main/examples/Embedding_long_inputs.ipynb)

**OpenAI's model max input is 8192/8191 tokens.** The OpenAI embeddings guide's
model table lists `Max input` = 8192 for `text-embedding-3-small`,
`text-embedding-3-large`, and `text-embedding-ada-002`
(https://platform.openai.com/docs/guides/embeddings). The cookbook uses
`EMBEDDING_CTX_LENGTH = 8191` with `cl100k_base` and shows a `BadRequestError`
when exceeding it
(https://github.com/openai/openai-cookbook/blob/main/examples/Embedding_long_inputs.ipynb).

**Fixed-size chunking is the default recommendation; content/structure-aware
chunking is a refinement.** Pinecone: "Fixed-sized chunking will be the best
path in most cases, and we recommend starting here"; it describes fixed-size,
simple sentence/paragraph splitting, recursive character splitting,
document-structure-based chunking (PDF/DOCX/HTML/Markdown/LaTeX), semantic
chunking (embed sentences, split where semantic distance shifts), and contextual
chunking (prepend an LLM-generated context description). It also describes
"chunk expansion" (retrieve neighboring chunks) to restore context at query
time. For choosing sizes it suggests exploring 128/256 tokens for granular
matching and 512/1024 tokens for more context, and evaluating candidates with
representative queries. (https://www.pinecone.io/learn/chunking-strategies/)
Note: that page writes "8196 for text-embedding-3-small", which conflicts with
OpenAI's own 8192/8191 numbers above; treat Pinecone's 8196 as a typo.

**Recursive character splitting defaults are separator-driven and character
counted.** LangChain's `RecursiveCharacterTextSplitter` default separators are
`["\n\n", "\n", " ", ""]`, and it falls through to the next separator when a
piece still exceeds `chunk_size`
(https://github.com/langchain-ai/langchain/blob/master/libs/text-splitters/langchain_text_splitters/character.py).
The `TextSplitter` base class defaults are `chunk_size=4000`,
`chunk_overlap=200`, and `length_function=len` — i.e. characters by default
(https://github.com/langchain-ai/langchain/blob/master/libs/text-splitters/langchain_text_splitters/base.py).

**LlamaIndex defaults are token-based.** `llama_index.core.constants` defines
`DEFAULT_CHUNK_SIZE = 1024  # tokens` and `DEFAULT_CHUNK_OVERLAP = 20  # tokens`;
`SentenceSplitter` additionally defines `SENTENCE_CHUNK_OVERLAP = 200` and uses
a sentence tokenizer by default, while `TokenTextSplitter` uses a tokenizer
(https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/constants.py,
https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/node_parser/text/sentence.py,
https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/node_parser/text/token.py).
The node-parser guide shows `SentenceSplitter(chunk_size=1024, chunk_overlap=20)`
(https://docs.llamaindex.ai/en/stable/module_guides/loading/node_parsers/).

**Overlap is a parameter in all three first-party splitters** (OpenAI cookbook
chunk-embedding recipe uses non-overlapping token windows; LangChain
`chunk_overlap=200` chars; LlamaIndex `chunk_overlap` default 20 tokens /
`SENTENCE_CHUNK_OVERLAP=200`).

### Open questions / unverified

- No primary source found that specifies how to materialize a collaborative
  rich-text/run structure to plain text for embedding. Chunk boundaries therefore
  cannot be aligned to run/formatting structure using vendor guidance; that is
  inherent to ebb's data model (`unverified`).
- Optimal chunk size for ebb documents is not determinable from primary sources;
  Pinecone and OpenAI only give ranges/process (128–1024 tokens; try-and-measure).
- Token-per-character and token-per-word ratios for any specific tokenizer are
  not asserted as constants by these sources; they depend on tokenizer and text.
- No first-party source prescribes how to handle chunk overlap when chunk
  identity must be stable across edits (`unverified`).

---

## 2. Embedding models: dimensions, limits, cost, truncation, quantization

### What the primary sources say

**OpenAI.** `text-embedding-3-small` default 1536 dims, `text-embedding-3-large`
default 3072 dims; both accept a `dimensions` parameter to shorten the output;
requests are billed per input token; the guide's example table reports MTEB
62.3% (small), 64.6% (large), 61.0% (ada-002) and "~pages per dollar" of 62,500 /
9,615 / 12,500 respectively
(https://platform.openai.com/docs/guides/embeddings). The guide states a
`text-embedding-3-large` vector shortened to 256 dims still outperforms an
unshortened `ada-002` (1536) on MTEB. Pricing page per 1M tokens:
`text-embedding-3-small` $0.02, `text-embedding-3-large` $0.13,
`text-embedding-ada-002` $0.10
(https://platform.openai.com/docs/pricing).

**Cohere.** Model table (https://docs.cohere.com/docs/models):
`embed-v5.0-pro` and `embed-v5.0-fast`: dims one of
`[256, 512, 768, 1024, 1536, 2048 (default)]`, context 128k tokens;
`embed-v4.0`: `[256, 512, 1024, 1536 (default)]`, 128k; `embed-english-v3.0`
1024 dims / 512 tokens; `embed-english-light-v3.0` 384 / 512;
`embed-multilingual-v3.0` 1024 / 512. The Embed guide documents Matryoshka
output dimensions for `embed-v5.0-pro` (`[256,512,768,1024,1536,2048]`) and
compression via `embedding_types`: `float`, `int8`, `uint8`, `binary`,
`ubinary`; it notes binary vectors are bit-packed so a 1024-dim binary vector
returns as 1024/8 = 128 bytes
(https://docs.cohere.com/docs/embeddings). The public Cohere pricing page lists
Embed 5 per-instance hourly/monthly rates, not a per-1M-token embedding price;
no per-token embedding price was findable there (`unverified`).
(https://cohere.com/pricing)

**Voyage.** Model table: `voyage-4-large`/`voyage-4`/`voyage-4-lite`/`voyage-code-4`
have 32,000-token context and dims 1024 (default) / 256 / 512 / 2048;
`voyage-3-large`/`voyage-3.5`/`voyage-3.5-lite`/`voyage-code-3` same; `voyage-3`
1024; `voyage-3-lite` 512; `voyage-law-2` 16,000 context / 1024; `voyage-2`
4,000 / 1024. `output_dtype` supports `float`, `int8`, `uint8`, `binary`,
`ubinary`; `int8`/`uint8` are 8-bit ints, and `binary`/`ubinary` are bit-packed
at 1/8 of `output_dimension`. Per-1M-token pricing: `voyage-4-large` $0.12,
`voyage-4` $0.06, `voyage-4-lite` $0.02, `voyage-context-4` $0.12,
`voyage-code-4` $0.12; first 200M tokens free per account. Rerank pricing
`rerank-3` $0.05/1M and `rerank-3-lite` $0.02/1M
(https://docs.voyageai.com/docs/embeddings, https://docs.voyageai.com/docs/pricing).

**Google (Gemini API).** `gemini-embedding-001`: input token limit 2,048,
output dims flexible 128–3072 (recommended 768/1536/3072), last updated June 2025. `gemini-embedding-2`: multimodal, input token limit 8,192, output dims
128–3072. Both use Matryoshka Representation Learning; the embeddings page
recommends 768/1536/3072 output dims and reports MTEB (Gemini Embedding 001) of
68.16 (2048), 68.17 (1536), 67.99 (768), 67.55 (512), 66.19 (256), 63.31 (128).
`gemini-embedding-2` auto-renormalizes truncated dims; `gemini-embedding-001`
requires manual normalization.
(https://ai.google.dev/gemini-api/docs/embeddings). Pricing: `gemini-embedding-2`
text input $0.20/1M tokens (batch $0.10/1M); a `gemini-embedding-001` price is
not listed on the current pricing page (`unverified`)
(https://ai.google.dev/gemini-api/docs/pricing).

**Open-weight models (Hugging Face model cards + model configs).**
`nomic-ai/nomic-embed-text-v1.5`: 768 dims, seq len 8192, MRL truncation to
512/256/128/64 with MTEB 62.28 / 61.96 / 61.04 / 59.34 / 56.10 respectively
(https://huggingface.co/nomic-ai/nomic-embed-text-v1.5). Its `config.json`
reports `hidden_size=768`, `max_position_embeddings=2048`, `n_positions=8192`
(https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/config.json).
`BAAI/bge-small-en-v1.5`: `hidden_size=384`, `max_position_embeddings=512`; the
card's table lists 384 dims, sequence length 512, avg MTEB 62.17, retrieval
51.68 (https://huggingface.co/BAAI/bge-small-en-v1.5,
https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/config.json).
`mixedbread-ai/mxbai-embed-large-v1`: `hidden_size=1024`,
`max_position_embeddings=512`; the card documents Matryoshka + binary
quantization support (https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1,
https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/raw/main/config.json).
`sentence-transformers/all-MiniLM-L6-v2`: 384 dims; "By default, input text
longer than 256 word pieces is truncated"
(https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2); its config
reports `hidden_size=384`, `max_position_embeddings=512`, 6 layers
(https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/config.json).

**EmbeddingGemma (Google).** EmbeddingGemma 1: 308M-parameter multilingual text
embedding model, output dims customizable 768 down to 128 via MRL, 2K-token
context, "Run it on less than 200MB of RAM with quantization", "Low latency:
Generative embeddings in less than 22ms on EdgeTPU". EmbeddingGemma 2: 740M
parameters (text/code variant noted as reduced from 300M to 270M parameters),
unified 768-dim vectors, MRL truncation across 128/256/512/768, up to 8,192
tokens for text.
(https://ai.google.dev/gemma/docs/embeddinggemma)

### Open questions / unverified

- Per-1M-token API cost for Cohere Embed and `gemini-embedding-001` is
  `unverified` (not present on the current first-party pricing pages fetched).
- First-party per-request latency distributions for any hosted embedding API are
  not published (`unverified`).
- OpenAI's embeddings API reference page (batch-size limits, e.g. inputs per
  request) returned HTTP 403 on fetch, so batch limits are `unverified` here.
- Quality impact of `int8`/`binary` compression is stated qualitatively by
  Cohere/Voyage/Mixedbread but no vendor publishes a fixed recall delta for a
  given dataset (`unverified`).

---

## 3. On-device / browser embedding

### What the primary sources say

**Transformers.js runs ONNX models in the browser.** Its README states it "uses
ONNX Runtime to run models in the browser"; by default models run on CPU via
WASM, and `device: 'webgpu'` selects the GPU. Quantization is selected with
`dtype`: typical choices are `"fp32"` (default for WebGPU), `"fp16"`, `"q8"`
(default for WASM), and `"q4"`. Models and precompiled WASM binaries are served
from the HF hub/CDN by default.
(https://github.com/huggingface/transformers.js). The WebGPU guide notes WebGPU
global support "around 85% (according to caniuse.com)" as of March 2026 and
recommends the WASM path otherwise
(https://huggingface.co/docs/transformers.js/guides/webgpu).

**ONNX Runtime Web execution providers.** ORT Web targets `webgpu`, `webnn`,
and `wasm` (alias `cpu`). "All ONNX operators are supported by WASM but only a
subset are currently supported by WebGL, WebGPU and WebNN."
(https://onnxruntime.ai/docs/tutorials/web/,
https://onnxruntime.ai/docs/tutorials/web/build-web-app.html)

**WebGPU and WebNN are W3C Candidate Recommendation Drafts.** WebGPU: W3C
Candidate Recommendation Draft, 15 September 2026
(https://www.w3.org/TR/webgpu/). Web Neural Network API: W3C Candidate
Recommendation Draft, 10 October 2026 (https://www.w3.org/TR/webnn/).

**MediaPipe Text Embedder publishes end-to-end latency.** It supports the
Universal Sentence Encoder and EmbeddingGemma models; EmbeddingGemma uses "Mixed
Precision (int4+int8)" quantization. Task benchmarks (average on Samsung S26
Ultra CPU with 4 threads): Universal Sentence Encoder 10 ms, Embedding Gemma
300m 200 ms. Outputs are embeddings compared with cosine similarity.
(https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder)

**Concrete model artifact sizes (Hugging Face model API).** Retrieved via
`https://huggingface.co/api/models/<id>?blobs=true`:

- `sentence-transformers/all-MiniLM-L6-v2`: `model.safetensors` 90.9 MB,
  `onnx/model.onnx` 90.4 MB, `onnx/model_qint8_avx512.onnx` 23.0 MB,
  `openvino/openvino_model_qint8_quantized.bin` 22.9 MB.
- `BAAI/bge-small-en-v1.5`: `model.safetensors` 133.5 MB, `onnx/model.onnx`
  133.1 MB (no quantized ONNX in the repo at fetch time).
- `nomic-ai/nomic-embed-text-v1.5`: `onnx/model.onnx` 547.3 MB,
  `onnx/model_fp16.onnx` 273.9 MB, `onnx/model_quantized.onnx` 137.3 MB,
  `onnx/model_q4.onnx` 165.1 MB, `onnx/model_q4f16.onnx` 111.1 MB.
- `google/embeddinggemma-300m`: `model.safetensors` 1211.5 MB plus two dense
  heads at 9.4 MB each.
  (https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2,
  https://huggingface.co/api/models/BAAI/bge-small-en-v1.5,
  https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5,
  https://huggingface.co/api/models/google/embeddinggemma-300m)

### Open questions / unverified

- No first-party latency benchmarks for MiniLM/bge/nomic/EmbeddingGemma running
  in transformers.js (WASM or WebGPU) were found; only MediaPipe publishes
  on-device latency (`unverified` for the browser libraries).
- WebGPU/WebNN operator coverage per model is "a subset" but no per-model matrix
  was found (`unverified`).
- Model download/parse time, first-inference compile time, and memory-per-vector
  in the browser are not published by the model repos (`unverified`).
- No primary source states whether transformers.js WebGPU works on non-Chromium
  browsers reliably; the guide itself calls WebGPU "experimental ... especially
  in non-Chromium browsers".

---

## 4. Browser/local vector search and storage

### What the primary sources say

**sqlite-vec.** A pure-C SQLite extension that "runs anywhere SQLite runs
(including in the browser with WASM)"; `vec0` virtual tables store `float`,
`int8`, and `binary` vectors, with metadata columns, partition keys, and
auxiliary columns. Metadata columns are limited to 16 per table and only support
`=`/`!=`/`>`/`>=`/`<`/`<=` comparisons in KNN `WHERE` clauses; partition keys
shard the index and "should be +100's of vectors per unique partition key value";
auxiliary columns cannot appear in KNN `WHERE`. (https://github.com/asg017/sqlite-vec,
https://alexgarcia.xyz/sqlite-vec/features/vec0.html). Binary quantization maps
each float element to one bit; the guide states the 32x size reduction example
(8-dim float32 = 32 bytes vs 1 byte per vector, 32 MB → 1 MB for 1M vectors) and
says "sqlite-vec, which is (currently) brute-force only and meant to run on
small devices"
(https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html). The current
benchmark harness in the repo describes "brute-force baselines (float, int8,
bit), rescore, IVF, and DiskANN index types" and datasets at 1M/10M vectors
(Cohere 768d cosine), with make targets up to 100k vectors
(https://github.com/asg017/sqlite-vec/blob/main/benchmarks-ann/README.md).

**wa-sqlite.** A WebAssembly SQLite build with SQLite virtual filesystems
implemented in JavaScript, enabling IndexedDB and Origin Private File System
(OPFS) storage; it provides synchronous and asynchronous (Asyncify/JSPI) builds
and ships VFS examples including `IDBBatchAtomicVFS`, `IDBMirrorVFS`,
`AccessHandlePoolVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`.
(https://github.com/rhashimoto/wa-sqlite)

**DuckDB / DuckDB-Wasm.** The `vss` extension is "an experimental extension for
DuckDB that adds indexing support ... using ... HNSW (Hierarchical Navigable
Small Worlds)"; indexes are created with `CREATE INDEX ... USING HNSW` and used
for `ORDER BY <distance>(col, const) LIMIT k` (and `min_by`), with `l2sq` the
default metric (https://duckdb.org/docs/current/core_extensions/vss.html).
DuckDB-Wasm is a full DuckDB engine compiled to WebAssembly; "WebAssembly limits
the amount of available memory to 4 GB and browsers may impose even stricter
limits"; extension loading supports "a growing subset of core, community, and
external extensions" and the Wasm sidebar lists VSS among core extensions
(https://duckdb.org/docs/current/clients/wasm/overview.html,
https://duckdb.org/docs/current/clients/wasm/extensions.html).

**Orama.** Described as "a complete search engine and RAG pipeline in your
browser, server or edge network with support for full-text, vector, and hybrid
search in less than 2kb"; vector fields are declared in the schema as
`vector[<size>]` (the README example uses `vector[1536]`). Vector search uses
`mode: 'vector'`, `similarity` defaults to `0.8`, `limit` defaults to 10, and
only one vector property per query is supported at the time of writing. Hybrid
search uses `mode: 'hybrid'` with `hybridWeights` defaulting to `{ text: 0.5,
vector: 0.5 }`. (https://github.com/oramasearch/orama,
https://docs.orama.com/docs/orama-js/search/vector-search,
https://docs.orama.com/docs/orama-js/search/hybrid-search). The Embeddings
plugin "generate[s] embeddings for your documents at insert and search time"
using a TensorFlow.js backend and produces `vector[512]`; the data-persistence
plugin serializes an instance to `"json"` or `"binary"` for restore
(https://docs.orama.com/docs/orama-js/plugins/plugin-embeddings,
https://docs.orama.com/docs/orama-js/plugins/plugin-data-persistence).

**hnswlib-wasm.** WebAssembly bindings for hnswlib that "work in browsers"; it
persists the index through Emscripten's IDBFS (IndexedDB) and documents HNSW
parameter guidance: `M` is "the number of bi-directional links created for every
new element", reasonable range 2–100, and "determines the algorithms memory
consumption, which is roughly M \* 8-10 bytes per stored element".
(https://github.com/shravansunder/hnswlib-wasm)

**USearch.** A single-header C++11 HNSW library with bindings including
JavaScript (Node addon) and a browser build ("the browser build is the C library
compiled with Emscripten"); supports `bf16`, `f16`, `i8`, and single-bit `b1x8`
quantization, and can memory-map/`view` an index from disk. Its published
benchmark (Intel Sapphire Rapids, simplest inner-product distance, "equivalent
recall") reports indexing 100M 96d f32/f16/i8 vectors in 0.3/0.2/0.2 h vs FAISS
2.6/2.6/2.6 h, and 100M 1536d in 2.1/1.1/0.8 h vs 5.0/4.1/3.8 h.
(https://github.com/unum-cloud/usearch,
https://unum-cloud.github.io/USearch/javascript/)

**Voy.** "A WASM vector similarity search engine written in Rust", 75 KB
gzipped, uses a k-d tree; the README states an index update "required to re-build
the index when a resource update occurs", and exposes a portable serialized
index string. (https://github.com/tantaraio/voy)

**vectorlite.** A runtime-loadable SQLite extension backed by hnswlib for Linux
x64, Windows x64, and macOS arm64 (no browser/WASM target documented). The index
"is always held in memory" and must be saved/restored explicitly; saves use a
versioned envelope recording dimension, element type, distance metric,
normalization policy, and endianness. Index files created by hnswlib can be
loaded. (https://github.com/1yefuwang1/vectorlite)

**IndexedDB.** W3C Indexed Database API 3.0 (Working Draft, 2025-08-13/14): a
database maintains indexes over records and allows retrieval by key or index; a
transaction carries a durability hint of `"strict"`, `"relaxed"`, or the user
agent default, where `strict` hints to flush OS I/O buffers before completion.
(https://www.w3.org/TR/IndexedDB/)

### Open questions / unverified

- No first-party browser KNN query-latency or memory numbers for sqlite-vec,
  hnswlib-wasm, Orama, or DuckDB-Wasm-VSS were found (only native USearch and
  the sqlite-vec benchmark harness exist); all browser latency figures are
  `unverified`.
- sqlite-vec's public docs call it brute-force-only while the repo's benchmark
  harness describes IVF/DiskANN; whether ANN index types are shipped/stable in
  the WASM build is `unverified`.
- Browser storage quota behavior for IndexedDB/OPFS is not specified by the
  IndexedDB spec (it defers to storage buckets); no fixed quota is available
  (`unverified`).
- DuckDB-Wasm's supported-extension list was not resolved to an explicit "VSS is
  available in Wasm" statement (`unverified`).
- Orama's vector index structure (brute force vs ANN) is not documented in the
  pages fetched (`unverified`).

---

## 5. Incremental embedding and invalidation

### What the primary sources say

**Pinecone.** "If a record ID already exists, upserting overwrites the entire
record. To change only part of a record, update the record." Namespaces partition
an index and every upsert/query targets one namespace; namespaces are created
implicitly on upsert; per-index namespace limits range "100 on Starter to
1,000,000 on Enterprise". Upsert limits: max batch for records with vectors
1,000 records / 2 MB total, for records with text 96 records, max 2 MB per
document, max filterable metadata 40 KB, max record ID length 512 chars, max
dense dimensionality 20,000. The docs also note `full_text_search` fields are
BM25-scored with tokenization/IDF done at index time.
(https://docs.pinecone.io/guides/index-data/upsert-data,
https://docs.pinecone.io/guides/index-data/indexing-overview)

**pgvector.** Upsert via `INSERT ... ON CONFLICT (id) DO UPDATE SET embedding =
EXCLUDED.embedding`; `UPDATE`/`DELETE` mutate rows directly. HNSW supports an
index built before data ("there isn't a training step like IVFFlat"); index types
and per-type dimension limits are `vector` 2,000, `halfvec` 4,000, `bit` 64,000.
Index maintenance: builds are faster when the graph fits in `maintenance_work_mem`;
"Vacuuming can take a while for HNSW indexes. Speed it up by reindexing first"
(`REINDEX INDEX CONCURRENTLY` then `VACUUM`); create indexes concurrently to
avoid blocking writes. Binary quantization is expression-indexed
(`binary_quantize(embedding)::bit(3)` with `bit_hamming_ops`) with a documented
re-rank step for recall. Hybrid search combines Postgres full-text search
(`plainto_tsquery`, `ts_rank_cd`) with RRF or a cross-encoder.
(https://github.com/pgvector/pgvector)

**Weaviate.** Partial updates (`merge`) replace only specified properties; full
updates replace the object. "If you update the value of a previously vectorized
property, Weaviate re-vectorizes the object automatically. This also reindexes
the updated object. However, if you add a new property to your collection
definition, Weaviate only vectorizes the new objects."
(https://docs.weaviate.io/weaviate/manage-objects/update)

**Qdrant.** A point is a vector plus optional payload; point IDs are 64-bit
unsigned integers or UUIDs. Upsert writes/overwrites points. "Any point
modification operation is asynchronous and takes place in 2 steps. At the first
stage, the operation is written to the Write-ahead-log. After this moment, the
service will not lose the data, even if the machine loses power supply." Payload
indexes must generally be created before ingesting data for filter-aware HNSW
edges, and adding one later requires rebuilding the HNSW index.
(https://qdrant.tech/documentation/manage-data/points/,
https://qdrant.tech/documentation/concepts/indexing/)

**LanceDB.** Versioning: "When you modify data through operations like update or
delete, LanceDB automatically creates new versions"; it supports rollback to any
previous version "without data duplication", version tags, and restoring
snapshots. Row changes use `update(where=..., values=...)` for SQL-filtered
edits, or `merge_insert(...)`: `.when_matched_update_all()` updates existing keys,
`.when_matched_update_all() + .when_not_matched_insert_all()` is "often called
upsert", and `.when_not_matched_by_source_delete(...)` removes target rows
missing from the source.
(https://www.lancedb.com/docs/tables/versioning/,
https://lancedb.com/docs/tables/update/)

### Open questions / unverified

- No first-party documentation of content-hash-based change detection,
  debouncing, or chunk-level versioning was found in any of these vector stores;
  those are application-level concerns (`unverified`).
- Embedding-model migration / full re-embed is not documented as a first-class
  feature by Pinecone/pgvector/Weaviate/Qdrant/LanceDB (`unverified`).
- The cost/behavior of HNSW deletes and re-inserts over time (graph degradation)
  is described only qualitatively by pgvector/Weaviate ("cleanup is async" for
  Weaviate) (`unverified` for quantitative behavior).

---

## 6. Hybrid retrieval: lexical + vector, fusion, reranking

### What the primary sources say

**Elasticsearch RRF.** RRF combines result sets using
`score += 1.0 / ( k + rank(result(q), d) )`; `k` (`rank_constant`) "must be
greater than or equal to 1. Defaults to 60"; `rank_window_size` "Defaults to the
`size` parameter" and must be ≥ `size`. The `rrf` retriever requires at least two
child retrievers and gives each equal weight; RRF "requires no tuning".
(https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)

**OpenSearch.** Hybrid search is implemented with a search pipeline. Two
processors are documented: a score-based `normalization-processor` (example uses
`min_max` normalization + `arithmetic_mean` combination with explicit `weights`)
and a rank-based `score-ranker-processor` that "uses reciprocal rank fusion (RRF)
to combine documents according to their position in each query clause's results".
(https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/)

**Qdrant.** Prefetches run sub-queries and a main query combines them. Fusion is
`rrf` or `dbsf`. The documented RRF score is
`score(d) = Σ 1/(k + (r_d + 1)/w_r − 1)`, which simplifies to `Σ 1/(k + r_d)`
when weights `w_r` default to 1.
(https://qdrant.tech/documentation/concepts/hybrid-queries/)

**Weaviate.** "Hybrid search combines the results of a vector search and a
keyword (BM25F) search by fusing the two result sets." `alpha` controls weighting
("Alpha of 0 is pure keyword search, 1 is pure vector search"; docs example uses
0.5). "Relative Score Fusion is the default fusion method starting in v1.24";
`Ranked` (rank-based) fusion is also available.
(https://docs.weaviate.io/weaviate/search/hybrid)

**Vespa.** Its hybrid-search tutorial combines BM25 (`enable-bm25`, summing
`bm25(title) + bm25(text)`) with a `nearestNeighbor` tensor search (384-dim
embedding) under separate rank profiles, and notes lexical retrieval, vector
retrieval, and multi-phase ranking as separate concerns.
(https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html)

**pgvector.** Documents hybrid search using Postgres full-text search plus
either Reciprocal Rank Fusion or a cross-encoder
(https://github.com/pgvector/pgvector).

**Cohere Rerank.** Given a query and a list of documents, Rerank returns the
documents ordered by semantic relevance (example returns `relevance_score` per
`index`). Rerank model table: `rerank-v3.5`, `rerank-english-v3.0`, and the
multilingual reranker have a 4,096-token context; "Rerank will automatically
chunk documents longer than 510 tokens, and there is therefore no explicit limit
to how long a document can be when using rerank." Rerank pricing:
Separately, Voyage's own rerankers are priced at `rerank-3` $0.05/1M tokens
and `rerank-3-lite` $0.02/1M.
(https://docs.cohere.com/docs/rerank-overview,
https://docs.cohere.com/docs/models, https://docs.voyageai.com/docs/pricing)

### Open questions / unverified

- No primary source prescribes a single `k` for RRF beyond Elasticsearch's
  default 60; Qdrant's and Weaviate's defaults are documented separately and no
  cross-vendor equivalence is asserted (`unverified`).
- BM25 implementations for in-browser use (tokenization, IDF, normalization) are
  documented by Pinecone's server-side full-text search and OpenSearch, but no
  first-party browser BM25 library guidance was found (`unverified`).
- Reranker latency for on-device/cross-encoder rerankers is not published by
  Cohere (`unverified`).
- Vectara hybrid search was not fetched; no claims made here.

---

## 7. Sync / offline architecture and CRDT/rich-text search

### What the primary sources say

**PowerSync.** "App clients always read data from the client-side SQLite
database, regardless of whether the user is online or offline." The client SDK
is embedded in the app and manages a SQLite database kept in sync with the
backend; schema tables are exposed as SQLite views over schemaless JSON
(`ps_data__<table>`, local-only `ps_data_local__<table>`, operation history
`ps_oplog`), with a "Raw Tables" escape hatch for real SQLite tables. Mutations
are applied locally and put in an upload queue that retries automatically across
network failures.
(https://docs.powersync.com/architecture/client-architecture)

**ElectricSQL.** "Electric Sync is a read-path sync engine for Postgres. It syncs
data out of Postgres into local clients over HTTP using a primitive called a
Shape." It recommends PGlite — "embeddable Postgres for the browser, Node.js,
and edge" — as the local store.
(https://electric-sql.com/docs/sync)

**TinyBase.** "A reactive in-memory data store with persistence and
synchronization for local-first JavaScript and TypeScript apps"; persistence is
provided by persister modules (browser, SQLite, PostgreSQL, or file) and sync by
`createMergeableStore` + a `Synchronizer`. It is explicitly "not a hosted
database service."
(https://tinybase.org/llms.txt, https://tinybase.org/guides/persistence/)

**sqlite-vec runs in the browser via WASM**, so vectors can be stored in the
same local SQLite database that powers offline reads (see §4)
(https://github.com/asg017/sqlite-vec).

**CRDT document models.** Yjs "exposes its internal CRDT model as shared data
types"; document updates are encoded/merged with `Y.encodeStateAsUpdate` and can
be persisted via providers/central databases
(https://docs.yjs.dev/). Automerge documents are JSON-like (root map of
maps/lists/text/counters); "Text is an implementation of the peritext CRDT ...
conceptually similar to a list where each element is a single unicode scalar
value" (https://automerge.org/docs/reference/documents/).

**IndexedDB durability.** Transactions carry a durability hint (`strict`,
`relaxed`, or default); `strict` hints that OS I/O buffers be flushed before the
transaction is considered complete (https://www.w3.org/TR/IndexedDB/).

### Open questions / unverified

- No first-party guidance was found on a decision rule for computing embeddings
  on-device vs syncing precomputed vectors as data — for ebb or for any of the
  local-first stacks surveyed (`unverified`).
- No first-party guidance was found on searching CRDT/rich-text documents
  (materializing text, index granularity, invalidation on merge). Yjs and
  Automerge document the data model and update encoding but not search/indexing
  (`unverified`).
- PowerSync and ElectricSQL do not document vector-search/embedding support;
  whether their embedded SQLite can load the sqlite-vec extension is not stated
  by them (`unverified`).
- ElectricSQL's docs describe sync and local store, not embedding computation
  (`unverified`).

---

## Concrete numbers

| Fact                                                                               | Value                                                                                                                     | Source                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI `text-embedding-3-small` dims / max input / price                           | 1536 (default) / 8192 docs (8191 cookbook) / $0.02 per 1M tokens                                                          | https://platform.openai.com/docs/guides/embeddings ; https://platform.openai.com/docs/pricing ; https://github.com/openai/openai-cookbook/blob/main/examples/Embedding_long_inputs.ipynb                                                                                                                          |
| OpenAI `text-embedding-3-large` dims / max input / price                           | 3072 (default) / 8192 docs (8191 cookbook) / $0.13 per 1M tokens                                                          | same as above                                                                                                                                                                                                                                                                                                     |
| OpenAI `text-embedding-ada-002` dims / price                                       | 1536 / $0.10 per 1M tokens                                                                                                | https://platform.openai.com/docs/pricing                                                                                                                                                                                                                                                                          |
| Cohere `embed-v5.0-pro` dims / context                                             | 256–2048 (default 2048) / 128k tokens                                                                                     | https://docs.cohere.com/docs/models                                                                                                                                                                                                                                                                               |
| Cohere `embed-english-v3.0` dims / context                                         | 1024 / 512 tokens                                                                                                         | https://docs.cohere.com/docs/models                                                                                                                                                                                                                                                                               |
| Cohere compression types                                                           | float, int8, uint8, binary, ubinary (binary packed at dims/8 bytes)                                                       | https://docs.cohere.com/docs/embeddings                                                                                                                                                                                                                                                                           |
| Voyage `voyage-4` dims / context / price                                           | 1024 default (256/512/2048) / 32,000 tokens / $0.06 per 1M                                                                | https://docs.voyageai.com/docs/embeddings ; https://docs.voyageai.com/docs/pricing                                                                                                                                                                                                                                |
| Voyage `voyage-4-lite` price / free tier                                           | $0.02 per 1M / first 200M tokens free                                                                                     | https://docs.voyageai.com/docs/pricing                                                                                                                                                                                                                                                                            |
| Gemini `gemini-embedding-2` dims / input / price                                   | 128–3072 (rec. 768/1536/3072) / 8,192 tokens / $0.20 per 1M text (batch $0.10)                                            | https://ai.google.dev/gemini-api/docs/embeddings ; https://ai.google.dev/gemini-api/docs/pricing                                                                                                                                                                                                                  |
| Gemini `gemini-embedding-001` dims / input                                         | 128–3072 / 2,048 tokens                                                                                                   | https://ai.google.dev/gemini-api/docs/embeddings                                                                                                                                                                                                                                                                  |
| Gemini Embedding 001 MTEB at 128–2048 dims                                         | 63.31 / 66.19 / 67.55 / 67.99 / 68.17 / 68.16                                                                             | https://ai.google.dev/gemini-api/docs/embeddings                                                                                                                                                                                                                                                                  |
| `nomic-embed-text-v1.5` dims / seq len / MRL MTEB                                  | 768 / 8192 / 62.28 (768), 61.96 (512), 61.04 (256), 59.34 (128), 56.10 (64)                                               | https://huggingface.co/nomic-ai/nomic-embed-text-v1.5                                                                                                                                                                                                                                                             |
| `bge-small-en-v1.5` dims / seq len / avg MTEB                                      | 384 / 512 / 62.17                                                                                                         | https://huggingface.co/BAAI/bge-small-en-v1.5                                                                                                                                                                                                                                                                     |
| `mxbai-embed-large-v1` dims / seq len                                              | 1024 / 512                                                                                                                | https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/raw/main/config.json                                                                                                                                                                                                                                    |
| `all-MiniLM-L6-v2` dims / truncation                                               | 384 / 256 word pieces                                                                                                     | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2                                                                                                                                                                                                                                                     |
| EmbeddingGemma 1 params / dims / context / RAM / EdgeTPU latency                   | 308M / 768→128 MRL / 2K tokens / <200 MB quantized / <22 ms                                                               | https://ai.google.dev/gemma/docs/embeddinggemma                                                                                                                                                                                                                                                                   |
| EmbeddingGemma 2 params / dims / context                                           | 740M / 768 (MRL 128–768) / 8,192 tokens                                                                                   | https://ai.google.dev/gemma/docs/embeddinggemma                                                                                                                                                                                                                                                                   |
| On-device model latency (MediaPipe, S26 Ultra CPU 4 threads)                       | USE 10 ms; Embedding Gemma 300m 200 ms                                                                                    | https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder                                                                                                                                                                                                                                                 |
| ONNX model sizes: MiniLM qint8 / bge-small fp32 / nomic int8 / EmbeddingGemma fp32 | ~23 MB / ~133 MB / ~137 MB / ~1212 MB                                                                                     | https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2?blobs=true ; https://huggingface.co/api/models/BAAI/bge-small-en-v1.5?blobs=true ; https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5?blobs=true ; https://huggingface.co/api/models/google/embeddinggemma-300m?blobs=true |
| WebGPU browser support                                                             | ~85% globally, March 2026 (caniuse, cited by HF)                                                                          | https://huggingface.co/docs/transformers.js/guides/webgpu                                                                                                                                                                                                                                                         |
| Default chunk size / overlap: LangChain                                            | 4000 / 200 characters                                                                                                     | https://github.com/langchain-ai/langchain/blob/master/libs/text-splitters/langchain_text_splitters/base.py                                                                                                                                                                                                        |
| Default chunk size / overlap: LlamaIndex                                           | 1024 / 20 tokens (SentenceSplitter sentence overlap 200)                                                                  | https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/constants.py                                                                                                                                                                                                                 |
| Pinecone suggested chunk-size range to test                                        | 128 or 256 (granular) and 512 or 1024 (context) tokens                                                                    | https://www.pinecone.io/learn/chunking-strategies/                                                                                                                                                                                                                                                                |
| Elasticsearch RRF `rank_constant` default                                          | 60                                                                                                                        | https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion                                                                                                                                                                                                                              |
| Weaviate hybrid `alpha` / default fusion                                           | alpha 0 keyword … 1 vector; Relative Score Fusion default since v1.24                                                     | https://docs.weaviate.io/weaviate/search/hybrid                                                                                                                                                                                                                                                                   |
| Orama vector `similarity` default / hybrid weights default                         | 0.8 / text 0.5, vector 0.5                                                                                                | https://docs.orama.com/docs/orama-js/search/vector-search ; https://docs.orama.com/docs/orama-js/search/hybrid-search                                                                                                                                                                                             |
| sqlite-vec metadata columns / BQ size reduction                                    | max 16 metadata columns / 32x (32 MB → 1 MB per 1M 8-dim vectors)                                                         | https://alexgarcia.xyz/sqlite-vec/features/vec0.html ; https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html                                                                                                                                                                                                 |
| hnswlib-wasm HNSW memory per element                                               | roughly `M * 8–10` bytes (M range 2–100)                                                                                  | https://github.com/shravansunder/hnswlib-wasm                                                                                                                                                                                                                                                                     |
| USearch 100M-vector index build time (96d / 1536d)                                 | 0.3–0.2 h / 2.1–1.1–0.8 h (f32/f16/i8), vs FAISS 2.6 h / 5.0–4.1–3.8 h                                                    | https://github.com/unum-cloud/usearch                                                                                                                                                                                                                                                                             |
| DuckDB-Wasm memory limit                                                           | 4 GB (WASM), browsers may be stricter                                                                                     | https://duckdb.org/docs/current/clients/wasm/overview.html                                                                                                                                                                                                                                                        |
| Pinecone upsert limits                                                             | 1,000 records/2 MB (vectors); 96 records (text); 2 MB/document; 40 KB filterable metadata; 512-char ID; 20,000 dense dims | https://docs.pinecone.io/guides/index-data/upsert-data                                                                                                                                                                                                                                                            |
| pgvector dimension limits per type                                                 | `vector` 2,000; `halfvec` 4,000; `bit` 64,000                                                                             | https://github.com/pgvector/pgvector                                                                                                                                                                                                                                                                              |
| Cohere Rerank context / auto-chunk threshold                                       | 4,096 tokens / documents >510 tokens are auto-chunked                                                                     | https://docs.cohere.com/docs/models                                                                                                                                                                                                                                                                               |
| Voyage rerank pricing                                                              | `rerank-3` $0.05 per 1M tokens; `rerank-3-lite` $0.02 per 1M                                                              | https://docs.voyageai.com/docs/pricing                                                                                                                                                                                                                                                                            |
