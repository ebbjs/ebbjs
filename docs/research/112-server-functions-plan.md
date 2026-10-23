# Server functions (#112): implementation plan

Plan for [issue #112](https://github.com/ebbjs/ebbjs/issues/112). Written
2026-10-23 against `main` @ `bba5cba`.

**Status: accepted.** The Epic body mirrors this plan. No server-functions code
is in the repo yet.

| Question          | Decision                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Execution         | Out-of-process Bun runner, shipped with the server; one OS process per invocation from a pre-warmed pool                           |
| Handler           | Async/await, native promises; no replay                                                                                            |
| Declaration       | `defineFunction(schema, params, handler, options?)`, mirroring `defineAction(schema, run)`                                         |
| Params            | `FunctionSchema` (Standard Schema + `toJSONSchema()`); type inferred into the handler                                              |
| Validation        | Server validates the JSON Schema before worker checkout; runner revalidates with the full schema                                   |
| Output            | Inferred from the handler; optional `output` schema adds validation                                                                |
| Name              | The exported binding name; `export default` and multi-definition files are rejected                                                |
| Client            | CLI-generated contract map; `createClient({ functions })` infers `client.functions.<name>`; no generic                             |
| Invocation access | Permission-gated: `function.<name>` / `function.*`; optional `access: "authenticated"` override                                    |
| Principals        | `actor` (user or agent; grants from group memberships) and `service` (job/webhook; grants from a credential, static subject actor) |
| Writes            | Buffer Updates, commit one Action at handler return                                                                                |
| Store             | Dedicated SQLite `functions.db` (not the materialized cache, not RocksDB)                                                          |
| Secrets           | Per-function allowlist, sent per invocation                                                                                        |
| Signing           | Ed25519 over name/version/digest, verified against server-trusted keys                                                             |
| Deferred          | In-process engine behind the same protocol; actor onboarding; browser-side validation                                              |

---

## 1. Why a runner process

The runner is a separate OS process for three reasons:

- **Resilience.** A fault in the JS runtime, a runaway function, or an OOM kills
  the worker, not the BEAM. The Writer, SSE connections, storage caches, and
  connected clients are unaffected. A failed invocation returns `503`;
  committed writes survive.
- **Modularity.** `ctx` becomes a real protocol. The runner has no database
  handle; every read and write goes back through Elixir's permission and
  storage paths.
- **Simplicity.** No Rust, no NIF toolchain, no native code in the server. Bun
  provides native async/await, `fetch`, Web Streams, and npm; Elixir stays at
  1.17.

The cost is roughly 100 µs per host call. For I/O-bound functions — the reason
this feature exists — that is noise next to the storage path (~0.1–1 ms per
read, ~1–5 ms per write) and external calls. An in-process engine remains a
documented optimization behind the same frame protocol if measurements ever
show the runner's per-invocation cost dominating.

---

## 2. Architecture

### 2.1 Topology

```
POST /functions/:name                       (Bandit request process)
  │
  ├─ AuthPlug → principal + subject actor
  ├─ Functions.BundleCache.active(name)
  ├─ Functions.Access (function.<name> grant) → 403 before checkout
  ├─ Functions.Validate (params JSON Schema) → 400 before checkout
  └─ Functions.Invocation.run/3
       │
       ├─ Pool.checkout()                    (pre-warmed runner process)
       ├─ send {invoke, bundle, input, subject_actor, env, limits}
       │
       │   Bun process (one invocation, then exits)
       │     eval bundle → handler(ctx, params)
       │     ctx.get / query  ─── frame ──▶  EntityStore + can_read?
       │     ctx.commit      ─── frame ──▶  PermissionChecker + Writer
       │     fetch            → native Bun fetch (streams, npm)
       │     ctx.log          ─── frame ──▶  Logger
       │
       ├─ service host calls, reply
       ├─ receive {result} → 200 / 4xx / 5xx
       └─ on deadline → close socket + kill process group
       │
       └─ worker exits; pool spawns a replacement in the background
```

### 2.2 Runner lifecycle

`Functions.Runner.Pool` keeps N idle Bun processes pre-spawned (default
`min(4, schedulers_online)`, configurable). Each has connected to its own Unix
socket and sent `ready`. On invocation:

1. Check out an idle worker (bounded queue; past the bound → `503`).
2. Send the `invoke` frame: bundle, digest, entry, input, subject actor, env,
   limits.
3. The worker runs one invocation, sends host-call frames, and returns
   `result`, then exits.
4. The pool reclaims the slot and spawns a replacement in the background.

One process per invocation means a timeout is a `kill`, not a cooperative
interrupt — Bun cannot interrupt a synchronous CPU loop. It also guarantees no
state leaks between invocations. Bun startup (~10–100 ms) is hidden by the idle
pool; a pool of four sustains roughly 100–200 invocations/s.

Process hygiene: each worker gets its own process group, a temp working
directory, a scrubbed environment, and a socket in the data dir with mode
`0600`. The timeout path kills the group; a test asserts no orphan survives.

### 2.3 Protocol

Length-prefixed JSON frames (`<<len::32, json>>`) over a Unix socket. JSON first
for debuggability; msgpack (`msgpax` is already a dependency) is an upgrade if
frame cost ever shows up. **Settled:** frames stay JSON, and the `commit`
payload is the core `Action` verbatim with `hlc` in its string form — the server
already accepts that (`ActionValidator.normalize_hlc/1`). See settled decision 1
in [`112-slice-breakdown.md`](./112-slice-breakdown.md).

Elixir → worker:

| `type`   | Fields                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `invoke` | `invocation_id`, `name`, `version`, `digest`, `bundle`, `entry`, `input`, `subject_actor_id`, `env`, `limits` |
| `reply`  | `call_id`, `ok`, `value` \| `error`                                                                           |
| `cancel` | best effort; the real cancel is socket close + kill                                                           |

Worker → Elixir:

| `type`        | Fields                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `ready`       | `pid`, `runner_version`, `protocol_version`                             |
| `call`        | `call_id`, `op` (`get` \| `get_many` \| `query` \| `commit`), `payload` |
| `log`         | `level`, `message` (fire-and-forget, capped)                            |
| `fetch_audit` | `method`, `url`, `status`, `duration_ms` (native fetch)                 |
| `result`      | `ok`, `value` \| `kind`, `message`                                      |

`PROTOCOL_VERSION` is checked on `ready`; mismatch disables functions at boot.
`FUNCTIONS_CONTRACT` (bundle ABI) is stamped by the CLI and supports N/N-1.

### 2.4 Runtime contract

Handlers are async. `ctx.*` are real promises. The params schema is a runtime
value whose type flows into the handler.

```ts
// functions/proofreadDocument.ts
import { defineFunction, p } from "@ebbjs/server";
import { schema } from "../src/schema";

export const proofreadDocument = defineFunction(
  schema,
  p.object({ documentId: p.string(), workspaceId: p.string() }),
  async (ctx, params) => {
    // params: { documentId: string; workspaceId: string } — inferred
    const doc = await ctx.get(params.documentId);
    if (!doc) throw new Error(`not found: ${params.documentId}`);

    const res = await fetch("https://api.example.com/proofread", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.env.API_KEY}` },
      body: JSON.stringify({ text: doc.fields.body }),
    });
    const comments = await res.json();

    for (const c of comments) {
      ctx.create("Comment", c, { groups: [params.workspaceId] }); // buffered
    }
    return { commentCount: comments.length }; // inferred output type
  },
);
```

```ts
export type FunctionSchema<T> = StandardSchemaV1<T> & {
  /** Draft-7 JSON Schema used by the RPC boundary. */
  toJSONSchema(): Record<string, unknown>;
};

export interface FunctionOptions<O = unknown> {
  access?: "granted" | "authenticated";
  timeoutMs?: number;
  memoryMb?: number;
  output?: FunctionSchema<O>;
}

export interface FunctionDef<S, I, O> {
  schema: S;
  params: FunctionSchema<I> | undefined;
  output?: FunctionSchema<O>;
  handler: (ctx: Context<S>, params: I) => O | Promise<O>;
  access: "granted" | "authenticated";
  timeoutMs?: number;
  memoryMb?: number;
  /** Type-only markers; never present at runtime. */
  "~input"?: I;
  "~output"?: O;
}

export function defineFunction<S, P extends FunctionSchema<any>, R>(
  schema: S,
  params: P,
  handler: (ctx: Context<S>, params: StandardSchemaV1.InferOutput<P>) => R,
  options?: FunctionOptions<Awaited<R>>,
): FunctionDef<S, StandardSchemaV1.InferOutput<P>, Awaited<R>>;

// no params
export function defineFunction<S, R>(
  schema: S,
  handler: (ctx: Context<S>) => R,
  options?: FunctionOptions<Awaited<R>>,
): FunctionDef<S, void, Awaited<R>>;
```

| Member                                 | Semantics                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(id)`                              | `can_read?` + `EntityStore.get`; `null` when absent or not visible                                                                                              |
| `getMany(ids)`                         | One host call                                                                                                                                                   |
| `query(type, filter, opts)`            | `EntityStore.query`, permission-filtered                                                                                                                        |
| `create/update/delete/relate/unrelate` | Buffer wire Updates via `@ebbjs/write`                                                                                                                          |
| `commit()`                             | Flush buffered Updates as one Action; also automatic at return                                                                                                  |
| `actor`                                | `{ id }` — the subject actor; never client-supplied                                                                                                             |
| `caller`                               | `{ kind: "actor" \| "service", id }`                                                                                                                            |
| `env`                                  | Frozen per-function allowlist                                                                                                                                   |
| `log(level, ...args)`                  | Fire-and-forget frame → Logger; capped                                                                                                                          |
| `fetch`                                | Native Bun `fetch`, used directly. See settled decision 9: there is no `ctx.fetch` in v1, and any allowlist must wrap global `fetch` to reach npm SDK internals |
| `generateId(prefix)`, `hlc()`          | Same JS code as `@ebbjs/core`                                                                                                                                   |

Timers, filesystem, and sockets are not part of the `ctx` surface. The process
boundary is for resilience, not a security sandbox: function authors are trusted,
and Bun globals are not an authorization boundary.

**`p` and adapters.** `p` is a small TypeBox-backed builder (`p.object`,
`p.string`, `p.number`, `p.boolean`, `p.array`, `p.optional`, `p.nullable`,
`p.literal`, `p.union`, `p.record`) implementing both `~standard` and
`toJSONSchema()`. The SDK also exports `zod`, `valibot`, `arktype`, and
`typebox` adapters. The documented path is `p`; `Type.Object` is never
required. Schemas are validators, not transformers: defaults/transforms are the
runner's job, and the client type is the validated shape.

**Name.** The exported binding name is the function name, route, and permission
verb. `ebb deploy` rejects `export default` and files with more than one
definition. Names match `^[A-Za-z][A-Za-z0-9_-]*$`.

### 2.5 Reads

`ctx.get`/`getMany`/`query` are frames to Elixir, which runs
`PermissionChecker.can_read?` + `EntityStore.get`/`query` as the subject actor.
Rows have the same shape as the HTTP read endpoints (`data.fields`). A denied
read is `null` (no existence oracle). No SQLite or RocksDB access from the
runner.

### 2.6 Writes

Writes buffer in the runtime and commit **one Action at handler return** (or on
`ctx.commit()`):

- one Action = one GSN, one Writer round trip, atomic across Updates;
- a handler that throws before returning commits nothing;
- read-your-writes inside the handler is an overlay of buffered Updates;
- the runtime builds Updates with `@ebbjs/write` and sends one `commit` frame;
  Elixir sets `actor_id` to the subject, then runs `validate_and_authorize` +
  `write_actions`, returning rejection reasons to JS;
- `create` requires explicit `{ groups }`, as in the client API.

External side effects are not rolled back. The read → external call → write
convention is documented.

### 2.7 Access and principals

Invocation is a normal permission. The principal must hold `function.<name>`
(or `function.*`) unless the function declares `access: "authenticated"`.

|                         | User / agent                                           | Service (job, webhook)                  |
| ----------------------- | ------------------------------------------------------ | --------------------------------------- |
| Authenticates with      | `AuthPlug` (external auth; bypass in dev)              | `x-ebb-service-token`                   |
| Grant source            | `function.<name>` on any `groupMember.permissions` row | `permissions` on the service credential |
| Subject (data identity) | The caller                                             | `subject_actor_id` on the credential    |
| Data permissions        | Caller's memberships                                   | Subject actor's memberships             |

Actors are users and agents; agents are not special-cased. A grant is an
ordinary permission string, granted through the existing membership write path
(requires `groupMember.update`). `function.*` grants all functions.

Services are configured statically and never choose an actor:

```elixir
config :ebb_server, :functions,
  services: [
    %{id: "svc_webhook",
      token_sha256: "...",
      subject_actor_id: "svc_webhook",
      permissions: ["function.processWebhook"]}
  ]
```

The server hashes the token and compares in constant time. Service tokens are
accepted only on `/functions/*`; sync routes still require an actor. A webhook
that must act for a specific user runs as a bot subject with the relevant group
memberships; impersonation is not supported.

`Functions.Access` runs before checkout:

```
actor:   GroupCache.get_actor_groups(actor_id) has "function.<name>" or "function.*"
service: credential.permissions has "function.<name>" or "function.*"
override "authenticated": any resolved principal passes
```

Denied → `403`, no runner spawned. A new function is denied until granted; the
deploy CLI prints the permission and `GET /functions` exposes it for admin UIs.
Deploy is a separate admin credential and never implies invoke permission.

Actor onboarding — how a new actor gets its first group and permissions — is a
separate write-path concern, out of scope here.

### 2.8 Secrets

```elixir
config :ebb_server, :functions,
  env: %{"proofreadDocument" => ["API_KEY"]}
```

Values come from the server environment at boot and are sent in the `invoke`
frame. The runner's own environment is scrubbed; the JS context gets a frozen
`env` object. Missing key → `missing_secret` before the handler runs. Values
never appear in telemetry or logs.

### 2.9 Bundle, client contract, CLI

- **Bundle**: esbuild, `platform: "neutral"`, `format: "iife"`,
  `target: "es2022"`, `bundle: true`. Native `fetch`/streams/npm work;
  `node:` imports are rejected at deploy to keep bundles portable.
- **Envelope**: `{name, version, digest, signature?, runtime, contract, access,
timeoutMs, memoryBytes, entry, paramsSchema?, outputSchema?}`. The server
  refuses a bundle built against a newer `contract`.
- **Schemas**: the CLI calls `params.toJSONSchema()` /
  `output.toJSONSchema()` and uploads the draft-7 JSON Schemas. They are covered
  by the digest and signature and stored with the version.
- **Signing**: Ed25519 over `sha256(name, version, digest, created_at)`, key id
  included. The server verifies against `:function_trusted_keys` at upload;
  unsigned bundles are allowed only when no key is configured (dev). Signing is
  provenance/integrity, not authorization. The digest is re-verified at load.
- **Client contract map**: the CLI emits a client-safe module with type-only
  imports and one runtime line per function:

  ```ts
  // src/ebb-functions.generated.ts — emitted by `ebb deploy`
  import { functionContract } from "@ebbjs/client";
  import type { proofreadDocument } from "../functions/proofreadDocument";

  export const functions = {
    proofreadDocument: functionContract<typeof proofreadDocument>("proofreadDocument"),
  };
  ```

  ```ts
  import { functions } from "./ebb-functions.generated";

  const client = createClient({
    serverUrl,
    actorId,
    schema,
    actions: { addToWorkspace },
    functions,
  });

  const { commentCount } = await client.functions.proofreadDocument({
    documentId,
    workspaceId,
  });
  ```

  `createClient` infers the function surface from the map, exactly as it infers
  actions. No generic, no names array, no runtime definition import; the
  generated imports are erased. `functionContract<D>` extracts the phantom
  `~input`/`~output` types from the definition and returns `{ name }` at
  runtime. Output path: `functions.typesOut` in `ebb.config.ts`; generate with
  `ebb deploy` or `ebb functions types`. The file can be committed or
  hand-written.

- **CLI**: `packages/cli` (`@ebbjs/cli`, bin `ebb`):
  `ebb deploy [--no-activate] [--sign] [--url] [--token]`,
  `ebb functions list | activate | rollback | health | types`.

### 2.10 Store and versioning

Dedicated SQLite `data/functions.db`, owned by `EbbServer.Functions.Store`
(same exqlite/GenServer pattern as `Storage.SQLite`). Not the materialized cache
database (documented as rebuildable), not RocksDB (the Action log).

```sql
CREATE TABLE function_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  code TEXT NOT NULL,
  digest TEXT NOT NULL,
  signature TEXT,
  signer_key_id TEXT,
  params_schema TEXT,                 -- draft-7 JSON Schema
  output_schema TEXT,
  contract TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  memory_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,               -- 'active' | 'retired'
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  created_by TEXT,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX idx_function_active ON function_versions(name) WHERE status = 'active';
```

`BundleCache` compiles each version's schema once with
`ExJsonSchema.Schema.resolve/1` and caches the resolved form. Activation is one
transaction; `rollback` activates the previous version. In-flight invocations
hold their bundle, so no drain is needed. Retention: last N versions (default 20) plus anything pinned by `--keep`.

### 2.11 HTTP API

| Method | Path                        | Purpose                                              |
| ------ | --------------------------- | ---------------------------------------------------- |
| `POST` | `/functions/:name`          | Invoke; JSON params in, JSON result out              |
| `GET`  | `/functions`                | Names, active version, permission, schemas (no code) |
| `POST` | `/functions/:name/versions` | Upload a bundle (admin)                              |
| `POST` | `/functions/:name/activate` | Activate a version (admin)                           |

- Identity from `AuthPlug`; the function runs as the subject actor.
- **Access first, then RPC validation**: `Functions.Access` checks the grant,
  then `Functions.Validate` checks the body against the stored params JSON
  Schema; `400 invalid_input` with sanitized `{path, message}` issues. The output schema, when present, is checked after
  the runner returns (`422 invalid_output`). The runner revalidates with the
  full Standard Schema.
- Request body is the params JSON; success is
  `{ok: true, result, invocation_id, version}`. Errors are
  `{error, code, details?, invocation_id, version, retryable?}`, following the
  convention every other endpoint already uses: `error` _is_ the code. See
  settled decisions 4 and 5 in
  [`112-slice-breakdown.md`](./112-slice-breakdown.md).
- Status codes: `400 invalid_input` / malformed body, `401` unauthenticated,
  `403` access denied, `404` unknown function or version, `408` timeout, `413`
  oversize, `422 invalid_output` / `handler_error`, `429`/`503` saturated or
  runner unavailable, `500` platform. Never return a JS stack.
- `Idempotency-Key` is accepted and exposed as `ctx.invocationId`. Settled
  decision 3 goes further: `action_id` is derived from `invocation_id`, so a
  retry is deduped by `cf_action_dedup` and the result reports `replayed`.
- `mix openapi.gen.spec` is regenerated; `openapi.yaml` is checked in.

### 2.12 Limits and failure

| Limit                  | Default                        | Enforcement                                                                    |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| Wall clock             | 30 s per function (max 60 s)   | Elixir deadline; socket close + process-group kill                             |
| Memory                 | 256 MB per worker              | OS limit (cgroup/`ulimit`) + Bun controls                                      |
| Host calls             | 1,000                          | Runner counts; Elixir rejects past the budget                                  |
| Input / output         | 256 KB / 1 MB                  | HTTP and frame limits                                                          |
| Concurrent invocations | pool size (4), queue 20        | Pool checkout; `503` beyond                                                    |
| Log lines / bytes      | 200 / 64 KB                    | Elixir caps                                                                    |
| Fetch                  | host allowlist, 10 MB response | Shim guardrail + `fetch_audit`; deployment egress policy for untrusted authors |

Worker crash / OOM → in-flight `503`, pool respawns, sync unaffected. Deadline →
kill, `503`; committed writes survive. Runner unavailable → function calls
`503`, sync unaffected. There is no rollback of committed writes; uncommitted
Updates are dropped. A deterministic crash is contained to invocations; activate
another version or disable the function instead of restarting the server.

### 2.13 Observability

- `ebb.functions.invoke` span (`start`/`stop`/`exception`) with `name`,
  `version`, `actor_id`, `caller_kind`, `outcome`, `host_calls`, `reads`,
  `writes`, `fetch_calls`, `input_bytes`, `output_bytes`, `queue_ms`,
  `worker_pid`.
- Per-version ETS counters (invocations, errors, timeouts, worker kills) behind
  `ebb functions health`.
- Pool gauges: idle, busy, spawn failures, kills, queue depth.
- `ctx.log`/`console` → Logger with `function`, `version`, `invocation_id`,
  capped. `fetch_audit` → telemetry (URL, status, duration; no headers/bodies).
- Invocation id in every log line and error response.

### 2.14 Packaging

- Bun is a runtime dependency of the server: pin it in the Dockerfile and
  document the dev install. `scripts/setup-ebb-server.sh` checks for it.
- `priv/runner/runner.js` (or a `bun build --compile` binary) ships in the
  release; the BEAM starts the pool via `:spawn_executable` Ports with
  per-worker sockets.
- Config: one nested key, `config :ebb_server, :functions`, holding
  `enabled`, `bundle_dir`, `runner_path`, `runner_count`, `socket_dir`,
  `admin_token`, `trusted_keys`, `env`, `services`. Read at boot by
  `Functions.children/0`; `EBB_FUNCTIONS_ENABLED` overlays `enabled`. No flat
  `:functions_enabled` key exists (settled decision 6).
- Elixir stays at 1.17.3; no Rust toolchain.

---

## 3. Packages and modules

### 3.1 TypeScript packages

| Package                     | Visibility | Purpose                                                                                          |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `@ebbjs/core`               | public     | wire primitives (Action/Update/merge, HLC, ids, msgpack)                                         |
| `@ebbjs/schema`             | public     | entity/relationship/schema definitions, registry, validation                                     |
| `@ebbjs/write`              | public     | operations → wire Updates, atomic batches                                                        |
| `@ebbjs/client`             | public     | sync, replica, queries, function client                                                          |
| `@ebbjs/server`             | public     | SDK: `defineFunction`, `FunctionSchema`, `p` + adapters, `ctx` types, `defineConfig`, re-exports |
| `@ebbjs/functions-protocol` | private    | frames, envelope, versions, shared fixtures                                                      |
| `@ebbjs/functions-runtime`  | private    | `ctx` over a `HostTransport`, buffering, fetch wrapper, validation                               |
| `@ebbjs/runner`             | private    | Bun entrypoint: socket, bundle eval, lifecycle                                                   |
| `@ebbjs/cli`                | public     | deploy, management, signing, contract-map generation                                             |
| `@ebbjs/testing`            | private    | current `@ebbjs/server` harness/seed + test helpers                                              |

`@ebbjs/schema` and `@ebbjs/write` are extracted from `@ebbjs/client`; the
client re-exports them for compatibility. The current private `@ebbjs/server`
harness is renamed to `@ebbjs/testing`.

Dependency direction (no cycles):

```
core → schema → write → client
          │        │
          │        ├── functions-runtime → functions-protocol
          │        │            ▲
          └── server (SDK)     runner
cli → server (types), functions-protocol
testing → core, functions-runtime, client
```

`@ebbjs/client` types the generated contract map; `functionContract` accepts a
structural `FunctionDefLike` (phantom
`~input`/`~output`), so it does not depend on `@ebbjs/server`.

### 3.2 Elixir modules

```
lib/ebb_server/functions/
  supervisor.ex   children + feature flag
  store.ex        functions.db, migrations
  bundle_cache.ex ETS name → active bundle + resolved schemas
  bundle.ex       envelope parse/validate/digest
  signing.ex      Ed25519 verify
  secrets.ex      per-function env allowlist
  validate.ex     JSON Schema params/output validation
  access.ex       principal grants + service credentials
  protocol.ex     frame encode/decode
  pool.ex         capacity, idle queue, checkout, saturation
  worker.ex       Port + socket + frame I/O; deadline; kill
  invocation.ex   request orchestration, host-call loop, result mapping
  host.ex         op dispatch → EntityStore/PermissionChecker/Writer/Logger
  router.ex       /functions endpoints (forwarded from Sync.Router)
  admin.ex        deploy authorization
  health.ex       ETS counters
```

Supervision: `Storage.Supervisor` → `Functions.Supervisor` (when enabled) →
`Sync.Supervisor` → `Telemetry.HTTP` → `Bandit`. `Functions.Supervisor` uses
`rest_for_one`: `Store` → `BundleCache` → `Pool` (with a DynamicSupervisor for
workers) → `Health`.

`Sync.Router` keeps `AuthPlug` and adds `forward "/functions", to:
Functions.Router`. OpenAPI generation and the telemetry route label are updated
for the forwarded routes.

### 3.3 Seams

| Seam                      | Defined in                  | Implemented by                              | Used by                     |
| ------------------------- | --------------------------- | ------------------------------------------- | --------------------------- |
| `FunctionDef` / `Context` | `@ebbjs/server`             | user code                                   | CLI, runner, client (types) |
| `HostTransport`           | `@ebbjs/functions-runtime`  | socket, fake, deferred NIF                  | `ctx`                       |
| Frame protocol            | `@ebbjs/functions-protocol` | runner + `Functions.Protocol`               | server ↔ runner             |
| Host operations           | `Functions.Host`            | —                                           | `Invocation`                |
| Invocation access         | `Functions.Access`          | actor grants, service credentials, override | router before checkout      |
| Worker/Pool               | `Functions.Pool` / `Worker` | Bun process; deferred NIF                   | `Invocation`                |
| Store                     | `Functions.Store`           | SQLite                                      | router, CLI, cache          |

`Functions.Host` is the only module allowed to call `EntityStore`,
`PermissionChecker`, `Writer`, `Logger`, or `Telemetry`. That is both the
permission boundary and the test seam.

---

## 4. Slices

> **Superseded.** The S0–S9 ladder below is kept as the record of the accepted
> design, but it is no longer the work order: it was horizontal, so nothing was
> callable end to end until S7. The re-sequenced ladder (M0–M5) is in
> [`112-slice-breakdown.md`](./112-slice-breakdown.md), and Epic #112 tracks
> the M-milestones as sub-issues. Read that document for sequencing; read this
> one for architecture.

S0–S2 are prerequisites. Each slice ships behind `:functions_enabled` (default
off) until S7. (Superseded — see the note above; the flag is now
`config :ebb_server, :functions, enabled:` and it flips at M5.)

**S0 — Shared write planner.**
Extract `operations.ts`, `atomic.ts`, `relationship.ts`, `membership.ts`,
`generated-parts.ts`, and the schema registry into `@ebbjs/write` /
`@ebbjs/schema`, consumed by `@ebbjs/client` and the runtime.
_Acceptance:_ client tests unchanged; golden fixtures for create/update/delete/
relate/atomic; no new runtime deps.

**S1 — Runner skeleton and protocol.**
`packages/runner` (Bun), frame codec, per-worker Unix socket, Port lifecycle,
pre-warmed pool, `ready` handshake, echo invocation.
_Acceptance:_ `mix test` round-trips an echo through a real Bun runner; a dead
worker is replaced; sockets are `0600`; feature flag off means no process.

**S2 — Execution and isolation.**
Bundle eval, async host calls (`get`, `commit`), deadline process-group kill,
OOM containment, saturation `503`, orphan check.
_Acceptance:_ infinite loop → timeout within the deadline, no orphan; 200
concurrent tiny invocations leave a heartbeat process under 50 ms; `Promise.all`
works; a killed worker fails its invocation cleanly and the next succeeds.

**S3 — Store, schemas, and versioning.**
`Functions.Store` (SQLite), migrations including `params_schema` /
`output_schema`, `BundleCache` + resolved schemas, activation/rollback,
retention.
_Acceptance:_ restart preserves versions and schemas; activation is atomic;
exactly one active per name; an in-flight invocation keeps its bundle; a corrupt
or unresolvable schema fails activation.

**S4 — SDK, runtime, client contract map, bundle.**
`@ebbjs/server` (`defineFunction`, `FunctionSchema`, `p` + adapters, inferred
output, optional output schema), `@ebbjs/functions-runtime` (Standard Schema
validation), generated `client.functions` contract map, envelope with JSON
Schemas, esbuild, metadata extraction, deploy checks.
_Acceptance:_ a fixture bundles and round-trips; `node:` imports rejected;
name/access/limits/schemas extracted; RPC validation rejects bad params without
a handler run; optional output schema yields `invalid_output`; `@ebbjs/write`
goldens pass; npm and SSE-streaming fixtures work; `client.functions.foo` is
typed from the definition and maps errors; the generated map uses type-only
imports.

**S5 — ctx reads.**
`get`/`getMany`/`query` with permission parity and read-your-writes.
_Acceptance:_ non-member sees `null`; dirty entity read-your-writes; 50-id
`getMany` is one host call; query respects limit/permissions.

**S6 — ctx writes.**
Buffered Updates, `commit`, single-Action commit, rejection surfacing, overlay.
_Acceptance:_ created entity visible to caller and SSE subscribers; rejection
matches the HTTP path; a throwing handler commits nothing; the Action matches
the client planner byte-for-byte.

**S7 — HTTP API, RPC validation, access, secrets, limits.**
Four endpoints, admin auth, JSON Schema validation before checkout,
permission-gated invocation, service tokens and subjects, env allowlist,
admission control, OpenAPI.
_Acceptance:_ 400/401/403/404/408/413/422/429/503 paths; invalid params and
missing grants rejected before checkout; a service runs as its subject and
cannot choose an actor; missing secret fails before the handler; bypass works in
dev.

**S8 — CLI, signing, contract-map generation.**
`ebb deploy`, `ebb functions list|activate|rollback|health|types`, config
loading, Ed25519 sign/verify, generated types.
_Acceptance:_ deploy → generate → invoke; rollback restores behavior; tampered
or unsigned (when keys configured) bundles rejected; `--no-activate` leaves the
active pointer; generated names match the deployed set.

**S9 — Observability, docs, example, packaging.**
Telemetry span, health counters, OpenAPI catalogue, `proofread` example,
Docker/release runner, README architecture.

---

## 5. Testing

- **Protocol**: fake runner in Elixir for frame encode/decode, host-call
  dispatch, malformed frames, late replies after kill.
- **Integration**: real Bun runner for echo, reads, writes, streaming, npm,
  secrets, schema validation.
- **Isolation**: sync CPU loop, memory bomb, `Bun.spawn` orphan check, worker
  crash, saturation, deadline races.
- **Wire conformance**: shared golden fixtures between `@ebbjs/client` and the
  runtime; property test that a random operation batch produces identical
  Updates.
- **Permission parity**: for a matrix of actors/entities, `ctx.get/query`
  matches the HTTP endpoints.
- **Write parity**: every function-committed Action passes the same
  validator/authorizer as the same Action over `POST /sync/actions`.
- **Versioning**: concurrent deploy + invoke, in-flight pinning, rollback.
- **CLI**: bundle → upload → invoke, signature failures, generated map drift.
- **Adversarial**: oversized bodies/responses, log floods, missing secrets,
  cross-actor reads, allowlist bypass attempts, `node:` imports.

## 6. Benchmarks

`ebb_server/bench/ebb_server/bench/functions.ex`:

- invocation latency split into pool checkout, bundle transfer, startup
  amortization, eval, host calls, commit;
- throughput at concurrency 1/10/100 for read-only, write, fetch-bound, and
  streaming functions;
- pool saturation and spawn rate;
- host-call round-trip distribution;
- memory per idle worker;
- guardrails: host-call flood rejected; sync CPU loop killed at the deadline
  with no orphan.

## 7. Risks

| Risk                                    | Impact | Mitigation                                                                         |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| Worker crash / OOM                      | low    | per-invocation process; `503`; pool respawn; sync unaffected                       |
| Orphan processes after kill             | medium | process groups, `kill -9` fallback, orphan test                                    |
| Spawn cost limits throughput            | medium | pre-warmed pool; measure; raise pool; deferred in-process engine                   |
| Native `fetch` bypasses Elixir policy   | high   | shim allowlist as a guardrail; `fetch_audit`; network policy for untrusted authors |
| Runner assumed to be a security sandbox | high   | documented as a trusted-author boundary; separate uid/namespace if that changes    |
| Bun footprint / supply chain            | medium | pin version; ship in image; boot check                                             |
| Protocol/lifecycle bugs                 | medium | fake-runner tests, crash/timeout matrix, pool invariants                           |
| Schema drift between RPC and runner     | medium | one `FunctionSchema`, JSON Schema projection, conformance fixtures                 |
| Generated contract map stale            | medium | regenerate on deploy; warn on name drift                                           |
| Write-planner drift                     | high   | shared `@ebbjs/write` + golden/property tests                                      |
| Secret leakage                          | high   | allowlist, scrubbed env, redaction, caps                                           |
| No rollback of committed writes         | medium | buffer-until-return; document read→call→write                                      |
| Multi-node version divergence           | medium | per-node store documented; replicate later                                         |

## 8. Documentation changes

1. `ebb_server/README.md`: add the functions runner to the architecture
   overview (supervision, data dir, Bun requirement, trusted-author boundary).
2. `why-elixir` devlog: its Bun claim for the function runner is accurate; no
   change needed.
3. #111 constraint unchanged: no custom NIF is added.
4. Ops docs: Bun install/version, socket dir permissions, pool sizing,
   kill-switch procedure, egress policy, schema/contract versions.

## 9. Out of scope

Actor onboarding/bootstrap; browser-side params validation; invite helpers;
offline or queued function calls; streaming a function's output to the caller;
async invocation/polling; timers/cron; a hardened sandbox for untrusted authors;
distributed version replication; per-function rate limits; nested calls; an
in-process engine (deferred behind the same protocol).

## 10. References

- #112 (Epic), #111 (storage architecture), #110 (collaborative text), #538
  (writer admission control), #565 (npm release).
- `ebb_server/lib/ebb_server/storage/{entity_store,sqlite,writer,permission_checker,group_cache}.ex`
- `ebb_server/lib/ebb_server/sync/router.ex`, `telemetry.ex`
- `packages/client/src/{schema/action,sync/client,sync/operations}.ts`
- `ex_json_schema` (draft 4/6/7 validator)
