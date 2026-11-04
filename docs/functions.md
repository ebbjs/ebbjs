# Functions

Functions are app-owned TypeScript handlers deployed to `ebb_server`. One
invocation reads what it needs, may call an external service, and commits its
writes as **one Action**. The write path is the same permission-checked,
group-scoped path every client uses; the function runs in Bun, out of process
from the BEAM.

The runnable example is [`examples/proofread`](../examples/proofread/README.md):
read a document, POST its body to a proofreading service, create one comment
per result.

## Status

The authoring loop — `ebb.config.ts`, `ebb deploy`, the generated contract
map, and typed `client.functions.<name>` calls — ships with
[#596](https://github.com/ebbjs/ebbjs/issues/596). The server side came from
the function slices ([#593](https://github.com/ebbjs/ebbjs/issues/593) runner,
[#594](https://github.com/ebbjs/ebbjs/issues/594) writes,
[#595](https://github.com/ebbjs/ebbjs/issues/595) store/versioning,
[#716](https://github.com/ebbjs/ebbjs/issues/716) admin routes), and
[#597](https://github.com/ebbjs/ebbjs/issues/597) made the feature safe to
enable by default: bounded bodies and results, a host-call budget, capped logs,
a bounded worker pool, service principals, per-function secrets, `fetch`
auditing, and a boot check for the Bun runner.

Functions are **on by default**. `EBB_FUNCTIONS_ENABLED=false` (or
`:functions, enabled: false`) removes every `/functions` route at boot and
starts no store, cache, stats owner, or pool.

## The loop

```
functions/<name>.ts        defineFunction(schema, params, handler)
ebb deploy                 bundle → upload → activate when the bundle changed
src/ebb-functions.generated.ts   type-only contract map
client.functions.<name>()  typed invocation
```

The CLI and runner live in `packages/cli` and `packages/runner`. The server
never invokes the CLI, and the CLI never opens `functions.db` directly: deploys
go over the admin HTTP routes.

## Config file

`ebb.config.ts` is plain data, default-exported through `defineConfig` only so
an editor checks its keys:

```ts
import { defineConfig } from "@ebbjs/server";

export default defineConfig({
  url: "http://localhost:4000",
  token: process.env.EBB_ADMIN_TOKEN,
  actor: "a_proofreader",
  functions: {
    dir: "functions", // default
    typesOut: "src/ebb-functions.generated.ts", // default
  },
});
```

| Key                  | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `url`                | Server base URL. Defaults to `http://localhost:4000`.                            |
| `token`              | Admin deploy credential (`Authorization: Bearer`). Never an invoke grant.        |
| `actor`              | Bypass-mode actor used for `GET /functions` and drift checks.                    |
| `headers`            | External-mode auth headers/cookie for the same reads.                            |
| `functions.dir`      | Directory scanned for one exported definition per file. Defaults to `functions`. |
| `functions.typesOut` | Generated contract-map path. Defaults to `src/ebb-functions.generated.ts`.       |

The deploy token is configured on the server as `:functions, :admin_token` or
`EBB_FUNCTIONS_ADMIN_TOKEN` (the environment wins at boot, and a blank value
counts as unset); an unset token means there is no admin credential, not an open
route. Rotating it is a restart: start the node with the new value and stop the
old one. There is deliberately no two-token overlap, because a token that kept
working on the old node would not be a rotation.

## Authoring

```ts
import { defineFunction, p } from "@ebbjs/server";
import { schema } from "../src/schema";

export const proofreadDocument = defineFunction(
  schema,
  p.object({ documentId: p.string(), workspaceId: p.string() }),
  async (ctx, params) => {
    const document = await ctx.get(params.documentId);
    if (document === null) throw new Error("document not found");

    const comments = await proofread(document.data.fields.body);
    for (const body of comments) {
      ctx.create(
        "comment",
        { documentId: params.documentId, body },
        {
          groups: [params.workspaceId],
        },
      );
    }
    return { commentCount: comments.length };
  },
  { timeoutMs: 15_000 },
);
```

- A function file exports **exactly one** `defineFunction` definition as a
  named `const`. The exported binding name is the deployed name, the route
  segment, and the permission suffix (`function.proofreadDocument`).
- The first argument is the application schema. The deployed bundle carries it,
  so the runner resolves entity and relationship names without a second export.
- `params` is a `p` schema (Standard Schema + draft-7 JSON Schema). The server
  validates the JSON body against that schema before the worker runs, and the
  runner validates again with the full schema; the handler sees the inferred
  type.
- `options.access` is `"granted"` (default) or `"authenticated"`;
  `timeoutMs` and `memoryBytes` bound the worker; `output` optionally validates
  the handler's result.
- The handler returns JSON-serializable data. An object result is spread onto
  the client's resolved value, so `{ commentCount }` becomes
  `{ commentCount, replayed }`.

### `ctx`

| Member                                   | Behavior                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `ctx.get(id)`                            | One entity in wire shape, or `null` when absent **or not readable**.        |
| `ctx.create(entity, fields, { groups })` | Buffers a create plus one `entityGroup` row per group; returns a handle.    |
| `ctx.update(entity, id, patch)`          | Buffers a patch.                                                            |
| `ctx.delete(entity, id)`                 | Buffers a soft delete.                                                      |
| `ctx.relate` / `ctx.unrelate`            | Buffers relationship writes under the declared cardinality.                 |
| `ctx.commit()`                           | Submits the buffer now and resolves `{ replayed }`.                         |
| `ctx.actor` / `ctx.caller`               | The subject and whether it is an actor or a service. Never client-supplied. |

`ctx.get` sees the invocation's own buffered writes (read-your-writes) but is
**the only read in v1**: there is no `ctx.query` or `ctx.getMany`, so a handler
that needs a set reads rows one at a time. A one-cardinality unlink of an edge
that predates the invocation needs its `relationship` row id, because
`ctx.get` cannot read relationship rows.

`ctx.create` requires a non-empty `groups` list, exactly as the client does: an
entity with no owning group is not representable. The writes are validated
against the schema at the call, so a bad field or undeclared entity fails at
that line rather than as a server rejection.

## One Action per invocation

Writes buffer in call order. The runner flushes them as **one Action** when the
handler returns — one GSN, atomic across every Update:

- A handler that throws flushes nothing.
- `ctx.commit()` submits immediately and is the point of no return; a throw
  after it leaves that Action durable and the invocation reports
  `handler_error`. The buffer is sealed after a commit — one invocation is one
  Action, so a late `ctx.*` write throws.
- A rejection rejects the commit with `ActionRejectedError` carrying the same
  `rejected[]` a client sees from `POST /sync/actions`.
- The Action id derives from the invocation id. A retried invocation carrying
  the same `Idempotency-Key` derives the same id and is deduped; `replayed: true`
  means the server dropped the submission (already durable or in flight), not
  proof that the first copy committed.
- One invocation's commit must fit the 1 MiB frame bound. The fix is a smaller
  batch, not a second commit.

## Secrets

A function reads secrets from `ctx.env`, a frozen object the server fills at
boot from an allowlist:

```elixir
config :ebb_server, :functions,
  env: %{"proofreadDocument" => ["PROOFREAD_API_KEY"]}
```

```ts
const apiKey = ctx.env.PROOFREAD_API_KEY;
```

- The values come from the **server process environment** when the node boots.
  Changing one requires a restart; an invocation never reads the environment.
- A named key with no value fails the invocation with `422 missing_secret`
  before the handler runs and before a worker is checked out. The response names
  the key, never the value.
- Values travel in the invoke frame, never in logs, telemetry, or error
  responses. The runner sees only the keys the function declared; its process
  environment is scrubbed.
- `console.*` and `ctx.log` become Logger lines tagged with `function_name`,
  `version`, and `invocation_id`, capped at 200 lines / 64 KiB per invocation.
  Past the cap, frames are dropped and one truncation line is written; logging
  can never fail an invocation.

## Principals

Two kinds of caller may invoke a function:

|                         | User / agent                                           | Service (job, webhook)                  |
| ----------------------- | ------------------------------------------------------ | --------------------------------------- |
| Authenticates with      | `AuthPlug` (external auth; bypass in dev)              | `x-ebb-service-token`                   |
| Grant source            | `function.<name>` on any `groupMember.permissions` row | `permissions` on the service credential |
| Subject (data identity) | The caller                                             | `subject_actor_id` on the credential    |
| Data permissions        | Caller's memberships                                   | Subject actor's memberships             |

Service credentials are static config; the server compares sha256 of the
presented token in constant time:

```elixir
config :ebb_server, :functions,
  services: [
    %{
      id: "svc_webhook",
      token_sha256: "…64 lowercase hex…",
      subject_actor_id: "svc_webhook",
      permissions: ["function.processWebhook"]
    }
  ]
```

- `access: "authenticated"` admits either kind without a grant; `"granted"`
  checks the credential's own permissions or the actor's membership rows.
- A service token is accepted only by `/functions`; on a sync route it leaves
  the request anonymous, so it cannot stand in for an actor.
- Deploy is a separate admin credential and never implies invoke permission.
- `Idempotency-Key` is scoped to the **principal** and the function. Two service
  credentials with the same key therefore make distinct Actions even when they
  share a subject actor. Callers behind one credential share that key space and
  must use their own keys.

## Limits

| Limit                  | Default                                 | Enforcement                                                                                                           |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Wall clock             | per-function `timeoutMs`, max 60 s      | Elixir deadline; socket close + process-group kill                                                                    |
| Memory                 | 256 MB + runtime reservation            | Linux `ulimit -v` on the worker; macOS has no portable per-process limit and is documented as relying on the deadline |
| Host calls             | 1,000                                   | Runner refuses before sending; the server refuses a frame past the budget (`429 host_call_limit`)                     |
| Input / output         | 256 KB / 1 MiB                          | HTTP body read bound (`413` before a worker) and the result frame bound (`413 payload_too_large`)                     |
| Concurrent invocations | pool 4, queue 20                        | Pool checkout; `503 saturated` past the bound                                                                         |
| Log lines / bytes      | 200 / 64 KB                             | Runner and server both cap; the invocation is unaffected                                                              |
| Fetch                  | optional host allowlist, 10 MB response | Runner wraps global `fetch`; `fetch_audit` telemetry (URL, status, duration — no headers or bodies)                   |

A handler that buffers an Action larger than the 1 MiB frame bound gets a
`FrameTooLargeError` at `ctx.commit()`, before anything is sent, so the socket
stays up and the handler can catch it. One invocation still commits at most one
Action; the fix is a smaller batch, not a second commit.

## Read → external → write

External side effects are **not rolled back**. A rejected commit, a thrown
handler, or a deadline leaves the database as it was, but a `fetch`, an npm SDK
call, or any other external effect already happened. Write the handler in this
order:

1. `await ctx.get(...)` for the state the decision needs,
2. perform the external call,
3. `ctx.*` the writes the result justifies.

Writing before the external call does not make the pair atomic; it only makes a
rejection look like a rollback that never happened. The write is the part
inside the Action; the external call is outside it by construction. The
proofread example is this convention end to end.

## Deploy and dev

```bash
ebb deploy                 # bundle, upload, and activate when the deployment changed
ebb deploy --no-activate   # upload only a changed deployment, never move the pointer
ebb deploy --keep          # always upload, pinning the new version against retention
ebb deploy --force         # upload and activate even when nothing changed
ebb deploy --url http://localhost:4000 --token "$EBB_ADMIN_TOKEN"
ebb dev                    # redeploy the active version while editing
ebb functions types        # refresh src/ebb-functions.generated.ts
```

`ebb deploy` reads `ebb.config.ts`, scans `functions.dir`, builds each file with
esbuild into the envelope the runner expects (`name`, `version`, `digest`,
`entry`, RPC schemas, limits), and skips the upload when that deployment is
already in the name's history.

### Unchanged deploys

A **deployment hash** identifies what a deployment would do: the digest of the
emitted code plus `access`, `runtime`, `contract`, `timeoutMs`, `memoryBytes`,
`entry`, `paramsSchema`, and `outputSchema`. It deliberately excludes `version`
(the upload timestamp) and `signature`, so redeploying the same project
directory from a fresh checkout is a no-op. The hash is stored with the version
row and returned by `GET /functions/:name/versions`; the CLI never needs a local
manifest.

The hash covers the **compiled bundle**, not the source text: an editor autosave,
or a rewrite of quotes, semicolons, indentation, and blank lines, emits the same
bytes and is a no-op. A formatter that re-wraps a call changes the emitted bytes
and therefore deploys. The bundle also names the entry file relative to the CLI's
working directory, so deploy from the project root for the hash to survive a
fresh checkout.

- A match prints `unchanged <name>@<version>` and makes **no** upload request.
  If that version is not the active one, the deploy activates it, so a
  rolled-back function returns to the checked-in state. An unchanged deploy
  prints no `grant` line; the grant did not change.
- `--force` uploads and activates regardless of the history. Use it when a
  version row itself is suspect.
- `--keep` also always uploads: a pin is a property of a version row and there
  is no route that pins an existing one, so asking to pin is asking for a new
  pinned version.
- `--no-activate` uploads only a changed deployment and never moves the
  pointer; an unchanged deploy makes no request at all beyond the history read.

The generated contract map and the drift check are not deploy steps, so they
still run on an unchanged deploy. `ebb dev` uses the same check: a save that
leaves the deployment hash unchanged creates no new version.

The version is immutable; activation moves the name's pointer.

The generated contract map imports each definition **as a type** and records
its deployed name:

```ts
// src/ebb-functions.generated.ts — emitted by `ebb deploy` / `ebb functions types`
import { functionContract } from "@ebbjs/client";
import type { proofreadDocument } from "../functions/proofreadDocument";

export const functions = {
  proofreadDocument: functionContract<typeof proofreadDocument>("proofreadDocument"),
};
```

Because the import is type-only, a production client bundle carries the
deployed name and the handler's input/output types but no `@ebbjs/server` code
and no function module. Commit the generated file; regenerate it when a name or
params shape changes.

## Permissions

An invocation is a normal permission check: the caller must hold
`function.<name>` (or `function.*`) on one of its `groupMember` permissions
rows, unless the definition sets `access: "authenticated"`.

- Grants are literal strings; `.` and `*` are not in the function name grammar,
  so `function.<name>` has exactly one reading.
- The **admin deploy token is separate**: an actor that may upload and activate
  still needs a `function.<name>` grant to invoke anything.
- The handler's reads and writes run as the subject actor and need the same
  entity permissions a client would need. A function cannot widen its caller's
  access.

## Versioning, rollback, and disable

| Command                                   | Effect                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `ebb functions list`                      | Names, active versions, access, and the permission string (never code). |
| `ebb functions activate <name> <version>` | Move the name's active pointer.                                         |
| `ebb functions rollback <name>`           | Activate the version that was active before the current one.            |
| `ebb functions disable <name>`            | Per-function kill switch: invocations return `404`.                     |

Versions are retained per name (default 20 unpinned, plus the active and pinned
ones). Rollback follows the activation chain, not a two-row toggle. Disabling a
function leaves its uploaded versions and history in place; re-activating one
restores service.

The other switch is the boot flag. `EBB_FUNCTIONS_ENABLED=false` (or
`:functions, enabled: false`) removes every `/functions` route — `404`, not
`503` — and starts no store, cache, stats owner, or pool. It is resolved **once
at boot**, so changing it requires a restart. With the flag off, the rest of the
server runs normally.

## Observability

- `ebb.functions.invoke` is a telemetry span (`start`/`stop`/`exception`) with
  `name`, `version`, `actor_id`, `caller_kind`, `outcome`, `host_calls`,
  `reads`, `writes`, `fetch_calls`, `input_bytes`, `output_bytes`, `queue_ms`,
  and `worker_pid`.
- Per-version ETS counters (invocations, errors, timeouts, worker kills, fetch
  calls) and pool gauges (idle, busy, queued, workers, spawn failures, kills,
  respawning) are behind the admin route `GET /functions/health` and the CLI:

  ```bash
  ebb functions health --url http://localhost:4000 --token "$EBB_ADMIN_TOKEN"
  ```

- `ctx.log` / `console` lines carry `function_name`, `version`, and
  `invocation_id`.
  `fetch_audit` emits a telemetry event with URL, status, and duration only.
- Every invocation response carries `invocation_id` in the body and in
  `x-ebb-invocation-id`, including failures.

## Data and runtime

| Item               | Where                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Versions, pointers | `<data_dir>/functions.db` (SQLite, separate from RocksDB/SQLite cache) |
| Active bundles     | Read through `EbbServer.Functions.BundleCache`; never served as JSON   |
| Worker sockets     | `<data_dir>/function_sockets` (one Unix socket per worker)             |
| Runner entry point | `ebb_server/priv/runner/main.js` (built from `packages/runner`)        |

The runner requires **Bun 1.4.3**, pinned in `.bun-version`. The server keeps a
pool of warm workers (default `min(4, schedulers_online)`) and reuses a worker
after a successful invocation; a timeout, crash, or failed host call kills the
process group and replaces the slot. A worker crash or timeout fails that
invocation only — committed writes survive and sync connections stay up.

`scripts/build-runner.sh` bundles the runner into one committed file;
`scripts/build-runner.sh --check` proves it is current, and CI runs that check.
An enabled node refuses to boot when Bun or the runner bundle is missing, naming
both in the error. The Docker image installs the pinned Bun and asserts the
version; the release ships the committed bundle in `priv/`.

**Process isolation is for resilience, not a security sandbox.** Functions are
trusted authors: Bun globals including native `fetch` and `Bun.spawn` stay
reachable. The grant decides who may invoke, not what the code may do.

See [`ebb_server/README.md`](../ebb_server/README.md#functions) for the
supervision tree and the server-side modules.

## Decisions after #597

Some items in the milestone are deliberately decisions rather than code:

- **Bundle signing is deferred, not half-built.** With a single-operator deploy
  story, the admin credential plus the digest of the code is the trust
  boundary; `ebb deploy --sign` does not ship. A signature path that is not
  configured and checked on every node would look like provenance without being
  one.
- **The inlined entity schema is trusted.** The bundle carries the schema the
  runtime plans writes against; the server does not cross-check it against its
  registry (#167). Trusted authors plus the server-side authorization on the
  commit is the control.
- **Authorization at the write buffer is the server's job.** The client planner
  keeps its structural checks (`missing_ownership`, `last_membership`,
  `last_group_member`), and the server's `422 rejected` is the backstop for a
  full `Authorizer.authorize/3` check. One enforcement point, not two that can
  disagree.
- **macOS gets no memory cap.** There is no portable per-process
  address-space limit the server can set without privileges; the deadline and
  process-group kill remain the containment, and Linux applies `ulimit -v`.
- **The fetch allowlist is a guardrail, not a sandbox.** The runner wraps global
  `fetch` for the duration of an invocation and audits each call, but trusted
  code can still reach the network in other ways; egress policy is the control
  for untrusted authors.
