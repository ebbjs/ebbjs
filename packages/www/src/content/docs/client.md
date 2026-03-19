---
title: "The Client"
description: "The ORM, materialized cache, querying, writing, and reactivity."
---

`@ebbjs/client` is the primary interface for building Ebb applications. It manages the local materialized cache, provides an ORM for querying data, and exposes convenience methods for writing and updating Entities.

## Materialized cache

The client maintains a materialized view of all Entities the user has access to. This cache is kept up to date automatically—when [Actions](/docs/data-model) arrive via [sync](/docs/sync) or are written locally (optimistically), their Updates are applied to the cache immediately. Queries always run against this cache, so reads are fast and fully offline-capable.

## Querying

The ORM provides a query API for fetching Entities by type, filtering by field values, traversing [Relationships](/docs/relationships), and more. Queries return materialized Entity data from the local cache. Details on the query API are covered in the `@ebbjs/client` documentation.

## Writing data

The client provides convenience methods for creating, updating, and deleting Entities. These methods handle the details of constructing Actions (with their Updates), writing to the [Outbox](/docs/sync#client-to-server-writes), and optimistically applying changes to the local cache. Multi-entity operations are naturally supported since Actions can contain any number of Updates.

## Reactivity

The client exposes primitives for observing changes to the materialized cache. When an Entity changes—whether from a local write or an incoming synced Action—observers are notified.

These primitives are low-level by design. Framework-specific packages like `@ebbjs/react` build on top of them to provide idiomatic bindings—hooks that automatically re-render components when the data they depend on changes.

## Server package

`@ebbjs/server` provides the server-side runtime—handling sync connections, [permission enforcement](/docs/permissions), Action validation, and server-to-server replication. It builds on `@ebbjs/db` for storage and materialization.
