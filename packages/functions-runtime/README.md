# `@ebbjs/functions-runtime`

The context a function handler runs against: `ctx.get`, the buffered write
verbs, and the one `commit` frame an invocation submits.

Private. The runner (`@ebbjs/runner`) builds the context and answers its host
calls over the frame channel; a handler never sees the transport.

## Buffered writes

Every write verb records work in the invocation's buffer. Nothing reaches the
server when a verb is called:

```ts
export default {
  handler: async (ctx, params) => {
    const issue = ctx.create(
      "issue",
      { title: params.title, labels: [] },
      { groups: [params.groupId] },
    );
    ctx.update("issue", issue.id, { done: true });
    ctx.relate("issue", issue.id, "labels", ["e_label1"]);
    return { id: issue.id };
  },
};
```

Each verb resolves through the shared planner in `@ebbjs/write` and runs its
operation synchronously, so a field-shape violation, an undeclared
relationship, or a membership refusal throws at the offending call — not at
return with a 422 you have to reconstruct.

On the way out, `ctx.commit()` runs the same registry pass the client runs
before it enqueues an Action, so an Update naming an unregistered entity type
or an undeclared field fails here instead of as a server rejection.

`create` requires `{ groups }`, non-empty, exactly as the client API does: an
entity with no owning group is not representable, and one membership row per
group lands in the same Action.

`relate` / `unrelate` follow the registry's declared cardinality:

| cardinality | `relate`                                    | `unrelate`                                   |
| ----------- | ------------------------------------------- | -------------------------------------------- |
| `one`       | link one target (a Relationship `put`)      | delete the edge by its `relationship` row id |
| `many`      | set the canonical FK list on the source row | drop one target, or clear the whole set      |

## One Action per invocation

Writes go out as **one Action** — one GSN, one Writer round trip, atomic
across every Update — at handler return, or earlier on `ctx.commit()`:

- The runner flushes a non-empty buffer after the handler resolves and before
  it sends the result frame. A handler that throws flushes nothing.
- An explicit `ctx.commit()` is the point of no return: a handler that throws
  after it leaves that Action durable, and the invocation still reports
  `handler_error`. Only the automatic flush at return is skipped by a throw.
- `ctx.commit()` submits immediately and resolves `{ replayed }`. A replay
  (`replayed: true`) means no GSN was assigned to this caller: the Action id
  was already durable, or a copy of it was still in flight, so the submission
  was dropped. It is not proof that the first copy committed — an in-flight
  owner can still fail and abandon its range.
- A commit whose encoded frame exceeds the protocol's 1 MiB bound is refused
  before it is sent (`FrameTooLargeError`). One invocation is one Action, so
  the fix is a smaller batch, not a second commit.
- After a commit the buffer is **sealed**: a later `ctx.*` write throws
  `WritesCommittedError`. One invocation is one Action; there is no second
  frame to put a late write in.
- The Action id is derived from the invocation id
  (`a_` + the first 16 hex characters of `sha256(invocation_id)`), the same
  derivation the server uses, so a retry carrying the same `Idempotency-Key`
  reproduces the id and dedupes. The server scopes that key to the actor and
  the function, so two callers that choose the same string do not collide.

A rejection rejects `ctx.commit()` (and the runner's flush) with an
`ActionRejectedError` carrying the server's `rejected[]` — the same shape a
client sees over `POST /sync/actions`. Any other host failure throws a
`HostCallError` with the host's `error` / `status` / `details`.

## Read-your-writes

`ctx.get` applies the buffer over the host's view of the id, using the wire's
own merge rule (`mergeFieldValue`):

- a row created here reads back with `last_gsn: 0` and the write's HLCs;
- a `patch` merges fields; a `put` replaces them; a `delete` reads as `null`;
- a row created and then deleted in the same invocation reads as `null`;
- an id this invocation never wrote passes the host's view through untouched.

Every read comes back in the same wire shape the entity endpoints publish:
`data.fields` holds `FieldValue` leaves and maps (`.value`, `.update_id`,
`.hlc`), whether or not the invocation wrote to the row. A `patch` merges with
the wire's rule, so a field the batch did not touch keeps the stored leaf and
its HLC. The overlay also backs the relationship verbs' FK reads and the
membership pre-flight, so a verb after a write sees the batch, not the stored
state.

## Secrets and logs

`ctx.env` is the invocation's per-function secrets, copied from the invoke
frame's `env` and frozen. It is empty when the function has none, and it is
never written to a host call or a log line by the runtime.

`ctx.log(message, level?)` sends one fire-and-forget `log` frame; `level`
defaults to `"info"` and may be `"debug" | "info" | "log" | "warn" | "error"`.
The runner also captures `console.debug/info/log/warn/error` for the
invocation and sends each call as a `log` frame, so a handler that prints with
either one lands in the same place.

Logging never fails an invocation. The host budgets the lines: the runner
enforces `max_log_lines` (default 200) and `max_log_bytes` (default 64 KiB)
over the whole invocation, drops the first line that does not fit, then sends
one truncation notice and drops the rest. A transport that cannot carry logs,
or one that throws, loses the line rather than the result.

The handler sees the process's globals, not a sandbox: the runner replaces
`globalThis.fetch` for the invocation's duration with an allowlist and
response-size shim that emits one `fetch_audit` frame per request, and restores
it when the invocation ends. An empty `fetch_allowlist` is unrestricted; with
an entry, only that hostname (and, when the entry names one, that port) is
reachable and a blocked request rejects with an error the handler can catch.
The shim's audit frame carries the method, URL, status, duration, and whether
the request was blocked — never headers or bodies.

## External effects are not rolled back

A rejected commit, a thrown handler, or a deadline leaves the database as it
was — but `fetch`, npm SDK calls, and any other external side effect already
happened. Write the handler in that order:

1. `await ctx.get(...)` to read what you need,
2. perform the external call,
3. `ctx.*` the write the external result justifies.

Doing the write before the external call does not make the pair atomic; it only
makes a rejection look like a rollback that never happened.

## v1 resolution gaps

`ctx.get` is the only read. Some state the client planner resolves from its
materialized cache is not reachable through it, and the verbs refuse rather
than emit an Update that would fail or lose links:

- **A one-cardinality unlink of an edge that predates the invocation** needs
  the `relationship` row id: `ctx.unrelate("issue", id, "project", undefined,
{ relationshipId })`. An edge the same invocation created is resolved from
  the buffer and needs nothing. `ctx.get` cannot read relationship rows, so
  there is no passive path to the id.
- **A many-cardinality unlink of one target** reads the source row's current
  FK list through `ctx.get` and refuses when the row is absent or not readable.
  Clearing the set (`unrelate` with no target) needs no read.
- **`last_group_member`** is only provable for a group this invocation created:
  that group's roster is exactly the members written here. An existing group's
  member rows are not readable, so the check defers to the server, exactly as
  the client does with a cold cache. `last_membership` is likewise checked only
  against memberships the invocation can see.
- **`ctx.getMany` and `ctx.query` are not in v1.** A handler that needs a set of
  rows reads them one `ctx.get` at a time.

## Tests

- `src/*.test.ts` — verbs, overlay, pre-flight, commit framing.
- `src/planner-fixtures.test.ts` — the fixtures in
  `fixtures/functions/planner/`, applied through `ctx`. The same fixtures are
  asserted from `@ebbjs/client` through `commit()` in `@ebbjs/write`, so the
  two planner paths cannot drift.
- `src/planner-property.test.ts` — a seeded generator produces random verb
  batches and asserts the client planner and the runtime produce the same
  Updates and the same full Action.
- Fixture format (also documented in `src/test-support/planner.ts`): a pinned
  `schema`, `invocation_id`, `actor_id`, the `ids`/`hlc` sequence the planner
  consumes (keyed by id prefix), the `calls` as semantic verbs, and the
  expected core `action`.
- `fixtures/write-bun/` — TypeScript function files that export a handler and
  the application `schema`, exactly as a deployed function does. The server's
  real-Bun write acceptance suite
  (`ebb_server/test/ebb_server/functions/write_bun_integration_test.exs`)
  bundles each one with `@ebbjs/cli`'s esbuild configuration and runs it
  against the real server, so `ctx.*` writes are proven on a real schema, not
  a hand-written stub. That suite needs the workspace built (`pnpm build`),
  because the runner resolves `@ebbjs/core`, `@ebbjs/schema`, and
  `@ebbjs/write` through their `dist` entries.
