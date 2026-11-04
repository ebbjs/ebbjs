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
[#680](https://github.com/ebbjs/ebbjs/issues/680) routing). Secrets,
per-function environment, and bundle signing are **not** in v1; they are
[#597](https://github.com/ebbjs/ebbjs/issues/597).

## The loop

```
functions/<name>.ts        defineFunction(schema, params, handler)
ebb deploy                 bundle → upload → activate
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

The deploy token is configured on the server as `:functions, :admin_token`; an
unset token means there is no admin credential, not an open route.

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
  `timeoutMs` and `memoryMb` bound the worker; `output` optionally validates
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
ebb deploy                 # bundle, upload, and activate
ebb deploy --no-activate   # upload a version without switching to it
ebb deploy --keep          # upload without retiring older versions
ebb deploy --url http://localhost:4000 --token "$EBB_ADMIN_TOKEN"
ebb dev                    # redeploy the active version while editing
ebb functions types        # refresh src/ebb-functions.generated.ts
```

`ebb deploy` reads `ebb.config.ts`, scans `functions.dir`, builds each file with
esbuild into the envelope the runner expects (`name`, `version`, `digest`,
`entry`, RPC schemas, limits), and uploads it to
`POST /functions/:name/versions`. The version is immutable; activation moves
the name's pointer.

The generated contract map imports each definition **as a type** and records
its deployed name:

```ts
// Generated by `ebb deploy` / `ebb functions types`. Do not edit.
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

| Command                                   | Effect                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| `ebb functions list`                      | Names, active versions, access, and RPC schemas (never code). |
| `ebb functions activate <name> <version>` | Move the name's active pointer.                               |
| `ebb functions rollback <name>`           | Activate the version that was active before the current one.  |
| `ebb functions disable <name>`            | Per-function kill switch: invocations return `404`.           |

Versions are retained per name (default 20 unpinned, plus the active and pinned
ones). Rollback follows the activation chain, not a two-row toggle. Disabling a
function leaves its uploaded versions and history in place; re-activating one
restores service.

The other switch is the boot flag. `EBB_FUNCTIONS_ENABLED=false` (or
`:functions, enabled: false`) removes every `/functions` route — `404`, not
`503` — and starts no store or bundle cache. It is resolved **once at boot**, so
changing it requires a restart. With the flag off, the rest of the server runs
normally.

## Data and runtime

| Item               | Where                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Versions, pointers | `<data_dir>/functions.db` (SQLite, separate from RocksDB/SQLite cache) |
| Active bundles     | Read through `EbbServer.Functions.BundleCache`; never served as JSON   |
| Worker sockets     | `<data_dir>/function_sockets` (one Unix socket per worker)             |
| Runner entry point | `packages/runner` (Bun)                                                |

The runner requires **Bun 1.4.3**, pinned in `.bun-version`. One Bun process
runs one invocation and exits; the server's `Worker` contract is a seam so a
pre-warmed pool can replace the per-invocation spawn later. A worker crash or
timeout fails that invocation only — committed writes survive and sync
connections stay up.

**Process isolation is for resilience, not a security sandbox.** Functions are
trusted authors: Bun globals including native `fetch` and `Bun.spawn` stay
reachable. The grant decides who may invoke, not what the code may do.

See [`ebb_server/README.md`](../ebb_server/README.md#functions) for the
supervision tree and the server-side modules.

## Deferred to #597

v1 keeps secrets and signing out of the loop:

- no per-function secrets or environment channel; a handler reads constants
  from source, and the server's admin token lives in server config;
- no signature verification of uploaded bundles (the digest guards integrity,
  not authorship);
- no client-side validation of params beyond the generated types — the server
  validates, and the runner validates again.

[#597](https://github.com/ebbjs/ebbjs/issues/597) adds the secret/env channel and
bundle signing. Until then, treat deploy access as the trust boundary.
