<p align="center">
  <img src="packages/www/public/github-avatar.svg" width="80" height="80" alt="ebb logo" />
</p>

<h1 align="center">ebb</h1>

<p align="center">Build apps that are fast, work offline, and just sync.</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="Status: pre-alpha" />
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0" /></a>
  <a href="https://ebbjs.com"><img src="https://img.shields.io/badge/website-ebbjs.com-stone" alt="Website" /></a>
</p>

---

> [!WARNING]
> **Pre-alpha.** Ebb is under active development and not yet ready for production use. The marketing copy below describes the *target* product. **See [Current State](#current-state) below for what's in the repo today.**

Ebb is an open-source, local-first backend framework. Every client gets a local replica for instant reads, optimistic writes, and full offline support. Changes sync to all connected users in real-time with conflict resolution, presence, and multiplayer built in. The server is self-hostable — deploy to a VPS or run it on bare metal.

## Project Goals

- **Incredible DX** — A declarative, type-safe API that helps humans and agents get things right the first time. Define your data model, query with a type-safe ORM, react when data changes.
- **Fully open source** — No vendor lock-in. Designed to self-host from day one. Run the full stack with a single Docker image.
- **Fast, reactive, and multiplayer** — Data lives on the device, can be edited offline, and stays in sync with others. No polling, no spinners, no plumbing.

## Current State

What's actually in the repo today (last meaningful server work: Apr 2026; last commit: Jun 2026).

| Area | State | Notes |
|---|---|---|
| Elixir sync server (`ebb_server/`) | **Working** | RocksDB action log, single Writer GenServer, on-demand SQLite materialization, permissions, handshake, SSE live sync, paginated catch-up, presence broadcast. Slices 1–4 of the [server design](docs/ebb_server/README.md) are complete. |
| `@ebbjs/core` | **Working** | TypeBox schemas, HLC implementation, MessagePack codec, `createAction`, ID generation. 97 tests pass. |
| `@ebbjs/storage` | **Working** | In-memory `StorageAdapter`: ActionLog, DirtyTracker, EntityStore (lazy materialization, HLC + lexicographic tiebreak), CursorStore. 43 tests pass. |
| `@ebbjs/server` (TS) | **Harness only** | Spawns the Elixir release as a child process and exposes a `seed()` helper for E2E tests. One e2e test (handshake). |
| `@ebbjs/client` | **Stub** | `export {};`. The local-first sync client, outbox, and query layer are the next major piece. The storage adapter is ready to back them. |
| Auth & permissions | **Working** | `AuthPlug` (bypass + external modes), Group/GroupMember/Relationship system entities, in-memory permission checks. |
| Self-hosting (Docker) | **Working** | `Dockerfile` in `ebb_server/`; server boots via `mix release`. |
| Real-time presence | **Working** | `POST /sync/presence` endpoint and fan-out path are wired and tested. |
| React bindings | **Not started** | No `@ebbjs/react` package. The docs in `packages/www/src/content/docs/` describe the target API. |
| Server functions | **Not started** | Slice 5 spec exists; would run on a separate Bun runtime. |
| Collaborative text | **In design** | No Yjs. The plan is causal-tree over existing Action/Update primitives using HLC ordering (see the [April 2026 devlog](packages/www/src/content/devlog/how-collaborative-editing-works.mdx)). A POC using BroadcastChannel lives in `experiment/collaborative-text/`. |
| CLI tooling | **Not started** | |
| Observability hooks | **Partial** | Telemetry events are wired through server components; no developer-facing `onAction` hook. |
| Peer replication | **Not started** | Slice 6 design exists; no implementation. |

For a more detailed breakdown, see [`docs/ebb_server/README.md`](docs/ebb_server/README.md) (server) and [`docs/packages/`](docs/packages/) (TS packages).

## Packages

| Package | Description | State |
|---|---|---|
| `@ebbjs/core` | TypeBox schemas, HLC, MessagePack codec, `createAction` helper. | Working |
| `@ebbjs/storage` | `StorageAdapter` interface + in-memory implementation (ActionLog, DirtyTracker, EntityStore, CursorStore). | Working |
| `@ebbjs/server` (TS) | E2E test harness — spawns the Elixir release, `seed()` helper for fixtures. | Working |
| `ebb_server/` | Elixir/OTP sync server: RocksDB action log, SQLite materialization, HTTP API, SSE fan-out, permissions, presence. | Working |
| `@ebbjs/client` | Local-first sync client (handshake, SSE, catch-up, outbox, queries). | Stub |

React bindings (`@ebbjs/react`), a Bun-based server-function runtime, and a CLI are not in the repo yet but are described in the public docs as the planned v1 surface.

## Roadmap

### Shipped

- Core storage engine — RocksDB action log (single Writer GenServer, `enable_pipelined_write: true` on the DB), on-demand SQLite materialization. A 2-writer pipelined benchmark hit ~108k Actions/sec with full durability (see [devlog](packages/www/src/content/devlog/a-rocksdb-solid-start.md)); production currently runs 1 Writer.
- Sync protocol — handshake, per-group paginated catch-up, live SSE streaming, watermark-gated fan-out
- Auth & group-based permissions — `AuthPlug` (bypass + external modes), in-memory Group/GroupMember/Relationship cache
- Real-time presence — ephemeral broadcasts via `POST /sync/presence`, fanned out over SSE
- Self-hosting — single `Dockerfile`, `mix release` boot

### In Progress

- **Client SDK** (`@ebbjs/client`) — handshake/catch-up/SSE wiring, outbox, query layer, optimistic writes. The storage adapter and core types are ready to back this.
- Observability hooks — telemetry is wired; developer-facing `onAction` hook is the next step.

### Planned

- Causal-tree collaborative text (over existing Action/Update primitives, **not** Yjs — see [devlog](packages/www/src/content/devlog/how-collaborative-editing-works.mdx))
- React bindings (`@ebbjs/react`) — `useQuery`, `useClient`, `EbbProvider`
- Server functions (`defineFunction`) — requires a Bun runtime alongside the Elixir server
- Server-side SDK for SSR frameworks and external processes
- CLI tooling — `ebb deploy`, function management, schema migrations, scaffolding
- Horizontal scaling — multi-master peer replication (slice 6 design exists)

See the website [roadmap](https://ebb.dev/#roadmap) for the marketing-facing version of this list.

## Repository Layout

```
packages/
  core/      # @ebbjs/core — schemas, HLC, msgpack
  storage/   # @ebbjs/storage — adapter interface + memory implementation
  server/    # @ebbjs/server (TS) — e2e test harness
  client/    # @ebbjs/client — stub; will hold the sync client SDK
  www/       # Astro docs site
ebb_server/  # Elixir sync server (RocksDB + SQLite + OTP)
experiment/  # Proof-of-concept code (e.g., collaborative-text)
docs/        # Architecture specs, package docs, scratch notes
  ebb_server/  # Server design: components, slices 1-6, tasks
  packages/    # TS package docs
  scratch/     # Working drafts — not authoritative
  devlog/      # Draft devlog posts (unpublished)
```