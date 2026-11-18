---
"@ebbjs/write": minor
---

One `ctx` port, declared where both sides already look.

The handler's port was declared twice — once in the SDK's typings and once in the runtime
that implements it — and the copies had drifted: the runtime grew `log` and `env`, the SDK
never heard of them. The port now lives in `@ebbjs/write`, with the verbs left open over
the entity name, so `@ebbjs/server`'s `Context<S>` narrows the names to the schema's
models and `@ebbjs/functions-runtime`'s `Context` adds `log` and `env`, and neither
restates a verb signature or an option shape. `RelationshipTarget`, `CreateOptions`,
`WriteOptions`, `UnrelateOptions`, `CommitOutcome`, `Caller`, and `CallerKind` live beside
it, re-exported where they were imported before.

`EntityResponse` moved with it, because `ctx.get`'s read shape is now part of that shared
port and the port cannot depend on the client that parses the same JSON. `@ebbjs/client`
still exports `EntityResponse` and `EntityResponseSchema`; only the definition's home
changed.

```diff
-import type { Context } from "@ebbjs/server";
+import { createContext, type Context } from "@ebbjs/functions-runtime";
```

`@ebbjs/runner` no longer depends on `@ebbjs/server`: its one use was that type.
