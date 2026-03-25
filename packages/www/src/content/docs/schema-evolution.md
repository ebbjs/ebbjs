---
title: "Schema Evolution"
description: "Versioning, migrations, and breaking changes."
---

In a distributed system with offline clients, schema changes are tricky. A client might be offline when you deploy a new schema, then come back online with pending [Actions](/docs/data-model) written against the old structure.

Ebb takes a primitives-based approach: it provides the tools to handle schema evolution, but doesn't enforce a rigid migration system.

## Schema versions

Each entity type declares a version number. When the client materializes an entity, it checks the version and runs migration functions to transform old data into the current shape.

These are "up" migrations only—transforming old data to new. There are no "down" migrations.

## Reading old data

When you change your schema (e.g., rename `name` to `firstName` + `lastName`), old entities still have the old fields. The ORM's migration function handles this on read—for example, splitting `name` into `firstName` and `lastName` if the new fields don't exist.

The update log stays untouched—migrations only affect the materialized view.

## Writing backward-compatible updates

If you need old clients (on v1) to see data written by new clients (on v2), write updates that populate both old and new fields. For example, a v2 client writing `firstName`, `lastName`, _and_ `name` so v1 clients can still read the combined name.

This is a discipline choice, not something Ebb enforces. If you don't need backward compatibility, just write the new fields.

## Breaking changes

Sometimes backward compatibility isn't worth the effort. For breaking changes, you can configure a minimum supported schema version. Clients below this version receive an "update required" message during [sync](/docs/sync) and cannot proceed until they upgrade.

## What Ebb provides

- Schema version on entity types
- Migration functions (up only) to transform old data on read
- Optional minimum supported version for breaking changes

## What Ebb doesn't do

- Down migrations
- Automatic field aliasing or coercion
- Version-aware storage (the update log is schema-agnostic)

This keeps the storage and sync layer simple while giving developers the tools to handle schema evolution in whatever way fits their application.
