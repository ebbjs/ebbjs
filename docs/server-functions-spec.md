# Server Functions (`defineFunction`)

> **Note:** The data access model for server functions has changed. In `storage-architecture-v2.md`, Bun is a stateless function runtime — `ctx.get()` and `ctx.query()` go through Elixir HTTP endpoints (not direct SQLite reads). `ctx.create/update/delete` continue to go through Elixir via HTTP (unchanged). The `FunctionContext` implementation in this doc should be updated to reflect HTTP-based reads. The rest of this spec (function definition, deployment, versioning, CLI) remains valid.

## Overview

Ebb provides two distinct primitives for server-side logic:

- **`defineFunction`** — Arbitrary Node.js code that runs inside the Ebb server process, with a `ctx` object for reading and writing Ebb data. Side effects (external API calls, LLM requests, etc.) are expected and allowed. Invoked over HTTP from the browser client SDK or external processes.
- **`defineAction`** — Pure Ebb composition. Combines Ebb CRUD primitives into a single atomic Action. No side effects. *(Specified separately.)*

This document covers `defineFunction`.

---

## Mental Model

A `defineFunction` handler runs **inside the Bun Application Server**, co-located with the shared SQLite database. It receives a `ctx` object — a lightweight interface for reading Ebb data directly from SQLite (no network hop for reads) and writing via HTTP to the Elixir Sync/Storage Server (which handles permission checks, durability, and fan-out).

This is distinct from the **server-side SDK** (specified separately), which is an HTTP/RPC client that talks to the Ebb server over the network from external processes. The server-side SDK is for application servers and SSR frameworks. `defineFunction` is for logic that needs to live and run inside Ebb itself.

The canonical use case: read from Ebb, call an external service, write results back.

```
Client dispatches function
        │
        ▼
Bun Application Server receives HTTP request
        │
        ▼
Authenticate actor (calls auth URL, same as sync handshake)
        │
        ▼
Load group memberships from shared SQLite
        │
        ▼
Lookup active function version from SQLite (function_versions table)
        │
        ▼
Execute handler in vm sandbox with ctx injected
        │
        ├── ctx.get / ctx.query → direct SQLite reads (shared DB, scoped to actor's groups)
        │
        └── ctx.create / ctx.update / ctx.delete → HTTP POST to Elixir server
                                                    (POST /sync/actions on localhost)
                                                    (permission checks, fsync, fan-out)
```

This makes `defineFunction` the right primitive for:
- AI-assisted workflows (e.g., read a document, send to LLM, write comments back)
- Automation and CRON-style jobs triggered by clients
- Agent-driven mutations
- Any server-side operation that involves external I/O before writing to Ebb

It is **not** the right primitive for operations that require atomicity guarantees across external systems (e.g., charging a payment and recording an order). Those require application-level idempotency and compensating transactions — Ebb does not solve distributed transactions.

---

## Invocation

Functions are invoked via HTTP and exposed through the Ebb client SDK:

```ts
// From the browser client SDK
const result = await client.functions.proofreadDocument({ documentId: "doc-123" });

// From an external process (plain HTTP)
POST /functions/proofreadDocument
Authorization: Bearer <token>
Content-Type: application/json

{ "documentId": "doc-123" }
```

The HTTP endpoint authenticates the caller via the same `authenticate` callback used for sync — the resolved `actor_id` is the actor the function runs as. All Actions produced by the function carry that actor's ID.

For server processes, CRON jobs, or agents, the caller authenticates as a service account actor — a stable identity configured outside any individual user session.

---

## Developer-Facing API

### Function Definition

Developers define functions as TypeScript files in a `functions/` directory:

```ts
// functions/proofreadDocument.ts
import Anthropic from '@anthropic-ai/sdk';
import { Type } from '@sinclair/typebox';
import { defineFunction } from '@ebbjs/server';

export default defineFunction({
  name: "proofreadDocument",

  input: Type.Object({
    documentId: Type.String(),
  }),

  output: Type.Object({
    commentCount: Type.Number(),
  }),

  async handler(ctx, input) {
    // Read from Ebb — direct SQLite, scoped to actor's groups
    const doc = await ctx.get(input.documentId);
    if (!doc) throw new Error(`Document not found: ${input.documentId}`);

    // External side effect — this is the point
    const ai = new Anthropic();
    const response = await ai.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Proofread this: ${doc.data.body}` }],
    });

    const suggestions = parseSuggestions(response.content);

    // Write back to Ebb — through normal write path, permission-checked, produces Actions
    for (const suggestion of suggestions) {
      const comment = await ctx.create("Comment", {
        body: suggestion.text,
        range: suggestion.range,
      });
      await ctx.relate(comment, "document", doc);
    }

    return { commentCount: suggestions.length };
  },
});
```

### The `ctx` Object (Function Context)

Handlers receive a `ctx` object — not a full client, but a lightweight interface with direct SQLite reads and HTTP-based writes:

```ts
interface FunctionContext {
  // Read operations — direct SQLite (shared DB), results scoped to actor's group memberships
  get(id: string): Promise<Entity | null>;
  query<T extends EntityType>(type: T, filter?: QueryFilter): Promise<Entity<T>[]>;

  // Write operations — sent to Elixir server via HTTP (POST /sync/actions on localhost)
  // Elixir handles permission checks, durability (fsync), and fan-out to subscribers
  create<T extends EntityType>(type: T, data: EntityData<T>): Promise<EntityRef>;
  update(entity: EntityRef, patch: Partial<EntityData>): Promise<void>;
  delete(entity: EntityRef): Promise<void>;
  relate(source: EntityRef, name: string, target: EntityRef): Promise<void>;
  unrelate(source: EntityRef, name: string, target: EntityRef): Promise<void>;

  // Actor context
  actor: Actor;

  // Utilities
  generateId(): string;
}
```

**Key behaviors:**

- **Reads are direct SQLite** — no network hop. The Bun server reads from the shared SQLite database (materialized entity views + generated column indexes). Results are silently scoped to what the actor can see based on their group memberships, enforced at the query level.
- **Writes go to the Elixir server via HTTP on localhost** — `POST /sync/actions`. Elixir handles permission checks, assigns GSN, writes to the Action log, fsyncs, and fans out to subscribers. The Bun Materializer then asynchronously updates SQLite. This means a `ctx.create()` followed by a `ctx.get()` for the same entity may not reflect the write yet (small staleness window, typically single-digit ms).
- **No Outbox, no conflict detection.** Writes commit on the Elixir server immediately. Concurrent writes from other actors resolve via per-field typed merge (LWW for most fields, CRDT merge for counters and collaborative text).
- **No rollback on error.** Writes that have already been accepted by Elixir stay committed. If a handler throws mid-execution, writes made before the throw are not undone. Write after external calls succeed, not before.
- **`defineAction`s can be called from within a handler**, exactly as they can from client code. Each Action commits immediately and independently when called.

---

## Write Ordering Convention

Because there is no rollback, write ordering matters. The recommended pattern is:

1. **Read** what you need from Ebb.
2. **Call** external services.
3. **Write** back to Ebb based on the results.

If the external call fails, nothing was written. If a write fails after a successful external call, that is an application-level concern — retry logic, observability, and compensating writes are the developer's responsibility.

---

## Architecture

### High-Level Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Request Execution Flow (Bun Server)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   HTTP request arrives at Bun Application Server                            │
│        │                                                                    │
│        ▼                                                                    │
│   Authenticate actor (call auth URL), load group memberships from SQLite    │
│        │                                                                    │
│        ▼                                                                    │
│   Lookup active function version in SQLite (function_versions table)        │
│        │                                                                    │
│        ▼                                                                    │
│   Get compiled script from cache (or compile + cache)                       │
│        │                                                                    │
│        ▼                                                                    │
│   Validate input schema                                                     │
│        │                                                                    │
│        ▼                                                                    │
│   Create vm context with ctx injected                                       │
│        │                                                                    │
│        ▼                                                                    │
│   Execute handler                                                           │
│        │                                                                    │
│        ├── ctx.get/query → read from shared SQLite directly                 │
│        ├── ctx.create/update/delete → POST /sync/actions to Elixir          │
│        │                                                                    │
│        ├── success → validate output, return result                         │
│        │                                                                    │
│        └── error → return error to caller                                   │
│                    (writes already committed on Elixir are not undone;      │
│                     operator rolls back version manually if needed)         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Deployment Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Function Deployment Flow                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Developer                                                                 │
│       │                                                                     │
│       │  ebb deploy                                                         │
│       │  - Reads functions/*.ts                                             │
│       │  - Bundles each function with esbuild                               │
│       │  - Uploads bundled JS + input/output schemas                        │
│       │  - Activates new versions                                           │
│       ▼                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Function Store (SQLite table)                                      │   │
│   │  ┌───────────────────────────────────────────────────────────────┐  │   │
│   │  │ function_versions                                             │  │   │
│   │  │ ─────────────────────────────────────────────────────────────│  │   │
│   │  │ id │ name              │ version │ code      │ schema │ status│  │   │
│   │  │ 1  │ proofreadDocument │ v1      │ (bundled) │ (json) │ prev  │  │   │
│   │  │ 2  │ proofreadDocument │ v2      │ (bundled) │ (json) │ active│  │   │
│   │  │ 3  │ summarizeThread   │ v1      │ (bundled) │ (json) │ active│  │   │
│   │  └───────────────────────────────────────────────────────────────┘  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Zero-Downtime Deployment

When a new version is deployed and activated:
- **In-flight requests** continue with their already-loaded handler code until completion.
- **New requests** look up the active version at request time and immediately use the new code.

No drain or request queuing needed. Atomicity comes from the database row swap. Request-level isolation comes from each request having its own vm execution context.

### Why the vm Sandbox

Functions run inside a `vm` context for one reason: **timeout enforcement**. A rogue infinite loop or hung external call inside a plain async function would block the Bun event loop, taking down the Application Server (and with it, the Materializer and all in-flight function executions). The vm sandbox makes it possible to enforce the execution timeout and kill a runaway function without affecting the host process.

Note: because server functions run in the Bun Application Server (not the Elixir server), a misbehaving function cannot affect the sync protocol, SSE connections, or the storage engine. This is a natural benefit of the two-server architecture.

The sandbox is *not* a security boundary — function authors are trusted. And it is not what provides zero-downtime deploys — that comes from the version lookup at request time. The sandbox is purely about protecting the Bun host process from misbehaving function code.

---

## Version State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Version State Machine                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   pending ────────► active ────────► previous                               │
│      │                                                                      │
│      └── (manual activate)                                                  │
│                                                                             │
│   States:                                                                   │
│   ─────────────────────────────────────────────────────────────────────────│
│   pending     - Uploaded but not yet activated                              │
│   active      - Receiving all new requests                                  │
│   previous    - Kept for rollback; no traffic                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

| State | Description |
|---|---|
| `pending` | Uploaded, not yet activated |
| `active` | Receives all traffic |
| `previous` | Kept for rollback, no traffic |

---

## Database Schema

```sql
CREATE TABLE function_versions (
  id TEXT PRIMARY KEY,                    -- nanoid
  name TEXT NOT NULL,                     -- e.g., "proofreadDocument"
  version TEXT NOT NULL,                  -- timestamp-based, e.g., "v20260318-143022"
  code TEXT NOT NULL,                     -- bundled JS (esbuild output)
  input_schema TEXT,                      -- JSON Schema for input validation
  output_schema TEXT,                     -- JSON Schema for output validation
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | previous
  created_at INTEGER NOT NULL,
  activated_at INTEGER,

  UNIQUE(name, version)
);

CREATE INDEX idx_function_active ON function_versions(name, status) WHERE status = 'active';
```

---

## Configuration

### ebb.config.ts

```ts
export default {
  functions: {
    // Directory containing function files
    dir: "./functions",

    // Packages to NOT bundle (must be installed on server)
    // Use for native modules that can't be bundled
    external: ["sharp", "canvas"],

    // Execution timeout in ms (default: 30000)
    // Can be overridden per function via defineFunction({ timeout: ... })
    timeoutMs: 30000,
  },
};
```

---

## CLI Commands

| Command | Description |
|---|---|
| `ebb deploy` | Bundle and deploy all functions, auto-activate |
| `ebb deploy --no-activate` | Deploy without activating |
| `ebb functions list [name]` | List all functions or versions of a specific function |
| `ebb functions activate <name> <version>` | Manually activate a specific version |
| `ebb functions rollback <name>` | Rollback to previous version |
| `ebb functions health [name]` | Show invocation counts and error rates per version |

---

## Implementation

### 1. Function Store (CRUD Operations)

```ts
// packages/server/src/functions/store.ts

import { nanoid } from 'nanoid';
import type { Database } from 'better-sqlite3'; // shared SQLite database (same DB as materialized entity views)

interface FunctionVersion {
  id: string;
  name: string;
  version: string;
  code: string;
  input_schema: string | null;
  output_schema: string | null;
  status: 'pending' | 'active' | 'previous';
  created_at: number;
  activated_at: number | null;
}

export class FunctionStore {
  constructor(private db: Database) {}

  create(params: {
    name: string;
    version: string;
    code: string;
    inputSchema?: object;
    outputSchema?: object;
  }): FunctionVersion {
    const id = nanoid();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO function_versions (id, name, version, code, input_schema, output_schema, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      params.name,
      params.version,
      params.code,
      params.inputSchema ? JSON.stringify(params.inputSchema) : null,
      params.outputSchema ? JSON.stringify(params.outputSchema) : null,
      now
    );

    return this.getById(id)!;
  }

  getById(id: string): FunctionVersion | null {
    return this.db.prepare(`
      SELECT * FROM function_versions WHERE id = ?
    `).get(id) as FunctionVersion | null;
  }

  getActive(name: string): FunctionVersion | null {
    return this.db.prepare(`
      SELECT * FROM function_versions WHERE name = ? AND status = 'active'
    `).get(name) as FunctionVersion | null;
  }

  getPrevious(name: string): FunctionVersion | null {
    return this.db.prepare(`
      SELECT * FROM function_versions WHERE name = ? AND status = 'previous'
    `).get(name) as FunctionVersion | null;
  }

  listVersions(name: string): FunctionVersion[] {
    return this.db.prepare(`
      SELECT * FROM function_versions WHERE name = ? ORDER BY created_at DESC
    `).all(name) as FunctionVersion[];
  }

  listFunctions(): FunctionVersion[] {
    return this.db.prepare(`
      SELECT * FROM function_versions WHERE status = 'active' ORDER BY name
    `).all() as FunctionVersion[];
  }

  activate(name: string, version: string): void {
    const txn = this.db.transaction(() => {
      const now = Date.now();

      // Demote current active to previous
      this.db.prepare(`
        UPDATE function_versions SET status = 'previous' WHERE name = ? AND status = 'active'
      `).run(name);

      // Promote target version to active
      const result = this.db.prepare(`
        UPDATE function_versions SET status = 'active', activated_at = ? WHERE name = ? AND version = ?
      `).run(now, name, version);

      if (result.changes === 0) {
        throw new Error(`Version ${version} not found for function ${name}`);
      }
    });

    txn();
  }

  rollback(name: string): void {
    const txn = this.db.transaction(() => {
      const now = Date.now();

      // Demote current active to previous
      this.db.prepare(`
        UPDATE function_versions SET status = 'previous' WHERE name = ? AND status = 'active'
      `).run(name);

      // Promote previous to active
      const result = this.db.prepare(`
        UPDATE function_versions SET status = 'active', activated_at = ? WHERE name = ? AND status = 'previous'
      `).run(now, name);

      if (result.changes === 0) {
        throw new Error(`No previous version available for function ${name}`);
      }
    });

    txn();
  }
}
```

### 2. Compiled Script Cache

```ts
// packages/server/src/functions/cache.ts
// LRU cache for compiled vm.Script objects.
// Cache key: `${name}:${version}`. Evicts least-recently-used when at capacity.
// Map<string, { script: vm.Script, lastUsed: number }>. Eviction iterates map to find oldest entry.
```

### 3. Function Context

```ts
// packages/server/src/functions/context.ts

export function createFunctionContext(
  actor: Actor,
  db: Database,            // shared SQLite database (materialized entity views)
  elixirUrl: string,       // e.g., "http://localhost:4000"
  authHeaders: Headers,    // forwarded from the original request for Elixir auth
): FunctionContext {
  // Load actor's group memberships once at invocation time (direct SQLite read)
  const groupIds = loadGroupMemberships(db, actor.id);

  return {
    actor,

    // Reads: direct SQLite (shared DB), silently scoped to actor's groups
    async get(id: string) {
      return queryEntityScoped(db, id, groupIds);
    },
    async query(type, filter) {
      return queryEntitiesScoped(db, type, filter, groupIds);
    },

    // Writes: HTTP POST to Elixir server on localhost
    // Elixir handles permission checks, assigns GSN, fsyncs, fans out to subscribers
    async create(type, data) {
      return postAction(elixirUrl, authHeaders, { method: 'PUT', type, data });
    },
    async update(entity, patch) {
      return postAction(elixirUrl, authHeaders, { method: 'PATCH', subjectId: entity.id, data: patch });
    },
    async delete(entity) {
      return postAction(elixirUrl, authHeaders, { method: 'DELETE', subjectId: entity.id });
    },
    async relate(source, name, target) {
      return postAction(elixirUrl, authHeaders, {
        method: 'PUT', type: 'relationship',
        data: { source_id: source.id, target_id: target.id, type: source.type, field: name },
      });
    },
    async unrelate(source, name, target) {
      // Look up the Relationship entity, then DELETE it
      const rel = await findRelationship(db, source.id, target.id, name);
      if (rel) return postAction(elixirUrl, authHeaders, { method: 'DELETE', subjectId: rel.id });
    },

    generateId: () => nanoid(),
  };
}

// Helper: POST an Action to the Elixir server, wait for durability confirmation
async function postAction(elixirUrl: string, headers: Headers, update: UpdatePayload): Promise<ActionResult> {
  const res = await fetch(`${elixirUrl}/sync/actions`, {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: [update] }),
  });
  if (!res.ok) throw new ActionError(await res.json());
  return res.json();
}
```

### 4. Function Executor

```ts
// packages/server/src/functions/executor.ts

import * as vm from 'vm';
import { FunctionStore } from './store';
import { ScriptCache } from './cache';
import { createFunctionContext } from './context';

interface ExecutorConfig {
  timeoutMs: number;
}

export class FunctionExecutor {
  constructor(
    private store: FunctionStore,
    private cache: ScriptCache,
    private db: Database,            // shared SQLite database
    private elixirUrl: string,       // e.g., "http://localhost:4000"
    private config: ExecutorConfig = { timeoutMs: 30000 }
  ) {}

  async execute(
    functionName: string,
    input: unknown,
    actor: Actor,
    authHeaders: Headers,            // forwarded from the original request
  ): Promise<unknown> {
    // 1. Lookup active version (direct SQLite read)
    const version = this.store.getActive(functionName);
    if (!version) {
      throw new Error(`No active version for function: ${functionName}`);
    }

    // 2. Get or compile script
    const script = this.cache.getOrCompile(version.name, version.version, version.code);

    // 3. Validate input
    if (version.input_schema) {
      this.validateInput(input, JSON.parse(version.input_schema));
    }

    // 4. Create function context (SQLite reads, Elixir HTTP writes, group-scoped)
    const ctx = createFunctionContext(actor, this.db, this.elixirUrl, authHeaders);

    // 5. Execute in vm with timeout
    const result = await this.executeInVm(script, ctx, input);

    // 6. Validate output
    if (version.output_schema) {
      this.validateOutput(result, JSON.parse(version.output_schema));
    }

    return result;
    // Errors propagate to caller. Writes already committed on Elixir stay committed.
    // Operator uses `ebb functions rollback` if a bad version needs to be pulled.
  }

  // ... executeInVm, validateInput, validateOutput
}
```

### 5. Deploy CLI

```ts
// packages/cli/src/commands/deploy.ts
// Discovers functions/*.ts, bundles each with esbuild, uploads to function store, activates.
// esbuild config: platform=node, format=cjs, bundle=true, external=['@ebbjs/server', ...config.external]
// See original server-actions-spec.md for full implementation reference.
```

---

## File Structure

```
packages/
├── server/
│   └── src/
│       ├── functions/
│       │   ├── store.ts      # Function version CRUD
│       │   ├── executor.ts   # vm execution, timeout enforcement
│       │   ├── cache.ts      # Compiled script cache (LRU)
│       │   ├── context.ts    # FunctionContext — scoped reads, write-path writes
│       │   └── index.ts      # Public API (defineFunction)
│       └── ...
├── cli/
│   └── src/
│       └── commands/
│           ├── deploy.ts     # ebb deploy
│           └── functions.ts  # ebb functions list/activate/rollback/health
└── ...
```

---

## Implementation Order

1. **Function store** (`store.ts`) — schema, CRUD, version activation and rollback
2. **Script cache** (`cache.ts`) — LRU cache for compiled vm.Script objects
3. **Function context** (`context.ts`) — group-scoped reads, write-path writes
4. **Function executor** (`executor.ts`) — vm sandbox, timeout, input/output validation
5. **Deploy CLI** (`deploy.ts`) — file discovery, esbuild bundling, schema extraction, upload and activation
6. **Management CLI** (`functions.ts`) — list, activate, rollback, health commands
7. **Tests** — unit tests per component; integration test for deploy → execute → rollback flow

---

## Open Questions / Future Considerations

1. **`defineAction`** — Pure Ebb composition primitive, no side effects, atomic. Specified separately. Can be called from within a `defineFunction` handler — each Action commits immediately and independently. No cross-action batching at the function level; compose a bigger `defineAction` if needed.

2. **Per-function timeout** — Currently a global config. Could be made configurable per function via `defineFunction({ timeoutMs: 60000, ... })`.

3. **Schema extraction** — Deploy CLI needs to parse TypeScript and extract Zod schemas. Consider `ts-morph` or `zod-to-json-schema`.

4. **Observability** — Metrics per function+version: invocation count, error rate, latency. Primary signal for knowing when to roll back — operators need good visibility since there is no auto-rollback.

5. **Versioning strategy** — Timestamp-based versions today. Could add `--tag` option for human-readable names.

6. **Environment variables** — Functions have access to all `process.env`. Consider an allowlist in config for tighter control.

7. **Write ordering guidance** — The "read → external call → write" convention should be prominently documented. The absence of rollback makes write ordering a correctness concern, not just style.
