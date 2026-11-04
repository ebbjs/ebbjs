---
"@ebbjs/client": patch
---

Typed function invocation: `functionContract`, `client.functions`, and `invokeFunction`.

A generated contract map imports each function's definition as a type and calls
`functionContract<typeof foo>("foo")` with its deployed name, so
`createClient({ functions })` types `client.functions.foo` without importing
`@ebbjs/server` or shipping any handler code to the browser. The low-level
`client.invokeFunction(name, input, options?)` posts to `/functions/:name` and
returns the envelope's `result` and `replayed`; the namespace spreads an object
result so callers read its fields directly. `functions` needs no schema, and
mounts alongside `schema` / `actions` when both are present.

A rejected commit throws the same `ActionRejectedError` a rejected Action batch
does; every other failure is a `FunctionCallError` carrying the envelope's
status, code, details, issues, invocation id, and version.

`idempotencyKey` is the caller's to supply: a key claims a retry is the same
request, and only the caller knows that, so the client never mints one per call.
