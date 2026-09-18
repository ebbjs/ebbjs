---
title: "The Client"
description: "The ORM, materialized cache, querying, writing, and reactivity."
---

> **Note — Forward-looking API outline.** This document describes the planned `@ebbjs/client` SDK. **The package is currently a stub** (`export {};`) — none of the API described here exists yet. The backing pieces are ready to build on: `@ebbjs/core` (types, HLC, msgpack, action creation) and `@ebbjs/storage` (the `StorageAdapter` interface with an in-memory implementation that already supports lazy entity materialization on Action append). The sync client (handshake / catch-up / SSE), outbox, and query API are the next major piece of work.

`@ebbjs/client` is the primary interface for building Ebb applications. It manages the local materialized cache, provides an ORM for querying data, and exposes convenience methods for writing and updating Entities.

## Materialized cache

The client maintains a materialized view of all Entities the user has access to. This cache is kept up to date automatically—when [Actions](/docs/v1-target/data-model) arrive via [sync](/docs/v1-target/sync) or are written locally (optimistically), their Updates are applied to the cache immediately. Queries always run against this cache, so reads are fast and fully offline-capable.

## Querying

The ORM provides a query API for fetching Entities by type, filtering by field values, traversing [Relationships](/docs/v1-target/relationships), and more. Queries return materialized Entity data from the local cache. Details on the query API are covered in the `@ebbjs/client` documentation.

## Writing data

The client provides convenience methods for creating, updating, and deleting Entities. These methods handle the details of constructing Actions (with their Updates), writing to the [Outbox](/docs/v1-target/sync#client-to-server-writes), and optimistically applying changes to the local cache. Multi-entity operations are naturally supported since Actions can contain any number of Updates.

## Reactivity

The client exposes primitives for observing changes to the materialized cache. When an Entity changes—whether from a local write or an incoming synced Action—observers are notified.

These primitives are low-level by design. Framework-specific packages like `@ebbjs/react` build on top of them to provide idiomatic bindings—hooks that automatically re-render components when the data they depend on changes.

## Server package

> **Note:** `@ebbjs/server` (the TS package) is currently just an E2E test harness that spawns the Elixir release and exposes a `seed()` helper. The server runtime itself is the **`ebb_server/`** Elixir/OTP application — see [Server Design](https://github.com/ebbjs/ebbjs/blob/main/docs/ebb_server/README.md).
