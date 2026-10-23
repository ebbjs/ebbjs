# Server functions (#112): slice breakdown

Re-sequencing of §4 ("Slices") in
[`112-server-functions-plan.md`](./112-server-functions-plan.md). The
architecture, packages, seams, limits, and risks in that document stand; this
document only changes **what ships in what order**.

Written after review on `main` @ `bba5cba`. Decisions taken in that review:

| Question                         | Decision                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| First consumer                   | None yet. Optimize for learning speed; the demo is the deliverable       |
| Bun runner vs fake runner        | Server half is built first against an in-process fake runner             |
| S0 (package extraction)          | Deferred to the write milestone (M2)                                     |
| SDK package                      | `@ebbjs/server` is the SDK; the current harness becomes `@ebbjs/testing` |
| Dev loop                         | CLI watcher bundles and uploads; the server never runs a bundler         |
| Pool, signing, services, secrets | All hardening. The flag flips at M5                                      |

## Settled decisions

Ten decisions from the design pass that followed the re-sequencing. They are
binding on M0–M3 and each points at the code that constrains it.

1. **Wire encoding: JSON, throughout.** Frames are `<<len::32, json>>`; the
   `commit` payload is the core `Action` verbatim with `hlc` in its string form
   — no msgpack, no base64. The server already accepts it:
   `ActionValidator.normalize_hlc/1` takes "integers or string representations"
   and normalizes once in `to_validated_action/1`, and `compare_hlc/2` parses
   strings too. Guardrail: the payload is encoded only in `Functions.Protocol`
   and its TypeScript counterpart, never inline at a call site, and the shared
   fixtures are the contract. Swapping to msgpack or to a whole-frame msgpack
   protocol later stays cheap precisely because of that.
2. **Commit is fail-whole.** One Action per commit. Any rejection → `422` with
   the reason and nothing written; `{:error, _}` → `500` with the outcome
   unknown (a commit failure abandons the GSN range, so "nothing happened" is
   not a claim we can make); a handler that throws before submitting → nothing
   submitted. No partial apply: `validate_and_authorize/3` and
   `Authorizer.authorize/3` reject whole Actions, so N Actions would be the
   only way to get partiality, and that would break the atomicity the feature
   is built on. M2 adds pre-flight at write-buffer time (the client planner's
   membership and ownership checks) so rejections surface at the offending
   `ctx.create` call; the hard-fail mapping stays as the backstop.
3. **Idempotency is the platform's job.** `action_id` is derived from
   `invocation_id` (an `a_`-shaped hash), so a retry carrying the same
   `Idempotency-Key` is deduped by `cf_action_dedup` and returns
   `{:ok, {0, 0}, []}` without claiming a GSN. The result carries a `replayed`
   flag, because `{0, 0}` alone already means two things (`writer.ex:202-206`).
   Content under a repeated id is silently dropped — including a retry whose
   handler produced different writes — and that must be documented. Without a
   stable key, `invocation_id` is fresh per request and none of this engages.
4. **Error envelope follows the existing convention.**
   `{"error": "<code>", "details"?: "<text>", "invocation_id", "version"}`,
   plus `"retryable": true` on `408`/`429`/`503`. `error` is the code, as it is
   on every other endpoint; no `message` field and no second vocabulary.
   `invocation_id` and `version` appear in success and error bodies alike, and
   as response headers.
5. **Validation issues are structured, and only validation issues are.**
   `"issues": [{"path": "items[0].name", "message": "..."}]` on
   `invalid_input` and `invalid_output`, dotted paths, first 10 only. `details`
   stays a string for single-reason write-pipeline failures — `RejectionSchema`
   publishes it as `String | Null`.
6. **The flag is boot-time, with an env override.** `Functions.children/0`
   returns `[]` or the supervisor, exactly like `action_export_children/0`, and
   `EBB_FUNCTIONS_ENABLED` overlays config the way `EBB_DATA_DIR` does. Disabled
   means the route is absent (`404`), not a `503`. One config key:
   `config :ebb_server, :functions, enabled: ..., bundle_dir: ..., env: ...,
services: ...`. `:functions_enabled` never exists. There is no per-request
   gate: a release cannot reload config, so a runtime-flippable flag would look
   like a kill switch and not be one. The real kill switch is per-function
   disable at M3, plus restart-with-env for emergencies.
7. **The fake runner is scripted by data.** `Functions.Worker.Fake` interprets a
   declarative step list (`{:call, "get", ...}`, `{:expect_reply, ...}`,
   `{:result, ...}`), and that format _is_ M1's conformance fixture format, so
   M0's fake tests become the runner's spec. A function-script escape hatch
   covers the nondeterministic cases (concurrent host calls, a frame after
   close). Timeout needs no scripting (empty script); the crash test kills the
   fake's process.
8. **The runtime uses its own clock.** `createClock()`/`localEvent` in the
   runtime, no `now_ms` in the `invoke` frame. The runner shares the host clock
   with `ActionValidator`'s 120 s drift check, so drift is a browser problem
   that does not apply here, and equal HLCs are resolved deterministically by
   `update_id` (`field_merge.ex:82-84`). Buying `now_ms` for a future multi-host
   runner is speculative: the frame is JSON, so adding a field later is
   non-breaking.
9. **Global `fetch`, no `ctx.fetch`.** v1 documents `fetch` as unguarded and
   egress policy as the control. npm SDKs call global `fetch` internally, so a
   `ctx.fetch`-only surface would leave any allowlist bypassable while looking
   enforced. If M5 enforces anything it wraps global `fetch` in the runner
   bootstrap, which reaches SDK internals too.
10. **One implementation per path, extracted first.** A standalone
    no-behaviour-change PR extracts `entity_json/1`, a `for_actor(entity_id,
actor_id)` read wrapper (the place `can_read?` is actually applied, since
    `EntityStore.get/3` ignores its actor argument), and a
    `submit(actions, actor_id)` write wrapper (`validate_and_authorize` →
    `write_actions` → both rejection formatters). `/entities/:id`,
    `/sync/actions`, `Host.get`, and `Host.commit` then share them, so parity is
    structural rather than tested. It lands before M0 so the feature PR stays
    additive and a regression in either one cannot hide behind the other.
    `/entities/query` is untouched — `ctx.query` is out of v1.

## Sequencing rule

Every milestone ends with **something a person can run or watch**, plus tests
that fail before it and pass after. A milestone whose acceptance criteria are
all "internal invariant holds" is a subtask, not a milestone: push it down into
the milestone it belongs to.

The original S0–S9 ladder was horizontal — nothing was callable end to end
until S7, S0 moved 3.7k lines of client code before any functions code existed,
and S3 built a version store before there was a bundle to version. This ladder
inverts that: get one function invoked, reading and writing, before owning a
packet of infrastructure.

| Old                                                     | New                                                |
| ------------------------------------------------------- | -------------------------------------------------- |
| S1, S2 (partial), S5, S6, S7 (partial)                  | **M0** — server half against a fake runner         |
| S1 (Bun half), S2 (partial), S4 (SDK + runner + bundle) | **M1** — real Bun runner, exec + reads             |
| S0, S6                                                  | **M2** — writes, and the shared planner lands here |
| S3, S7 (validation)                                     | **M3** — store, versioning, schema validation      |
| S8 (unsigned), S4 (client map)                          | **M4** — authoring loop and client                 |
| S2 (rest), S7 (rest), S8 (signing), S9                  | **M5** — hardening before the flag flips           |

---

## M0 — Server-side walking skeleton (fake runner)

**Goal.** A function can be invoked over HTTP, read an entity, and commit an
Action — with no Bun, no SQLite, no CLI, and no client.

**Depends on.** Nothing, beyond the extraction PR in settled decision 10 — the
shared read and write seams M0 calls. All Elixir, all `mix test`.

### Subtasks

1. `Functions.Protocol` — `encode_frame/1`, `decode/1` for
   `<<len::32, json::binary>>` with a partial-frame buffer, and frame
   constructors for `invoke`/`reply`/`result`. `commit` carries the `Action`
   verbatim (decision 1). Tests: round-trip, split delivery, oversize frame
   refused, and the canonical frames match the shared fixture files.
2. `Functions.Worker` — a transport behaviour (`start/1`, `send_frame/2`,
   `close/1`, `os_pid/1`, `alive?/1`) plus `Functions.Worker.Fake`, an
   in-process implementation interpreting the declarative script format from
   decision 7, with a function-script escape hatch. This is the seam the whole
   milestone hangs on, and it stays as the fast test double after M1.
3. `Functions.Host` — the only module allowed to touch `EntityStore`,
   `PermissionChecker`, `Writer`, `Logger`, `Telemetry`. Two ops for now:
   `get` and `commit`, both delegating to the shared seams from decision 10.
   - `get` returns the same view `/entities/:id` returns, and inherits its
     permission rule. `EntityStore.get/3`'s actor argument is `_actor_id` — it
     is ignored, and reads are unfiltered — so the wrapper is where the rule
     lives. A test asserting a non-member gets `null` is the acceptance
     criterion, not a nicety.
   - `commit` submits exactly one Action with `actor_id` from the invocation
     context (never from the frame) and applies the fail-whole mapping from
     decision 2: rejection → `422` with the reason, `{:error, _}` → `500`
     outcome-unknown. Setting `actor_id` server-side is the security property
     this milestone exists to prove.
4. `Functions.Invocation` — send `invoke`, loop over host calls, map
   `result` to `{:ok, value} | {:error, code, message}`, own the deadline
   timer. Test: a scripted fake runner drives a get → commit → result sequence
   and the loop answers every call in order.
5. `Functions.Bundle` + `Functions.BundleCache` over a **loader behaviour**: the
   loader returns envelopes and code for a name, and the cache verifies the
   digest, indexes in memory, and answers `active/1`. `DirLoader` ships now and
   reads `*.envelope.json` (name, version, contract, access, timeout_ms, entry,
   code digest) from a directory, re-stat'ing for a changed mtime or digest on
   each invoke in dev so replacing a bundle needs no server restart. M3 adds
   `StoreLoader`; the cache does not change. Tests: unknown name, digest
   mismatch, duplicate active version, changed-on-disk bundle is picked up.
6. `Functions.Access` — `GroupCache.get_actor_groups/1` already returns
   `%{group_id, permissions}` per membership, so a grant check needs no new
   storage code: any membership whose permissions include `function.<name>` or
   `function.*` passes; `access: "authenticated"` passes for any resolved
   principal. Denied → `403` **before checkout**; the fake counts spawns and the
   test asserts zero.
7. Router and supervision — `Functions.children/0` (decision 6) returns `[]`
   unless `:functions, enabled: true` or `EBB_FUNCTIONS_ENABLED` is set;
   `Sync.Router` keeps `AuthPlug` and adds `forward "/functions", to:
Functions.Router`; `POST /functions/:name` returns
   `{ok: true, result, invocation_id, version}` or the envelope from decisions
   4 and 5. Tests: flag off → route absent (`404`); flag on → invoke with
   `x-ebb-actor-id` (bypass mode already exists).
8. Deadline — timer → `Worker.close/1` → `408`. Test: a fake runner that never
   replies. Process-group kill, OOM, and orphan reaping are M5; the transport
   `close/1` contract is what M5 strengthens.
9. Integration test — seed group/member/entity with `test/support/helpers`,
   invoke through the router, have the fake emit a `commit`, then assert the
   Action is visible on `/sync/live` (SSE) and through `GET /entities/:id`.

### Acceptance

A single `mix test` run proves: invoke → read → write → observable to a
subscriber; `403` before any worker spawn; timeout kills the invocation and the
server stays up; `function.*` and `function.<name>` both grant.

### Not here

Param validation, output schema, secrets, service principals, pool, store,
versioning, CLI, client, Bun, signing.

---

## M1 — Real Bun runner: exec and reads

**Goal.** The same fixture function runs in a real Bun process for a real
request, and `ctx.get` still respects permissions.

**Depends on.** M0.

### Subtasks

1. `packages/functions-protocol` (private) — the TS frame codec mirroring
   `Functions.Protocol`, plus shared JSON fixtures. The conformance test runs
   the same fixtures on both sides so the wire format has two independent
   implementations before either is load-bearing.
2. `packages/functions-runtime` (private) — `HostTransport` interface and the
   `ctx` factory: `get`, `actor`, `caller`, `invocationId`. `get` returns the
   view `/entities/:id` returns, typed as the already-published
   `EntityResponseSchema` from `@ebbjs/client`, so the shape is not redefined.
   No `ctx.fetch` — handlers use global `fetch` (decision 9). Unit-tested
   against a fake transport, no socket.
3. SDK package — rename `packages/server` → `packages/testing`
   (`@ebbjs/testing`), update `examples/*`, the e2e imports, and the root
   `package.json`. Then a new `packages/server` with `defineFunction`,
   `FunctionSchema`, `p` (TypeBox-backed; `@sinclair/typebox` is already a
   dependency of `@ebbjs/client`), and `ctx` types. Type tests assert params
   flow into the handler and the output type is inferred from the return.
   Adapters (zod/valibot/arktype) and the optional `output` schema are **not**
   here.
4. `packages/runner` (private) — Bun entrypoint: connect to the socket named in
   argv, send `ready`, receive `invoke`, evaluate the IIFE bundle, run the
   handler, answer host calls, send `result`, exit.
5. `Functions.Worker.Bun` — `:spawn_executable` Port, socket in the data dir
   mode `0600`, scrubbed env, one process per invocation. `Functions.Pool`
   keeps M0's naive shape (`checkout` spawns); pre-warming is M5 and must not
   change this interface.
6. Bundling — `packages/cli` is created here with `bundle.ts` and
   `envelope.ts` only: `platform: "neutral"`, `format: "iife"`,
   `target: "es2022"`, `bundle: true`, `node:` imports rejected, envelope
   written beside the bundle. The M1 test script calls these modules directly;
   the CLI commands arrive in M4. Creating the package now is the point — the
   alternative is writing the esbuild setup twice, once as a throwaway test
   script and again in the CLI. `esbuild` becomes a declared dependency here
   (today it is only present transitively via vite).
7. Toolchain — Bun version pin, a check in `scripts/setup-ebb-server.sh`, and a
   CI job that installs Bun. Integration tests are tagged and skipped when Bun
   is absent, so `mix test` stays green for everyone else.

### Acceptance

`mix test --include bun` round-trips an echo, a `ctx.get`, and a native
`fetch` through a real Bun process; the same conformance fixtures pass against
the fake and real runners; sockets are `0600`; `node:` import fails at bundle
time; the permission-parity test from M0 passes with the real runner.
Invocation latency is **measured and reported in the PR, not asserted** — the
number decides whether M5's pool is required or merely nice.

### Not here

Writes, store, versioning, CLI, client, pool, secrets, service principals.

---

## M2 — Writes, and the shared planner (S0 lands here)

**Goal.** `ctx.create/update/delete/relate/unrelate` produce the exact wire
Updates the client produces, buffered and committed as one Action.

**Depends on.** M1.

### Subtasks

1. S0, scoped to what writes need: move `operations.ts`, `atomic.ts`,
   `relationship.ts`, `generated-parts.ts`, `membership.ts` and the schema
   registry into `@ebbjs/schema` / `@ebbjs/write`, with `@ebbjs/client`
   re-exporting for compatibility. A move plus re-exports, not a rewrite; the
   existing client suite is the regression gate.
2. Goldens — create/update/delete/relate/unrelate and an atomic batch, shared
   as fixtures between `@ebbjs/client` tests and the runtime tests. Add a
   property test: a random operation batch produces identical Updates from both
   planners.
3. `functions-runtime` write surface — buffered Updates, `ctx.commit()`, the
   read-your-writes overlay, and the single `commit` frame at return.
4. Pre-flight (decision 2) — each buffered write is checked against
   `Authorizer` at `ctx.create(...)`-time, the way the client planner does
   (`operations.ts`, `atomic.ts`), so a membership or ownership error surfaces
   at the offending call instead of at return. The fail-whole mapping stays as
   the backstop for anything that changed in between.
5. `Functions.Host` `commit` hardening — rejection shapes matched against the
   HTTP path via the shared `submit/2` seam, `actor_id` override attempted from
   the frame is ignored, and a handler that throws before returning commits
   nothing (assert zero Actions in the log).
6. Idempotency (decision 3) — derive `action_id` from `invocation_id`, surface
   `replayed` in the result, and document that content under a repeated id is
   silently dropped.

### Acceptance

Byte-identical Actions from client and runtime for every golden operation; a
handler that throws leaves no Action; a rejection surfaces the same reason
string a client would see; created entity is visible to the caller mid-handler
(overlay) and to an SSE subscriber after commit.

### Not here

Store, CLI, client contract map, query/getMany.

---

## M3 — Store, versioning, schema validation

**Goal.** Bundles live in `functions.db`, are activated and rolled back
atomically, and bad params are rejected before a worker is spawned.

**Depends on.** M2.

### Subtasks

1. `Functions.Store` — `data/functions.db` via exqlite on the
   `Storage.SQLite` GenServer pattern, the `function_versions` table from the
   plan (§2.10), migrations, retention (last N).
2. `Functions.BundleCache` gains a store loader; the directory loader from M0
   stays for tests and dev. In-flight pinning test: an activation during an
   invocation does not affect that invocation.
3. `POST /functions/:name/versions` and `/activate` with admin auth, plus
   `rollback` and `GET /functions`. Exactly one active per name is a DB
   constraint, not an application check.
4. `Functions.Validate` — add the `ex_json_schema` dependency (not currently in
   `mix.exs`), resolve each version's schemas once in the cache, validate params
   before checkout (`400 invalid_input`) and the optional output after the
   result (`422 invalid_output`). Issues are carried as decision 5 specifies:
   `issues: [{path, message}]`, dotted paths, first 10. A corrupt or
   unresolvable schema fails activation.
5. Per-function disable — `status` distinguishes `active` from `disabled`, so
   the operational kill switch from decision 6 is a store operation rather than
   a config change.
6. `mix openapi.gen.spec` regenerated; `openapi.yaml` checked in.
   `:functions` config is the single nested key from decision 6.

### Acceptance

Restart preserves versions and resolved schemas; activation is atomic; rollback
restores prior behavior; params validation rejects before checkout (fake spawn
count is zero); output schema rejection maps to `422`.

---

## M4 — Authoring loop and client

**Goal.** A person can write a function, run it locally, watch it work, and
call it from a typed client.

**Depends on.** M3.

### Subtasks

1. `packages/cli` (`@ebbjs/cli`, bin `ebb`) — created in M1 with the bundler;
   M4 adds the commands: `ebb deploy [--no-activate] [--url] [--token]` —
   bundle, extract name/access/limits/schemas, upload, activate;
   `ebb functions list | activate | rollback`. Config loading from
   `ebb.config.ts`. No signing.
2. Dev loop — `ebb dev` watches `functions/` with a debounced `fs.watch`,
   bundles, uploads, activates, and regenerates the contract map.

   The watcher lives in the CLI, not the server. The bundler is esbuild and the
   type feedback is TypeScript, so a server-side watcher would have to shell out
   to Bun on every change and surface TS build errors through the BEAM to the
   author's terminal; it would also add a file-watcher dependency to an Elixir
   app that deliberately has none (`mix.exs`: _"No file watcher"_), and it puts
   the same code in the process that does not own the compiler. The "one command
   to start everything" argument is already covered by the root `dev` script's
   `concurrently`, which gains a `functions` pane.

   Before M3 the same command writes envelopes to a directory instead of
   uploading (the `--dir` mode M0's loader already supports, and the mode the
   tests use). Once M3 lands, dev goes through real upload and activation, so
   dev exercises versioning and cannot diverge from the deploy path.

3. Client contract map — `ebb functions types` emits
   `functions.typesOut`, `functionContract<D>` in `@ebbjs/client`,
   `createClient({ functions })` inferring `client.functions.<name>`,
   type-only imports verified (no server code in a browser bundle).
4. Example (`proofread`) and docs: `ebb_server/README.md` architecture section,
   ops docs for the data dir and kill-switch.

### Acceptance

deploy → generate → invoke, with `client.functions.foo` typed from the
definition; generated names match the deployed set; `--no-activate` leaves the
pointer alone; the example runs from a clean checkout.

---

## M5 — Hardening before the flag flips

**Goal.** Turn the feature on by default without shipping an outage.

Everything deferred from M0–M4, grouped by what it protects:

| Area            | Work                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool            | Pre-warmed workers, bounded queue, `503` saturation, spawn-failure counters. Gated on M1's latency numbers                                     |
| Process hygiene | Own process group per worker, `kill -9` group fallback, orphan test, temp working dir                                                          |
| Resources       | Memory limit (Linux cgroup/`ulimit`; macOS gets nothing — document it), host-call budget, log caps, 256 KB / 1 MB size limits                  |
| Principals      | Service credentials, `x-ebb-service-token`, static subject actors, constant-time compare; `access: "authenticated"` tested against both kinds  |
| Secrets         | Per-function env allowlist, scrubbed runner env, missing secret fails before the handler, redaction                                            |
| Signing         | Ed25519 over name/version/digest, trusted keys, `--sign`. Confirm this is v1 at all — with a single-operator deploy story it may stay deferred |
| Observability   | `ebb.functions.invoke` span, per-version ETS counters, pool gauges, `ebb functions health`                                                     |
| Packaging       | Bun in the Dockerfile and release, boot check, pin documented; CI covers the Bun job                                                           |
| Fetch           | Host allowlist wrapper + `fetch_audit` telemetry (or an explicit decision that egress policy is the only guardrail)                            |

### Acceptance

The adversarial list in the plan §5 passes: oversized bodies and responses, log
floods, missing secrets, cross-actor reads, `node:` imports, saturation,
timeout races, killed-worker follow-up invocation. Only then does
`functions.enabled` default to `true`.

---

## Cut from v1 entirely

Zero coupling to the core risk; add when a consumer asks.

`ctx.getMany`, `ctx.query`, `ctx.log`, `fetch_audit`, `cancel` frames, msgpack
frames, `PROTOCOL_VERSION` negotiation (keep the field), `Idempotency-Key`,
`ebb functions health`, schema-adapter matrix (zod/valibot/arktype), signing (if
M5 says so), multi-definition file rejection, `413` per-field limits.

## Cross-cutting, easy to forget

- `CONTEXT.md` vocabulary: Function, Invocation, Subject, Bundle, Runner,
  Worker. These are the terms the code and docs will use.
- `ex_json_schema` is not a dependency today, despite being the plan's
  validator. Adding it is a `mix.exs` change in M3.
- `esbuild` is a declared dependency of `@ebbjs/cli` from M1 (today it is only
  transitive via vite), and the root `dev` script gains a `functions` pane in M4.
- The e2e harness (`@ebbjs/testing` after the M1 rename) needs a way to start a
  server with functions enabled and a bundle directory. That helper is what
  makes M0–M2 testable end to end from JavaScript too.
- `docs/research/112-server-functions-plan.md` §4 and the issue body's
  sub-issue list both need to be pointed at this document.
