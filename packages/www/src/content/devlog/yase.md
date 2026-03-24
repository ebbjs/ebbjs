---
title: "Yet Another Sync Engine?"
description: "Why I'm building a sync focused framework when the local-first landscape already seems crowded"
date: 2026-03-18
published: true
---

During Covid, it seemed like everyone and their brother was building "yet another JavaScript framework".

Today, in the year of our Lord 2026, the trend is sync engines.

Sync used to be something only specialized apps cared about — [Slack](https://slack.com), [Linear](https://linear.app), [Figma](https://figma.com), the kinds of tools where real-time collaboration was the whole point. Then AI changed everything. Suddenly every app needs to be reactive, collaborative, and support a multiplayer (or multi-agent) experience.

And serious players have emerged to meet the demand: [Convex](https://convex.dev), [Zero](https://zerosync.dev), [ElectricSQL](https://electric-sql.com), and even [TanStack](https://tanstack.com/db).

But in this rush to help every app become "AI-native", all of these solutions keep kicking the can on the one feature I want: offline writes.

"When are you ever really without internet?" and "LLMs require cloud inference anyway" have become convenient excuses to avoid facing conflicts and eventual consistency head-on.

And the projects that do care about offline? They often lack the _online_ primitives — presence, permissions, server-side actions — you need to build a real multiplayer app.

A year ago, I wanted to build a custom writing app to replace my Obsidian workflow. I wanted to keep the speed and security of writing local markdown files, but also add workspaces, collaborative editing, and public share link support.

I traveled across the [local-first landscape](https://www.localfirst.fm/landscape) and found nothing that fit perfectly, but picked up some ideas that let me start hacking together my own solution.

Months in, I was drowning in glue code and hadn't shipped a single feature. But I'd learned what the glue needed to do: event sourcing like [Livestore](https://livestore.dev), an outbox like [Powersync](https://www.powersync.com/), hybrid-logical clocks like [CockroachDB](https://www.cockroachlabs.com/), group-based partitioning like [Jazz](https://jazz.tools), CDN-capable catch-up and SSE live subscriptions like [ElectricSQL](https://electric-sql.com), conflict surfacing like [CouchDB](https://couchdb.apache.org), and a simple, cohesive developer experience that hides the magic like [Convex](https://convex.dev).

That proof of concept became the basis for Ebb.

So that's why I'm building yet another sync engine — to package the primitives necessary to enable the next generation of developers to build apps that are collaborative without compromise.

This devlog is where I'll share what I learn — the architecture decisions, the tradeoffs, the rabbit holes. If you're interested in local-first, sync engines, or just watching someone wrestle with distributed systems in public, follow along.
