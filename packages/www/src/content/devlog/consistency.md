---
title: "Strong Consistency's Biggest Weakness"
description: "We spend enormous effort hiding the network from our users. Maybe we shouldn't."
date: 2026-03-26
published: true
---

> This post is part of the [`ebb` devlog](/devlog) -- a series documenting the design and development of `ebb` -- a real-time backend for building collaborative apps. I'm still early in my thinking on a lot of this, so if something here seems off or you see it differently, I'd genuinely love to hear from you -- come say hi in our [Discord](https://discord.com/channels/1486087320540283024/1486089506447822940).

Every sync engine promises the same thing: when one user makes a change, everyone else sees it instantly. Fulfilling that promise touches one of the deepest challenges in distributed systems: **consistency**.

There are two approaches: **coordination** and **convergence**.

Coordination means changes go through a central authority -- a server that accepts writes, decides what's valid, and pushes the result to everyone else. There's one source of truth, and every client reflects it. This is **strong consistency**, and it's how most sync engines work today.

Convergence means every client works off its own copy of the data. Changes happen locally, instantly. Clients exchange state through the network and converge to the same result -- they might briefly disagree, but they'll all end up in the same place. This is **eventual consistency**.

Most sync engines pick coordination. [`ebb`](https://ebbjs.com) takes the opposite approach -- and in this post, we'll explore why.

## Your app isn't your database

Strong consistency works brilliantly -- inside a datacenter. Consensus protocols like [Raft](https://raft.github.io/) and [Paxos](<https://en.wikipedia.org/wiki/Paxos_(computer_science)>), quorum writes, serializable transactions -- all of this machinery exists to make a cluster of servers behave as a single authoritative node. Databases like Postgres, [Google Spanner](https://cloud.google.com/spanner), and [CockroachDB](https://www.cockroachlabs.com/) are proof it works.

But your app isn't your database. And it's not your server. It's a client -- one node among thousands, on an unreliable network, operated by a user who wants it to "be fast" and doesn't care how hard that is.

To achieve strong consistency under those conditions, we'd have to race against the [speed of light](<https://wecomfiber.com/fiber-optic-speed-internet-at-the-speed-of-light/#:~:text=The%20speed%20of%20light%20in%20an%20optical%20fiber%20can%20be%20about%20two%2Dthirds%20(200%2C000%20km/s)%20of%20its%20speed%20in%20a%20vacuum.>). So we don't do that. Instead, we layer on client-side techniques that make strongly consistent data layers _feel_ faster than they are.

In other words: we fake it.

## The consistency illusion

The "real-time" feel of apps like Linear, Figma, and Superhuman comes from magic tricks designed to _hide_ network latency.

- **[Optimistic updates](https://docs.convex.dev/client/react/optimistic-updates)** show our edits before the server confirms the request.
- **Reactive subscriptions** push state to the client instead of requiring it to pull or poll.
- **Client-side caches** make initial reads fast while data refreshes in the background.

These techniques work, and they work well -- apps like Linear and Figma are proof. But they aren't trivial to build robustly. Each one adds significant surface area for bugs, and together they represent a lot of accidental complexity imposed by the architecture.

The server may be strongly consistent, but the client never is: it's always working with some version of the truth that's milliseconds (or seconds, or minutes) behind. The engineering effort to make that gap invisible is where most of the complexity lives.

So instead of hiding that gap, what if we just designed for it?

## Convergence over coordination

Convergence takes a different approach to consistency: accept that the client is a node in a distributed system, not a window into server state.

In a coordination-based system, a write is a _request_ -- the client asks the server for permission, and if the answer is no, the framework silently rolls back the user's edit. In a convergence-based system, a write is a _local fact_ -- applied to the user's replica immediately, because it's _their_ data. The server's job is to validate and relay writes to other clients. 

When clients reconnect, they exchange changes and **converge** to the same state through deterministic merge rules. There's no consensus protocol. No locks or transaction ordering. Just data flowing between replicas until they eventually agree.

This means apps don't need client-side workarounds to give the _illusion_ of speed. They just _are_ fast.

No optimistic update rollbacks -- every write is real. No cache invalidation -- there's your copy and my copy, and they converge. And no special offline mode -- the client already has a full replica and writes are already local. There's nothing to change when the network disappears. (Your product still needs to communicate network status to the user -- but the data layer doesn't have to behave any differently.)

The flip side is that you're always operating on a replica that may diverge from others -- there's no mode where you get a complete server-authoritative source of truth.

For many apps, though, that's not a compromise -- it's actually the better model.

- **Authoring tools** -- collaborative editors, whiteboards, and design tools thrive on local writes because users are usually editing different parts of the same artifact; brief divergence is invisible and merges are natural.
- **Field apps** -- anything used on spotty connections -- just keep working because the data layer never needed the network to write in the first place.
- **Workplace software** -- feeds, comments, and annotations are high-write but low-contention; coordinating every write through a server buys you almost nothing.

For most apps, the window of divergence between replicas is an acceptable (and often completely invisible) tradeoff for a dramatically simpler data layer. And if "feeling faster" than your competitor is a product advantage, eventual consistency gives this to you while letting you _move faster_ than your competitor.

With eventual consistency, the network is an optimization for freshness, not a requirement for correctness.

## It's all tradeoffs

So what's the catch? Well, like with all engineering decisions, choosing eventual consistency over strong consistency doesn't eliminate all problems -- it moves them.

Instead of managing optimistic updates, cache invalidation, and rollback logic, you design your schema for mergeability. Convergence requires structures that compose under concurrent writes -- [hybrid logical clocks](https://martinfowler.com/articles/patterns-of-distributed-systems/hybrid-clock.html) for causal ordering, append-only fact logs instead of mutable state, data models where independent edits don't clobber each other.

There's also bandwidth. A coordination-based system can just serve clients the current state. A convergence-based system has to stream a replication log so replicas can catch up and merge correctly. That's a lot more data over the wire.

And there's the window of divergence. For some period of time, two clients _will_ see different state. With fast replication and UX patterns like presence, most users naturally avoid stepping on each other's toes. But when conflicts do happen -- especially after offline sessions -- you need patterns for helping users resolve them based on your app's domain.

We'll dig into how `ebb` solves each of these in future posts, but I want to be honest about these tradeoffs, because eventual consistency isn't a silver bullet.

## Sometimes you need strong consistency

There are domains where even brief disagreement between clients is unacceptable:

- **Financial systems.** Balances, transactions, and ledgers require agreement across all parties before a write is considered valid. A temporarily inconsistent balance isn't a UX quirk -- it's a bug with legal consequences.
- **Authoritative game state.** Competitive multiplayer games need a single arbiter of truth. Two players seeing different versions of the world, even for a frame, breaks fairness.
- **Inventory and booking systems.** When two people see the last seat as available and both claim it, the conflict _is_ the problem. "Resolve it later" doesn't work when the resource is already consumed.

In these cases, conflicting edits are a bug, not a feature. If your domain requires a central authority to validate state, serialize transactions, and ensure concurrent edits don't ever conflict, `ebb` is the wrong tool.

For everything else, I think convergence and eventual consistency are worth exploring. But I'm biased -- and only _you_ can decide which model is best for your app.

## Looking ahead

My goal with `ebb` is to make it easier to build reactive, collaborative, offline-capable apps. The types of apps I want to _use_. And that starts with treating those apps for what they are: nodes in a distributed system, not windows into server state.

Convergence over coordination. Replicas over caches. `ebb` and flow.

Thanks for reading!
