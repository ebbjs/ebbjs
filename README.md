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
> **Pre-alpha.** Ebb is under active development and not yet ready for production use. Follow along on the [devlog](https://ebb.dev/devlog) or check the [roadmap](#roadmap) to see where things stand.

Ebb is an open-source, local-first backend framework. Every client gets a local replica for instant reads, optimistic writes, and full offline support. Changes sync to all connected users in real-time with conflict resolution, presence, and multiplayer built in. The server is self-hostable — deploy to a VPS or run it on bare metal.

## Project Goals

- **Incredible DX** — A declarative, type-safe API that helps humans and agents get things right the first time. Define your data model, query with a type-safe ORM, react when data changes.
- **Fully open source** — No vendor lock-in. Designed to self-host from day one. Run the full stack with a single Docker image.
- **Fast, reactive, and multiplayer** — Data lives on the device, can be edited offline, and stays in sync with others. No polling, no spinners, no plumbing.

## Packages

| Package         | Description                                              |
| --------------- | -------------------------------------------------------- |
| `@ebbjs/core`   | Schema definition, data model, and shared types          |
| `@ebbjs/client` | Local-first client with offline writes, outbox, and sync |
| `@ebbjs/react`  | React hooks for reactive, type-safe data access          |
| `@ebbjs/server` | Server function runtime (`defineFunction`)               |
| `@ebbjs/yjs`    | Yjs integration for collaborative text fields            |
| `@ebbjs/db`     | Local SQLite storage adapter                             |
| `ebb_server/`   | Elixir sync/storage server (RocksDB + SQLite + OTP)      |

## Roadmap

### Shipped

- End-to-end prototype — local-first writes, sync, and materialization working across client and server

### In Progress

- Core storage engine (RocksDB + dual-writer pipelining + on-demand materialization)
- Sync protocol (handshake, per-group catch-up, live SSE)
- Client SDK (offline writes, outbox, conflict resolution)

### Planned

- Auth and group-based permissions
- React bindings (`useQuery`, `useClient`, `EbbProvider`)
- Server functions (`defineFunction` with deploy/version/rollback)
- Real-time presence
- Collaborative text (Yjs)
- Server-side SDK for SSR frameworks and external processes
- Self-hosting (single Docker image)
- CLI tooling (deploy, migrations, scaffolding)
- Observability hooks (`onAction` for analytics, audit logs, webhooks)
- Horizontal scaling (multi-master replication)

See the full roadmap at [ebb.dev](https://ebb.dev).
