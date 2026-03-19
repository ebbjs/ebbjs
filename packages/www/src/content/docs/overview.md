---
title: "Ebb Overview"
description: "Why ebb exists and what it gives you."
---

## Why?

Ebb was born because building a collaborative, offline-capable app was way too hard.

I wanted to build a simple notes app. Users create notes, edit them, share with others. Write while they're on a plane and sync back when they touch down. Collaborative in real-time with awareness and presence.

How hard could it be?

I looked at the existing [local-first landscape](https://www.localfirst.fm/landscape). There were tools designed for exactly this problem — but none of them fit.

PouchDB/CouchDB was the original offline sync stack, but it felt legacy. Non-relational, and on the client you were locked into IndexedDB. RxDB closed some of those gaps, but advanced features required a paid license and the developer experience was complicated. Basic.tech and Jazz were interesting newer projects, but they locked you into idealistic paradigms — federated identity or mandatory end-to-end encryption — that come with their own tradeoffs and perils. And everything else — Zero, Convex, and others — had great developer experience but simply didn't support offline writes.

So I started building my own sync engine on top of ElectricSQL — a custom outbox, a push server, conflict resolution, permission enforcement. Months in, I was deep in distributed systems plumbing and hadn't shipped a single feature of the actual notes app. It shouldn't be this hard.

This is the reality of local-first development today. The ecosystem is growing, but the options that support true offline writes either lock you into non-relational data models, charge for essential features, impose opinionated paradigms about how software should work, or simply don't exist yet. And if you try to assemble the pieces yourself, you end up building a distributed system from scratch. The moment you need clients to be autonomous — reading, writing, and resolving conflicts without a server in the loop — you're on your own.

Ebb exists because that's absurd. Every offline-capable app needs the same set of hard primitives: sync, conflict resolution, permissions, schema evolution, garbage collection. These are solved problems — they just haven't been packaged as tightly integrated primitives.

Ebb packages them so you can write application logic instead of infrastructure.

## How?

Ebb gives you a complete stack for building local-first applications:

- **`@ebbjs/db`** — A relational data model built on SQLite (server) and pluggable storage (client) that handles offline writes, partial replication, and eventual consistency out of the box.
- **`@ebbjs/client`** — An ORM and sync client that manages your local data, optimistically applies writes, and keeps everything in sync — online or off.
- **`@ebbjs/server`** — The server runtime that handles sync connections, permission enforcement, Action validation, and server-to-server replication.
- **`@ebbjs/react`** — React bindings that make your UI reactive to data changes with zero boilerplate.

Define your models once. Ebb handles syncing them across every node in your system, enforcing permissions, detecting and surfacing conflicts, evolving your schema, and cleaning up after itself.

## Under the hood

The rest of these docs explain how Ebb works — the data model, sync protocol, permission system, and everything else that makes the above possible.

- [The Data Model](/docs/data-model) — Entities, Actions, Updates, Snapshots, entity formats, and materialization.
- [Relationships](/docs/relationships) — How Entities relate to each other.
- [Groups, Membership & Actors](/docs/groups) — Permission boundaries, identity, and access control primitives.
- [Hybrid Logical Clocks](/docs/clock) — How Ebb orders events across distributed nodes.
- [Sync Protocol](/docs/sync) — Replication, catch-up, subscription, and the Outbox.
- [Permission Enforcement](/docs/permissions) — How permissions are checked on client and server.
- [The Client](/docs/client) — The ORM, materialized cache, querying, and reactivity.
- [Conflict Resolution](/docs/conflicts) — Why CRDTs aren't enough and how Ebb handles conflicts.
- [Garbage Collection](/docs/garbage-collection) — Tombstones, compaction, and retention.
- [Schema Evolution](/docs/schema-evolution) — Versioning, migrations, and breaking changes.
- [Observability & Analytics](/docs/observability) — Metrics, the onAction handler, and application analytics.
