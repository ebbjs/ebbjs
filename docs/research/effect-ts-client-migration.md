# Migrating the client to Effect under the hood

**Question.** Would `@ebbjs/client` (plus `@ebbjs/react`, `@ebbjs/storage`) be
better off running on [Effect](https://effect.website) — typed errors, services
and Layers, fibers and structured concurrency, `Schedule`, `Stream`, `Schema` —
with the current hand-rolled runtime replaced underneath the existing API?

**Answer in one line.** Effect is a good fit for the ~4.5k lines of transport and
async policy (`sse`, `outbox`, `flush-scheduler`, `backfill`, `presence`,
the reconnect loop) and a poor fit for the ~13k lines of synchronous replica,
query, conflict, and accessor code that make the client fast and make
`useSyncExternalStore` work — and the measured price of adopting it at all is
**+32 KB gzip for the runtime floor, +43 KB for the concurrency primitives, and
+101 KB if `Effect.Schema` comes along**, against a full client stack that ships
at **59.5 KB gzip** and a `packages/client` whose own code is **35.8 KB gzip**.

Labels: **[measured]** (ran it here), **[from source]** (read the code or the
npm metadata), **[derived]** (arithmetic over the two), **[judgment]** (no
source owns it; my call, argued).

## Sources read

Effect 4.1.4 (the `latest` and `staging` npm tag on 2026-11-11 **[from
source]**): the repo's [`README.md`](https://github.com/Effect-TS/effect/blob/main/README.md)
(LTS stance, `strict` + TS 5.9 requirement), [`MIGRATION.md`](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
(v4 package consolidation, stability tiers), [`LLMS.md`](https://github.com/Effect-TS/effect/blob/main/LLMS.md)
(the first-party "how to write Effect code" guide, `Context.Service`,
`Schema.TaggedError`, `effect/http` paths), and the v4 guides for
[fibers](https://effect.website/docs/v4/concurrency/fibers), [Scope](https://effect.website/docs/v4/resource-management/scope),
[Layers](https://effect.website/docs/v4/requirements-management/layers),
[TestClock](https://effect.website/docs/v4/testing/testclock),
[SubscriptionRef](https://effect.website/docs/v4/state-management/subscriptionref),
[Streams](https://effect.website/docs/v4/stream/introduction), and
[tracing](https://effect.website/docs/v4/observability/tracing). `@effect/atom-react`
from its [README](https://github.com/Effect-TS/effect/blob/main/packages/atom/react/README.md)
and its shipped `dist/*.d.ts`. On our side:
`packages/client/src/{sync,presence}/*`, `packages/storage/src`, `packages/react/src`,
`CONTEXT.md`, `docs/tooling/anti-slop.md`,
`tools/oxlint/anti-slop/effect/`, `docs/research/503-replica-read-model.md`
(for the read-path constants), and 37 `ebb_server/lib` modules that are
`GenServer`/`Supervisor` **[from source]**.

## TL;DR

- **[measured] Effect's runtime floor is 90.8 KB minified / 31.7 KB gzip**, for
  a program that does nothing but `Effect.runPromise(Effect.gen(…))`. The whole
  client stack as it builds from this tree — `client` + `core` + `storage` +
  `schema` + `write`, third-party deps external — is 184.7 KB minified / **59.5
  KB gzip**; `packages/client`'s own code is 110.8 KB / **35.8 KB gzip**. The
  runtime floor alone is **53% of the full stack and 89% of the client package**,
  before the client does anything.
- **[measured] The concurrency primitives are another +11 KB gzip**
  (`Queue`, `Semaphore`, `Deferred`, `Ref`, `Schedule.retry`, `timeout`,
  `scoped` → 124 KB min / 42.7 KB gzip). Adding `Stream` and Effect's
  `HttpClient` reaches **282 KB min / 93 KB gzip**, 1.6× the full stack's gzip.
- **[measured] `Effect.Schema` has a ~101 KB gzip floor** even if you only
  declare a struct and never decode with it; decoding is 116 KB. TypeBox, which
  we already ship in 33 source files, is **11.8 KB gzip** for the same
  declaration and 25.3 KB for `Value.Parse`. So the "Effect also solves our
  missing boundary parser" argument is real but the most expensive one on the
  table.
- **[measured] An Effect boundary costs 0.4–2 µs per `yield*` and 4–18 µs per
  `runSync`**, against our own measured read costs of 1.5–12 µs per accessor
  and 3.6 µs per windowed open (`docs/research/503-replica-read-model.md`). The
  read path is the one place the client cannot afford per-call ceremony, and it
  is also the one place Effect cannot express, because `useSyncExternalStore`
  needs a synchronous `get()`.
- **[measured] Type-checking gets 2.6× slower**: a 4-line file is 3.7 s;
  the same file using `Schema.Struct` + `Context.Service` + `Layer` +
  `Effect.gen` is 9.8 s (31.8 s with `skipLibCheck` off).
- **[from source] Effect would fix a real defect we have today**: the request
  calls cannot be cancelled. There are **zero** `AbortController`s in shipped
  source; `eventsource-client` aborts the SSE fetch for us (`sse.test.ts`
  proves it), but `close()` leaves a running `catchUp`, `write`,
  `submitActions`, or presence send to finish against a torn-down replica and
  storage adapter. Interruption
  is Effect's best argument, and it is a correctness argument, not an
  ergonomics one.
- **[judgment] Recommendation: no full migration; keep the sync replica.** If
  Effect is adopted at all, adopt it in one bounded place — a new
  `@ebbjs/client-transport`-shaped module behind the existing interfaces — and
  leave `Schema`, the replica, and the React read path alone.

## What "under the hood" would actually replace

The client is not a pile of promises; it is a small hand-written runtime with
named parts. The inventory below is the migration's real scope
**[from source]** (counts over `packages/{client,storage,react}/src`, tests
excluded):

| primitive we hand-rolled                     | where                                                                               | lines | Effect equivalent                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------- |
| connection state machine + pub/sub           | `sync/connection-state.ts`                                                          |    86 | `SubscriptionRef` / `PubSub`                                                    |
| reconnect loop, backoff, timer resolve dance | `sync/client.ts` (`runSubscriptionLoop`, `reconnectTimer`, `reconnectTimerResolve`) |  ~200 | `Schedule` + fiber interruption                                                 |
| debounce + single-flight + retry + gate      | `sync/flush-scheduler.ts`                                                           |   355 | `Queue`/`Deferred` + `Schedule` + `Semaphore`; the gate is a `Deferred`         |
| outbox lifecycle and outcome classification  | `sync/outbox.ts`                                                                    |  1085 | typed error channel + `Effect.catchTag`                                         |
| catch-up pagination                          | `sync/backfill.ts`, `sync/group-listing.ts`                                         |   603 | `Stream.paginate`                                                               |
| SSE parse and lifecycle                      | `sync/sse.ts`                                                                       |   302 | `Stream` over the eventsource iterator; `Scope` for teardown                    |
| presence debounce / TTL / caps               | `presence/{presence,store,transport,timers}.ts`                                     |  ~890 | `Stream` + `Schedule` + `Queue` drop policies                                   |
| hand-rolled timers and clocks                | 28 `setTimeout`, 14 `clearTimeout`, 3 `queueMicrotask`, 15 `unref`, 7 `new Promise` |       | `Effect.sleep` + `TestClock` (deletes the `FlushTimers` / `now` seams entirely) |
| listener sets, refcounted detach, teardown   | `sync/replica-signal.ts`, `sync/observable.ts`, `client.ts` `close()`               |  ~400 | `Scope`, `PubSub`, `Stream`                                                     |
| serialized persistence chains                | `client.ts` (`replicaSaveChain`, `replicaScopeChain`)                               |  ~150 | `Semaphore` / `Effect.andThen` sequencing                                       |

That is **~7.2k lines including `client.ts`**, or **~4.5k excluding it**. The
other ~13k lines of `packages/client/src` are the replica fold, the query plan
and execute engine, conflict detection, drafts, permission evaluation, and the
component migrations: synchronous, allocation-sensitive, and untouched by
Effect's model. `packages/storage`'s IndexedDB adapter is the one part of the
storage layer that would slot in cleanly (it is genuinely async), but it is
behind a `StorageAdapter` interface already.

Context for the size of the change: `packages/client/src` is 17,703 lines with
**29,918 lines of tests**, and shipped source contains 465 `async` and 1,174
`await` sites **[measured]**. Those tests are written against the injected
seams the migration deletes (`FlushTimers`, `now`, `fetchImpl`, the
`storage.*` doubles) — each becomes an Effect test with `TestClock` and a
`Layer`.

## Measured cost

### Bundle size

esbuild 0.25, `--bundle --format=esm --minify`, `gzip -9`, Node 24.21.0,
`effect@4.1.4`. Nothing in these programs is dead code; each is the smallest
program that uses the named modules. Gzip figures are `gzip -9 -c`, so each
includes the ~20-byte header (filename and mtime) — good to tens of bytes, not
thousands.

| program                                                                                                 |    raw |       gzip |
| ------------------------------------------------------------------------------------------------------- | -----: | ---------: |
| empty entry                                                                                             |    24B |        52B |
| `Effect.gen` + `runPromise` + `sleep`                                                                   |  90.8k |  **31.7k** |
| + `Context.Service` / `Layer`                                                                           |  90.9k |      31.7k |
| + `Queue`, `Semaphore`, `Deferred`, `Ref`, `retry`, `timeout`, `scoped`                                 | 124.0k |  **42.7k** |
| + `Stream.map` / `runCollect`                                                                           | 172.2k |      56.4k |
| + `effect/http` `HttpClient` + `FetchHttpClient`                                                        | 281.8k |  **93.2k** |
| `effect/http` alone                                                                                     | 193.8k |      65.6k |
| `Schema.Struct` declared, never run                                                                     | 319.4k | **100.9k** |
| `Schema.decodeUnknownSync`                                                                              | 362.3k |     116.2k |
| `@effect/atom-react` `useAtomValue` + `Atom.make` (react external)                                      | 155.9k |      52.1k |
| _reference:_ TypeBox `Type.Object` declared, never run                                                  |  46.0k |      11.8k |
| _reference:_ TypeBox `Value.Parse`                                                                      | 104.9k |      25.3k |
| _reference:_ whole client stack from this tree (client+core+storage+schema+write, third-party external) | 184.7k |  **59.5k** |
| _reference:_ `packages/client` 1.1.0 own code, all deps external                                        | 110.8k |  **35.8k** |
| _reference:_ `@ebbjs/client@0.3.0` `dist/index.js` as published (npm's only release)                    | 210.5k |      58.4k |
| _reference:_ same published file minified, deps external                                                | 121.0k |      37.3k |

`Layer` is effectively free once `Effect.gen` is in (92 bytes), which is worth
knowing: the DI story is not what costs you. `Schema` and `Stream` are.

**[derived] The ratios.** The runtime floor is 0.89× the `packages/client`
package's own gzip and 0.53× the full client stack's. An "edge only, keep our own
`fetch`" adoption — `Effect` + concurrency primitives, no `Stream`, no `Schema`
— lands at ~42.7 KB gzip, i.e. **the full stack's shipped JS grows by ~72%**.
A "full Effect" adoption with `Stream` + `Schema` + `Atom` is ~150 KB gzip of
runtime on top, ~3.5× the full stack today.

Two mitigations, neither free **[judgment]**: publish the Effect-based transport
as a separate entry point so apps that only use the synchronous replica never
download it (but the replica is useless without the transport, so nobody would
actually skip it); or keep Effect out of the published packages and only use it
in the dev/reference implementation (which forfeits the correctness wins).

### Per-call runtime overhead

`node --expose-gc`, medians of 7 trials, 100k iterations, `effect@4.1.4`
**[measured]**:

| shape                                                         |  ns/op |
| ------------------------------------------------------------- | -----: |
| plain function                                                |     26 |
| `Effect.runSync(Effect.succeed(v))`                           |     35 |
| `Effect.runSync(Effect.sync(() => v))`                        |  4,022 |
| `Effect.runSync(Effect.gen` with one `yield*`)                | 17,990 |
| `yield* Effect.succeed(v)` inside an already-running fiber    |    984 |
| `yield* Effect.sync(() => v)` inside an already-running fiber |  2,026 |

A second run of the same harness (same machine, JIT warmed differently) gave
12 ns for the plain function, 407 ns for an in-fiber `yield*`, 963 ns for
`runSync(Effect.sync)`, and 5.5 µs for `runSync(Effect.gen)`, so treat these as
**orders of magnitude, not constants**: hundreds of nanoseconds to a few
microseconds per effect boundary, and 4–18 µs per `runSync`.

Put against our own measurements from
[#503](503-replica-read-model.md) — row accessors 1.5 µs (`forwardOne`) to 12 µs
(the query-builder accessors), windowed body open 3.6 µs, 10k-row search scan
1.5–2.8 ms — the conclusion is not "Effect is too slow", it is **"Effect's
granularity is wrong for the read path."** Wrapping each of the 20-odd replica
reads in a single query in `Effect.gen` would add ~20 µs to a query that costs
microseconds, and wrapping the _accessors_ is impossible anyway: they must stay
synchronous for `useSyncExternalStore` (`packages/react/src/use-sync-observable.ts`).
Effect's own answer to that constraint is Atom (`Atom.subscriptionRef`,
`AtomRegistry` with a synchronous `get`), i.e. replacing `observable.ts` and
every hook — `@effect/atom-react`'s hooks alone are 52.1 KB gzip
**[measured]**.

### Type-check cost

`tsc` 5.9, `--strict`, `skipLibCheck: true` (which our `tsconfig.base.json`
already sets), one file **[measured]**, three runs each:

| file                                                                       |   time |
| -------------------------------------------------------------------------- | -----: |
| 4 lines of plain TS                                                        |  3.7 s |
| same shape using `Schema.Struct`, `Context.Service`, `Layer`, `Effect.gen` |  9.8 s |
| that same file with `skipLibCheck: false`                                  | 31.8 s |

**[judgment]** At ~6 s of added check time for _one_ small file, a client with
4.5k lines of Effect code is a materially slower `pnpm build` (our real
typecheck runs through `vite-plugin-checker` inside each package —
`docs/tooling/anti-slop.md`). Effect's own docs also assume you install the
[Effect LSP plugin / `tsgo`](https://effect.website/docs/v4/getting-started) to
keep the editor honest, which is another adoption step in a 14-package
workspace with a vendored Oxlint plugin.

## Pros

1. **Cancellation and interruption — the strongest argument.** Structured
   concurrency gives every forked fiber a finalizer and makes interruption
   automatic when the enclosing `Scope` closes
   ([fibers](https://effect.website/docs/v4/concurrency/fibers),
   [Scope](https://effect.website/docs/v4/resource-management/scope)). Today
   `client.close()` cannot abort an in-flight `fetch` **[from source]**: there
   are zero `AbortController`s in `packages/client/src`, and `catchUp`,
   `write`, `submitActions`, and `invokeFunction` all await a `fetch` whose
   result will be applied to a replica that is already torn down. Effect would
   make "the client is closed" an interrupt, not a state we check after every
   `await`.
2. **One `Schedule` instead of two hand-maintained retry loops.** `backoff.ts`
   is 8 lines and there are two attempt counters (SSE reconnect, outbox flush)
   that must stay independent; `flush-scheduler.ts` also owns a debounce timer,
   a retry timer, and the gate. `Schedule.exponential` + `Schedule.jittered`
   collapses this, and the "mid-backoff trigger reports a deferred outcome"
   rule becomes a `Queue` policy rather than a state machine.
3. **`TestClock` deletes the timer seams.** `FlushTimers`, `now`, the
   `unrefTimer` helper, and `presence/timers.ts` exist only so tests can avoid
   real time ([TestClock](https://effect.website/docs/v4/testing/testclock)).
   `@effect/vitest` plus `TestClock.adjust` is strictly better than injected
   clocks, and the 478-line `flush-scheduler.test.ts` is the kind of test that
   gets _shorter_.
4. **Typed errors match a distinction we already encode by convention.**
   `FlushOutcome` is a union of `accepted` / `partial` / `unreachable` /
   `empty`, and `flush-scheduler.ts` goes to real trouble to guarantee that a
   `write()` cannot mistake an unsubmitted Action for success (the gate
   returns `unreachable` while held; `stop()` reports failure rather than
   `empty`). Effect's error channel with `catchTag` / `catchTags`
   ([LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md)) makes that
   distinction unrepresentable-rather-than-forgotten, and it is the exact shape
   the outbox and the sync loop need.
5. **The repo's own style guide points this way.** `AGENTS.md` says "prefer
   functional style over OO … avoid class hierarchies and inheritance", while
   `SyncClient` is a 2,731-line class with 82 private mutable fields and
   `ConnectionStateMachine` is a class with a mutable `_state`. Services and
   Layers are the functional DI the style guide asks for, and the vendored
   anti-slop plugin already contains a **ready-to-enable Effect rule set**
   (`no-manual-effect-error-tag`, `prefer-effect-match`,
   `no-service-constructor-imports`, …) sitting unused because "no package
   depends on Effect" (`docs/tooling/anti-slop.md`) **[from source]**.
6. **It would close a decision we have documented as open.** `anti-slop.md`
   step 4 blocks 102 findings (`no-unsafe-dictionary-type` 26,
   `no-unknown-parameters` 23, `no-runtime-typeof` 53) on "we have no
   schema/parser library (no zod/valibot/arktype/Effect)". `Schema` is that
   parser, with decode/encode, tagged errors, JSON Schema, and derivation
   ([SCHEMA.md](https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md)).
   See the cons, though: 101 KB gzip, and we already ship TypeBox.
7. **The concepts already exist on the other side of the wire.** `ebb_server`
   has 37 modules that are `GenServer`/`Supervisor`/`DynamicSupervisor`
   **[from source]**. `Layer` ≈ supervision tree, `PubSub` ≈ `Phoenix.PubSub`,
   `Queue` ≈ mailbox, `Scope` ≈ process lifetime, `Schedule` ≈ retry policy,
   `Stream` ≈ `GenStage`. For a team that reasons in OTP, Effect's vocabulary is
   the same vocabulary in TypeScript — a genuine onboarding advantage that
   nothing else in the JS ecosystem offers.
8. **LTS with a real commitment.** Effect 4.x declares at least three years of
   support, one year of bug fixes and two years of security fixes past the next
   major, and v4 unifies every ecosystem package on one version number
   ([README](https://github.com/Effect-TS/effect/blob/main/README.md),
   [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).
   That is a stronger stability statement than most of our dependencies make.
9. **Tracing, for free, where we are currently blind.** The reconnect → catch-up
   → conflict-sweep → flush sequence is the hardest thing to debug in this
   codebase and it has no instrumentation beyond `connection-state`. Fibers plus
   `Effect.withSpan` give causal traces of exactly that path
   ([tracing](https://effect.website/docs/v4/observability/tracing)).

## Cons

1. **Bundle size, and it is not optional.** 31.7 KB gzip is the floor for using
   `Effect.gen` at all **[measured]**, on a package whose selling point is
   "works offline in a browser" and whose full stack (client + core + storage +
   schema + write) is 59.5 KB gzip.
   There is no tree-shaken subset that gives you interruption and `Schedule`
   cheaply: the concurrency primitives are +11 KB, `Stream` +14 KB, `Schema`
   +69 KB. Effect's `sideEffects` allowlist makes it _tree-shakeable_
   **[from source]** — it is just that the tree you need is most of the trunk.
2. **The read path cannot be migrated without changing what the client is.**
   `CONTEXT.md` opens with "reads are immediate"; `useSyncExternalStore` requires
   a synchronous `getSnapshot`; the accessors are measured at 1.5–12 µs and the
   per-boundary cost is 0.4–2 µs **[measured]**. So "Effect under the hood"
   really means "Effect at the edges", and the edges are ~25–40% of the code.
   Anyone reading the migration announcement will not hear that distinction.
3. **`Schema` is the expensive door.** 100.9 KB gzip to _declare_ a struct
   **[measured]** — 8.5× TypeBox's 11.8 KB for the same declaration. We already
   depend on `@sinclair/typebox` in 33 source files (projections in
   `query-execute`/`query-builder`, presence payloads). Adopting both means two
   schema systems with different `static` derivation and error shapes; adopting
   only Schema means a second migration the size of the first.
4. **The test suite is the migration cost nobody quotes.** 29,918 lines of
   client tests build clients with injected `FlushTimers`, `now`, `fetchImpl`,
   and storage doubles **[measured]**. Effect deletes those seams. That is a
   rewrite of the tests, not a port of them, and it is larger than the source
   change.
5. **Public types leak.** `Effect<A, E, R>` in an exported signature forces
   consumers to run effects and provide Layers, or forces us to wrap at the
   boundary with `runPromise` and lose the error channel — in which case we keep
   the type and pay the size. For a _published_ SDK (`@ebbjs/client` is on npm,
   `private: false`) that is a decision imposed on every app.
6. **Effect 4 is young, and the documentation is split.** `latest` is 4.1.4,
   published 2026-11-11 **[from source]**, while `effect.website` defaults to
   `/docs/v3`, most blog posts and answers are v3, and v4 renamed things
   (`Context.Service`, `Schema.TaggedError`, `effect/http`,
   `effect/reactivity`, `TestClock` at `effect/testing`). Everything outside
   `effect` itself is `@stability unstable` and may break in a minor
   ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).
   The ecosystem just absorbed one full-version break; we would be adopting
   during the settling period.
7. **Requirements shift.** Effect 4 wants TypeScript ≥5.9 (we have ^5.9.2 —
   fine), `strict` (fine), and Node ≥22.19 for the Node platform packages (our
   engines say ≥22.8.0). Nothing blocks, but our "works on Node 18+, Bun, and
   Deno" claim in `sse.ts` would need re-verification.
8. **Debugging moves in two directions at once.** We gain traces; we lose the
   thing we are currently good at — labelled errors that name the endpoint and
   echo the server body (`httpError`, `parseJsonBody` in `sync/http.ts`,
   `readBody` degrading to `""` so a body is read exactly once). Reproducing
   that discipline inside an error channel is work, and an unhandled fiber
   defect reads worse than a stack trace pointing at `client.ts:1204`.
9. **Gravity.** Effect's model invites pulling the replica, the query engine,
   and the React bindings in with it, which is precisely where the cost is
   highest and the benefit lowest. The realistic risk of "we'll only use it for
   the transport" is that it does not stay there, and a 2,731-line class becomes
   8 services and 30 Layers across the same 17k lines.
10. **A deliberate design choice would be undone.** Fifteen `unref` calls
    **[from source]** exist so a pending flush or presence timer is never the
    reason a Node process stays alive. Whether Effect's clock and sleeping
    fibers preserve that under `runPromise` is unverified (see open questions);
    if they do not, every Node consumer of the client inherits a hang.

## Where it fits, by package

| package                          | fit        | why                                                                                                             |
| -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| transport / outbox / scheduler   | **good**   | retry, debounce, single-flight, gate, cancel: Effect's core competences, and the code is already shaped like it |
| `presence` (debounce/TTL/leave)  | **good**   | `Stream` + `Schedule` + `Queue` drop policy; `Scope` for the leave-on-teardown                                  |
| storage adapter (IndexedDB)      | **ok**     | genuinely async I/O, but 8.2k lines behind an interface that already works; low payoff                          |
| replica, query engine, conflicts | **no**     | synchronous folds and indexes; Effect has nothing to say about them and would add per-call overhead             |
| React bindings                   | **no**     | `useSyncExternalStore` needs sync reads; the Effect-native answer (Atom) is a rewrite at 52 KB gzip             |
| wire boundary parsing            | **costly** | `Schema` is the right tool, at 101 KB gzip, next to a TypeBox we already ship                                   |

## Options, with costs

**A. Don't migrate.** Keep the hand-rolled runtime; spend the effort on the two
things it actually lacks: an `AbortController` per request threaded from
`close()` (small, self-contained, fixes the real defect — see below), and a
boundary parser decision (`anti-slop.md` step 4). Zero bytes, zero type-check
cost, keeps the read path. **[judgment] This is the option I would take now.**

The abort controller is about 25 lines, because `fetchImpl` is already a single
injected choke point (the `SyncClient` constructor wraps it once) and all six
client request call sites go through `exchange` / `requestJson`. Six sharp edges
keep it from being a 20-minute patch:

- **A `keepalive` request must be excluded.** The only one today is
  `presence.leave({ keepalive: true })`, sent from an unload handler where nobody
  can `await` it; a client-wide abort would kill exactly the request that has to
  survive teardown. The exemption belongs in the fetch wrapper, keyed on the
  flag, not at the presence call site — one rule, one home, and an ordinary
  presence send stays teardown-scoped like every other request.
- **Fire the controller only from `close()`.** `cancelSubscription` is also
  called when `subscribe()` replaces a session, on plain unsubscribe, and when
  the live group set empties — none of which may kill the client.
- **Ordering inside `close()` is load-bearing.** `abort()` rejects the in-flight
  fetch on a microtask, and `close()` sets `sub.cancelled` synchronously
  afterwards, so `connectAndDrain`'s `catch` lands on the clean path. Add a
  test, because moving one line breaks it silently.
- **`write()` starts throwing `AbortError`.** Today an in-flight flush that
  outlives `close()` resolves normally and writes `acknowledged` rows to an
  adapter that may already be torn down; aborting replaces that with a
  rejection callers can see. That is a public-behaviour change and needs a
  sentence in the `close()` doc comment.
- **`AbortSignal.any` would collapse the merge, if you accept its browser
  floor** (Safari 17.4, Firefox 124 — the package declares no browser baseline,
  and `sse.ts`'s "Node 18+" describes its SSE dependency, not this package,
  whose `engines.node` is 22.8). Merging by hand is what keeps older browsers
  working. Either way the caller's abort has to keep reaching the body after the
  response headers arrive: an SSE `fetch` promise settles there, and it is the
  caller's abort, not ours, that closes the body. Detaching every listener on
  settle silently stops a live stream from being torn down.
- **The body-read policy has to rethrow an abort.** `readBody` deliberately
  degrades an unreadable body to `""`, and `invokeFunction` is the one caller
  that parses tolerantly — a `close()` landing between the headers and the body
  reads as `{ result: undefined, replayed: false }`, i.e. a void function that
  succeeded. Keying the rethrow on the error name (`AbortError`) rather than on
  a signal is what works, because the signal is added by the fetch wrapper and
  never reaches the caller's `init`.

I found no test covering "a request in flight when `close()` runs" (`close()`
appears in 146 test call sites, all after an awaited step), so the work is
mostly writing that one.

**B. Edge-only adoption in one new module.** New `sync/runtime/` behind the
current interfaces: `sse.ts`, `outbox.ts`, `flush-scheduler.ts`, `backoff.ts`,
`backfill.ts`, presence timers, and the reconnect loop become Effect programs
driven by a `ManagedRuntime` created in `createClient`. Keep `http.ts` (plain
`fetch`), keep `Schema`/TypeBox as-is, keep the replica and React untouched.
Cost: **+42.7 KB gzip** and ~6 s per type-check of the touched files; ~4.5k
lines rewritten plus their tests. Benefit: interruption, `Schedule`, `TestClock`,
typed failures at the network edge, one retry policy. **[judgment]** Worth a
spike if the transport flakiness or the reconnect debugging cost is hurting;
not worth it as a cleanup.

**C. Full migration.** Defensible only if the read model changes with it — async
replica access, Atom-based React bindings, Effect `Schema` on the wire — which
contradicts `CONTEXT.md`'s synchronous read promise and replaces the query
engine's measured costs with new ones. Cost: ~150 KB gzip, a rewrite of both the
source and the 30k lines of tests, and a public API that requires Effect.
**[judgment] No.**

## Open questions (verify before any decision)

- Does `Effect.sleep` / `Effect.timeout` / a forked fiber keep a Node process
  alive under `runPromise` the way a raw `setTimeout` does, and can it be
  `unref`'d? The 15 `unref` sites say this matters to us.
- What is the real gzip delta on the _existing_ client bundle (not the isolated
  programs measured here) for option B? `packages/*/dist` was not built in this
  worktree, so the numbers above are per-module, not per-bundle.
- Does our `oxlint` pipeline (anti-slop rules resolve same-file aliases only)
  cope with `Effect.gen` generators, or does the Effect rule set need
  `typescript-eslint`-grade type information?
- Is `@effect/atom-react` (v4-only, unstable) actually able to serve
  `useSyncExternalStore` semantics over a 10k-row replica, or does `Atom.pull`
  re-render on the wrong granularity?
- What does `@effect/platform-browser` add for IndexedDB — anything, or do we
  keep `packages/storage` untouched?

## Reproduction

Bundle sizes **[measured]**:

```bash
mkdir -p /tmp/effsize && cd /tmp/effsize
npm i effect@4.1.4 @effect/atom-react@4.1.4 @sinclair/typebox@0.34.52 react@19 esbuild
# each probe: one file per row of the table, then
npx esbuild s/PROBE.ts --bundle --format=esm --minify --outfile=o/PROBE.js --external:react
gzip -9 -c o/PROBE.js | wc -c
```

The comparison points for the current client, from the repo root (no workspace
build needed — esbuild follows the `src` entries; third-party deps stay
external because this worktree had no `node_modules`):

```bash
npm i --no-save esbuild@0.25.0
# whole stack: client + core + storage + schema + write inlined
cat > /tmp/stack.mjs <<'EOF'
import { build } from "esbuild";
import { resolve } from "node:path";
const r = process.cwd();
await build({
  entryPoints: [resolve(r, "packages/client/src/index.ts")],
  bundle: true, format: "esm", minify: true, outfile: "/tmp/stack.js",
  alias: {
    "@ebbjs/core": resolve(r, "packages/core/src/index.ts"),
    "@ebbjs/core/seed": resolve(r, "packages/core/src/seed/index.ts"),
    "@ebbjs/storage": resolve(r, "packages/storage/src/index.ts"),
    "@ebbjs/storage/memory": resolve(r, "packages/storage/src/memory/index.ts"),
    "@ebbjs/storage/indexeddb": resolve(r, "packages/storage/src/indexeddb/index.ts"),
    "@ebbjs/storage/replica": resolve(r, "packages/storage/src/replica/index.ts"),
    "@ebbjs/storage/types": resolve(r, "packages/storage/src/types/index.ts"),
    "@ebbjs/write": resolve(r, "packages/write/src/index.ts"),
    "@ebbjs/schema": resolve(r, "packages/schema/src/index.ts"),
  },
  external: ["eventsource-client", "@sinclair/typebox", "@sinclair/typebox/value", "@msgpack/msgpack"],
  logLevel: "error",
});
EOF
cp /tmp/stack.mjs ./.stack.mjs && node ./.stack.mjs && rm ./.stack.mjs
stat -c%s /tmp/stack.js; gzip -9 -c /tmp/stack.js | wc -c   # 184750 / 59528
# packages/client alone
npx esbuild packages/client/src/index.ts --bundle --format=esm --minify \
  --external:'@ebbjs/*' --external:eventsource-client --external:'@sinclair/*' \
  --external:'@msgpack/*' --outfile=/tmp/client-own-min.js
gzip -9 -c /tmp/client-own-min.js | wc -c   # 35787
```

And the only release npm has (`latest` is `0.3.0`, behind this tree's 1.1.0 — so
treat it as a sanity check, not the denominator):

```bash
npm pack @ebbjs/client@latest && tar xzf ebbjs-client-*.tgz
npx esbuild package/dist/index.js --bundle --format=esm --minify \
  --external:'@ebbjs/*' --external:eventsource-client --external:'@sinclair/*' \
  --outfile=min.js
gzip -9 -c min.js | wc -c   # 37347
```

Per-call overhead **[measured]**: `node --expose-gc bench.mjs`, medians of 7
trials of 100k iterations, for `Effect.runSync(Effect.succeed|Effect.sync|
Effect.gen)` and for `yield* Effect.succeed|Effect.sync` inside one running
fiber.

Type-check cost **[measured]**: `tsc` 5.9 with
`{"strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext",
"moduleResolution": "bundler", "skipLibCheck": true, "types": []}` over a
single-file program, three runs each, `/usr/bin/time`.
