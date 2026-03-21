---
title: "Why Elixir"
description: "I don't know Elixir. But I'm writing my sync engine in it anyway. Here's why."
date: 2026-03-21
---

I don't know [Elixir](https://elixir-lang.org/). I've never written a [GenServer](https://hexdocs.pm/elixir/GenServer.html) in my life. I barely know what the [BEAM](https://www.erlang.org/blog/a-brief-beam-primer/) is.

So why am I rewriting my entire sync engine in it anyway?

## Find the best tool for the job

My first rule of side projects: prototype in whatever gets you to a working thing fastest.

For me, that's TypeScript. So the first proof of concept for Ebb's sync — the handshake, the catch-up reads, the live SSE subscriptions — was all Node. And it worked. I could open two browser tabs, make edits in one, and watch them appear in the other. Magic.

But a proof of concept only proves the concept. And once I had confidence in the _design_, I needed to pick the right tool for the _implementation_.

Ebb's sync server has a specific job: accept thousands of concurrent connections, write Actions to a durable log at high throughput, and fan out changes to subscribers in real time. That's fundamentally a concurrency and I/O problem, and the right runtime matters.

## The CouchDB breadcrumb trail

I first heard about Elixir a few years ago through [ElectricSQL](https://electric-sql.com), which uses it for their sync engine. I filed it away and forgot about it.

Then, while designing Ebb's replication protocol, I kept ending up in the [CouchDB](https://couchdb.apache.org) source code. CouchDB's multi-master replication, its append-only storage model, its conflict surfacing philosophy — these all directly influenced Ebb's architecture. And CouchDB is written in [Erlang](https://www.erlang.org/).

Elixir runs on the same virtual machine as Erlang — the BEAM — and is in many ways its modern successor: same runtime, better ergonomics, a richer ecosystem. If the BEAM was good enough for CouchDB to handle replication at scale, it was worth a serious look.

## What is the BEAM?

The [BEAM](https://www.erlang.org/blog/a-brief-beam-primer/) is the virtual machine that runs Erlang and Elixir. It grew out of Ericsson's work on [Erlang](<https://en.wikipedia.org/wiki/Erlang_(programming_language)#History>) in the '80s to power telephone switches — systems that needed to handle millions of concurrent connections, never go down, and isolate failures so one bad call didn't crash the whole network.

Which makes it obvious why projects like ElectricSQL chose Elixir. The BEAM's heritage translates almost perfectly to a sync server:

- **Lightweight processes.** The BEAM can spin up millions of processes, each with its own memory and garbage collector. One process per connection, one per sync group, one dedicated writer for the Action log — all running concurrently without sharing state.
- **Per-process garbage collection.** This is the big one. Node and Bun use stop-the-world GC — when the garbage collector runs, _everything_ pauses. On the BEAM, each process collects its own garbage independently. The writer process that serializes Actions to disk has a tiny heap and almost never triggers GC. Meanwhile, a misbehaving client connection can GC all it wants without affecting anything else.
- **Fault isolation.** If a client sends malformed data and its connection process crashes, [OTP supervision trees](https://hexdocs.pm/elixir/Supervisor.html) restart just that process. The rest of the server doesn't notice.
- **Native message passing.** Processes communicate by sending messages — no shared memory, no locks, no mutexes. This maps naturally onto Ebb's architecture, where the writer process receives Actions, flushes them to disk, and then sends notifications to fan-out processes that push updates to subscribers.
- **[ETS](https://www.erlang.org/doc/apps/stdlib/ets.html) for in-memory indexes.** Erlang Term Storage gives you lock-free concurrent reads across processes. Ebb's three in-memory indexes — entity lookup, group membership, and GSN range — all live in ETS, readable by any process without coordination.

In short: the BEAM was built for exactly the kind of system Ebb's sync server needs to be.

## But why not just use Node?

I love Node. I've built my career on it. It's still my preferred runtime because of its rich ecosystem. That's why I prototyped Ebb in Node. But I have ambitious performance goals for the Ebb sync server: **100,000 Action writes per second with 10,000 concurrent connections**.

And Node's single-threaded event loop just can't meet that mark. All of those connections would share one thread of execution. I _could_ use worker threads, but coordination between them is manual and error-prone — basically reimplementing what the BEAM gives you for free.

And the GC problem compounds at scale. A single stop-the-world pause during a high-throughput write batch means every connected client's SSE stream stutters. That's not a theoretical concern — it's the kind of thing that turns a "works great in development" demo into a production nightmare.

## But what about Bun?

[Bun](https://bun.sh/) is genuinely impressive. It's faster than Node, more memory efficient, and has real multi-threading support. If I were building a sync server in the JavaScript ecosystem today, Bun would be the choice.

But Bun still runs on [JavaScriptCore](https://developer.apple.com/documentation/javascriptcore), and while JSC's [Riptide](https://webkit.org/blog/7122/introducing-riptide-webkits-retreating-wavefront-concurrent-garbage-collector/) garbage collector is impressively sophisticated — concurrent marking, generational collection, retreating wavefront barriers — it still has to stop the world for root scanning, constraint solving, and end-of-cycle confirmation. Under memory pressure, JSC's [Space-Time Scheduler](https://webkit.org/blog/12967/understanding-gc-in-jsc-from-scratch/) can throttle the application down to zero CPU time to let the collector catch up — effectively a full pause.

For a sync server that needs to sustain consistent fan-out latency to thousands of SSE connections, even brief, unpredictable pauses are a problem. On the BEAM, the writer process — which has a tiny heap and almost never allocates — essentially pays zero GC cost, ever. The two runtimes aren't even playing the same game.

Bun does have a role in Ebb's architecture, though. I plan to use it to run the [Function Runner](https://github.com/ebbjs/ebbjs) that executes sandboxed, developer-defined, Typescript server functions with direct access to the DB.

We'll discuss that in another post, but suffice it to say Bun is not right for the hot-path sync engine of Ebb.

## But why not Rust?

Rust would give me manual memory management, zero GC pauses, and a performance ceiling higher than anything else on this list. It's "blazingly fast" and the obvious "serious systems programming" answer.

But that performance ceiling comes at a cost. Rust's ownership model adds real development friction, especially for a solo developer iterating on protocol design. When I'm still figuring out how fan-out should work, I want to reshape code fast — not fight the borrow checker.

## But...you don't know Elixir

Correct. But that's not a reason to avoid it.

The best tool for the job doesn't stop being the best tool just because you don't know how to use it. I'd rather spend a few weeks learning [OTP patterns](https://hexdocs.pm/elixir/supervisor-and-application.html) than spend months working around the limitations of a runtime that wasn't designed for this workload.

You've heard the phrase, "buy once, cry once." Well, this is "learn once, cry once."

Also, if not knowing something was going to stop me from making progress on this project, I would have stopped a _long_ time ago. There's still so much I don't know about sync, distributed systems, and eventual consistency, but that hasn't stopped me so far. .

Learning a new language won't either.
