---
title: "Why Groups"
description: "I almost removed Groups from Ebb's data model. Here's why I kept them."
date: 2026-03-22
---

## Outline

### The question

- Started questioning whether Groups, GroupMembers, and Permissions need to be first-class primitives
- Alternative: let developers model their own authorization using regular Entities
- Entity-Actor-Action is the core — do we need more than that?

### What Groups currently do

- **Sync boundaries**: Groups determine what data syncs to which clients
- **Permission scope**: GroupMembers carry permissions arrays that gate writes
- **Server-side enforcement**: Elixir checks permissions in-memory (ETS cache) before routing to Writer — zero network hops, zero SQLite reads

### The alternative I considered

**For permissions:** Move enforcement to a developer-controlled proxy

- Proxy receives write request
- Proxy runs custom authorization logic (reading from its own DB or Ebb)
- Proxy forwards to Ebb if allowed
- Cost: network hop on every write, throughput degradation

**For sync boundaries:** "Subscribed queries" — each client declares what it wants

- "All entities I created"
- "All entities related to entity X"
- "All entities matching condition Y"
- Server evaluates queries at sync-time, pushes matching Actions

### Why subscribed queries are expensive

- Current model: O(1) lookup per Action ("which Groups does this Entity belong to?")
- Query model: potentially O(clients) per Action (re-evaluate each client's query)
- Groups are essentially **pre-computed query results** — the computation happens at write-time (assigning membership), not sync-time
- Subscribed queries flip this: more flexibility, but complexity moves to the hot path

### The insight

Most real-world sync boundaries are group-shaped:

- "Everything in this workspace" — Group
- "Everything in this project" — Group
- "Everything I own" — personal Group
- "This document and its contents" — Group per document root
- "Everything shared with me" — membership in others' Groups

Even social graph patterns ("posts from people I follow") often materialize as a computed "feed" — which is group-shaped.

### What might not fit

- Highly dynamic computed access ("sync if X and Y and Z are true right now")
- Fine-grained per-entity ACLs that don't cluster into natural boundaries
- Complex graph traversals as sync boundaries

But these are edge cases, not the 80% use case.

### The decision

Groups stay. Here's why:

1. **Performance**: In-memory permission checks (ETS) with zero network hops
2. **Simplicity**: Fan-out is O(1) lookup, not query evaluation
3. **Atomicity**: Permission checks happen in the same process as the write — no TOCTOU races
4. **The 80% case**: Most collaborative apps have natural group boundaries anyway

Ebb isn't trying to be infinitely flexible. It's trying to make the common case fast and correct. Groups are that common case, built in.

---

## Notes from exploration

- Groups are pre-computed query results for sync boundaries
- The subscribed query model pushes complexity to runtime; Groups push it to write-time
- Question to revisit: are there escape hatches for the 20% cases that don't fit cleanly?
