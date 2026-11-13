# Proofread example

A small, runnable function that reads a document, calls an external
proofreading service, and records the service's comments — the
**read → external call → write** shape in one invocation.

```
POST /functions/proofreadDocument
  ctx.get(documentId)                     read the document body
  fetch(PROOFREAD_ENDPOINT, { text })     external call; not part of the Action
  ctx.create("comment", …) × N            buffered
  return { commentCount }                 runner flushes one Action
```

## Layout

| File                              | What it carries                                                         |
| --------------------------------- | ----------------------------------------------------------------------- |
| `functions/proofreadDocument.ts`  | The `defineFunction` definition the CLI deploys.                        |
| `src/schema.ts`                   | The app schema the function and its writes are typed against.           |
| `src/ebb-functions.generated.ts`  | The contract map `ebb deploy` / `ebb functions types` writes.           |
| `src/main.ts`                     | A client built with that map and its typed `proofreadDocument` call.    |
| `ebb.config.ts`                   | Server URL, admin deploy token, actor, and the generated-types path.    |
| `src/__tests__/proofread.test.ts` | The handler against a fake host and a stubbed `fetch`.                  |
| `src/__tests__/bundle.test.ts`    | A browser bundle of `src/main.ts` carries no server-side function code. |

## What the contract map is

`ebb deploy` (and `ebb functions types`) emits
`src/ebb-functions.generated.ts`. The emitted file starts with its path and
imports each function definition with `import type`, recording its deployed
name:

```ts
// src/ebb-functions.generated.ts — emitted by `ebb deploy` / `ebb functions types`
import { functionContract } from "@ebbjs/client";
import type { proofreadDocument } from "../functions/proofreadDocument";

export const functions = {
  proofreadDocument: functionContract<typeof proofreadDocument>("proofreadDocument"),
};
```

That type-only import is the whole trick: `createClient({ functions })` types
`client.functions.proofreadDocument`, and a production bundle never imports
`@ebbjs/server` or the handler. The generated file is committed; regenerate it
after renaming a function or changing its params.

## The convention

External side effects are **not rolled back**. When the handler returns, the
runner submits the buffered writes as one Action; if that commit is rejected,
or the invocation hits its deadline, the database is unchanged but the
proofreading request has already happened. Keep the handler in this order:

1. read what you need (`await ctx.get(...)`),
2. perform the external call,
3. write what the result justifies (`ctx.create(...)`).

Doing the write first does not make the pair atomic — it only makes a
rejection look like a rollback that never happened. The write is the only part
in the Action; the external call is outside it by construction.

`ctx.create` requires the groups the row is filed into, so the example files
every comment into the caller's workspace group. One invocation is one Action:
the comments and their `ebb/membership` rows commit together.

## Run it

Prerequisites: Node `>=22.8`, pnpm, and **Bun 1.4.3** (the version in
`.bun-version`) — the server runs each function in a Bun process. The `ebb`
CLI is the `@ebbjs/cli` workspace package, so the root build below links its
`ebb` binary into this example's `node_modules/.bin`.

1. Build the workspace once from the repo root:

   ```bash
   pnpm install
   pnpm build
   ```

2. Give the server an admin deploy token and enable functions. Functions are
   off by default; the flag is resolved once at boot. Add the token to
   `ebb_server/config/dev.exs` (it is a config value, not an environment
   variable in v1):

   ```elixir
   config :ebb_server, :functions, admin_token: "dev-deploy-token"
   ```

   Then start the server:

   ```bash
   cd ebb_server
   EBB_AUTH_MODE=bypass EBB_FUNCTIONS_ENABLED=true mix dev
   ```

   Versions live in `<data_dir>/functions.db`; the dev server's default data
   directory is `ebb_server/data`.

3. Deploy and activate the function from this directory:

   ```bash
   export EBB_ADMIN_TOKEN=dev-deploy-token
   pnpm --filter proofread deploy
   ```

   `--no-activate` uploads a version without switching to it, and `--keep`
   pins the uploaded version so retention keeps it alongside the last 20
   unpinned versions. The admin token is
   only the deploy credential; it is never an invoke grant.

4. Grant the caller. The invoking actor needs an `ebb/grant` row whose
   permissions include:
   - `function.proofreadDocument` — the invocation itself;
   - `comment.create` — the write the handler performs in the workspace group.

   The document must be filed in a group the actor belongs to, and
   `workspaceId` must name a group the actor is a member of. The issue-tracker
   example's seed (`client.seed`, `examples/issue-tracker/src/seed.ts`) is the
   shortest way to create the group, membership, and row bootstrap; grant the
   two permissions above on the membership instead of its demo list.

5. Run the caller or the dev loop:

   ```bash
   pnpm --filter proofread dev       # ebb dev: rebuild/redeploy on change
   ```

   `src/main.ts` exports `proofread({ serverUrl, actorId, documentId, workspaceId })`
   rather than calling it at module load, so a script or test can import it:

   ```ts
   import { proofread } from "./src/main";

   const { commentCount, replayed } = await proofread({
     serverUrl: "http://localhost:4000",
     actorId: "a_proofreader",
     documentId: "doc_1",
     workspaceId: "grp_workspace",
     idempotencyKey: "proofread:doc_1", // reuse this exact key on a retry
   });
   ```

   `replayed: true` means the server recognized the invocation id and did not
   assign a new Action; pass an `idempotencyKey` to make retries dedupe.

6. Offline checks (no server, no Bun): `pnpm --filter proofread typecheck` and
   `pnpm --filter proofread test`.

## Operating the deployed function

- `ebb functions list` shows names, active versions, and access.
- `ebb functions activate <name> <version>` moves the active pointer;
  `ebb functions rollback <name>` returns to the version active before the
  current one.
- `ebb functions disable <name>` is the per-function kill switch: invocations
  return `404`, uploads and history remain. Restarting with
  `EBB_FUNCTIONS_ENABLED=false` removes every `/functions` route instead.
- `ebb functions types` refreshes `src/ebb-functions.generated.ts` without
  deploying.
- `ebb dev` deploys and keeps the active version in step while you edit.

Secrets, per-function environment, and bundle signing are deferred to #597;
v1 keeps the endpoint in source (`PROOFREAD_ENDPOINT`) and the admin token in
the server's config.
