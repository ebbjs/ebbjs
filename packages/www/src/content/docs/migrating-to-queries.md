---
title: "Migrating to queries"
description: "How to move from entity accessors and useEntity to the query read surface — what changed, what became internal, and what is not here yet."
---

> **Shipped.** This page tracks the docs and examples migration in [#502](https://github.com/ebbjs/ebbjs/issues/502), part of the [local query engine epic](https://github.com/ebbjs/ebbjs/issues/495). The React surface landed in [#501](https://github.com/ebbjs/ebbjs/issues/501); the engine and namespace split before it. [#499](https://github.com/ebbjs/ebbjs/issues/499) and [#500](https://github.com/ebbjs/ebbjs/issues/500) remain open.

Queries are now the only public read path. The entity namespace stays — it is still the schema-bound API — but it splits by verb: `query()` reads, the mutation verbs write, and the engine's single-row helpers became internal.

## What changed

| Before                                       | After                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `client.<entity>.get(id)` plus row accessors | `client.<entity>.query()`, narrowed by `where` / `or` / `orderBy` / `limit` |
| `await row.assignee`, `await row.comments`   | `.with({ assignee: true, comments: true })` on the chain                    |
| `await row.groups`                           | `.with({ groups: true })`, or `.where("groups", groupId)` to filter         |
| `client.<entity>.subscribe(filter, cb)`      | `useQuery` in React, `query().result()` / `query().subscribe(cb)` otherwise |
| `useEntity(build, deps)`                     | `useQuery((q: QueryRoot<Schema>) => ...)`                                   |
| Single row by id                             | Query the collection and select the row with `find`                         |
| Writes                                       | Unchanged: namespace verbs, `client.atomic`, `defineAction`                 |

## Reads: compose a query, not accessors

Accessor composition moved the loading, cancel, and race guards into every component. The query chain replaces all of them: it is one cached, reactive result.

```tsx
// Before — the hook resolved the row, then the component awaited accessors.
const issue = useEntity(() => client.issue.get(issueId), [issueId]);
const assignee = await issue.assignee;

// After — one query, one cached result, joins projected onto the row.
const { data: issues, status } = useQuery((q: QueryRoot<Schema>) =>
  q.issue.query().with({ assignee: true }),
);
const issue = issues?.find((row) => row.id === issueId);
const assignee = issue?.assignee;
```

The chain is immutable, so a helper can return a partially-built query and the caller keeps narrowing it. `where` takes a field, a registered relationship `as`, or the reserved `groups` key; `or` starts a new AND-group (`.where(a).where(b).or(c)` is `(a AND b) OR c`).

## Single rows

The grammar has no `id` predicate yet, so there is no single-row query. Query the collection you can see and select the row — the result is cached and reactive, so the selected row still follows live changes.

```tsx
const { data: issues, status } = useQuery((q: QueryRoot<Schema>) => q.issue.query());

if (status === "unloaded") return <span>loading…</span>;
const issue = issues?.find((row) => row.id === issueId);
if (issue === undefined) return <span>missing</span>;
```

An `id` predicate is the natural follow-up once the grammar grows one.

## Relationships and membership are joins

`with(...)` is one level deep. A source-side relationship joins forward (one-cardinality to a row or `null`, many to an array), a target-side one joins in reverse (always an array), and `groups` is built in on every entity. The joined keys are typed from the schema's relationship map, so a nested selector is a compile error.

```tsx
q.workspace.query().with({ groups: true });
q.issue.query().where("status", "open").with({ assignee: true, comments: true });
```

To filter by an edge instead of projecting it, use the relationship's `as` key as a `where` key. A relationship key wins over a same-named field, matching the old accessors.

## `get()`, accessors, and `subscribe` are internal

`client.<entity>.get(id)`, the async row accessors it attached, and the collection `subscribe(filter, cb)` are marked `@internal`. The engine keeps them for its own callers; applications should not build on them. Projected query rows carry the entity `id` as an addressing key, so the id you need for `update(id, ...)` comes from the row itself.

`.toRaw()` remains the untyped escape hatch on a chain when you need the wire envelope rather than the projected row.

## Writes did not move

The write path is the same split it was:

- **Single entity** — the namespace verbs: `create` / `update` / `delete` / `duplicate`, `link` / `unlink` / `setLinks`, and the membership verbs. `create` still requires `groups`.
- **Multi-entity** — `client.atomic((drafts) => ...)` or a `defineAction` mounted as `client.actions.<name>`. Both commit exactly one Action through the same planner.

`useEntityMutations(client.todo)` is a write pass-through and is unchanged. There is no `useAction` or optimistic-update hook yet; mutations stay imperative.

## `status` replaced ad-hoc loading flags

A query result is `{ data, status, loading, error }`. `status` is derived from the engine cache, never stored by the component:

| Status     | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `unloaded` | Never run; `data` is `undefined` (never an empty list).           |
| `stale`    | A usable result exists at an older revision; a re-run is pending. |
| `current`  | The result was produced at the replica's current revision.        |
| `failed`   | The last run threw; sticky until a successful run.                |

`loading` is true only while no usable result exists, and `error` mirrors `failed`. A component that remounts reads the cached result instead of starting over, with `status: "current"` when it matches the replica's revision (`"stale"` when the replica has moved on), so there is no loading flash for held data.

## Not here yet

- **No `id` predicate.** Query the collection and `find` the row.
- **Windowing is deferred.** `limit(n)` is the only windowing; there is no cursor, offset, or page-boundary API.
- **On-demand document bodies are not a query ([#500](https://github.com/ebbjs/ebbjs/issues/500)).** A collaborative-text body is its own document entity, materialized when opened rather than scanned. Use the low-level `client.textDocument(id)` for it until that slice lands.

## Tracking

- [Epic #495](https://github.com/ebbjs/ebbjs/issues/495) — the local query engine and its decisions.
- [#501](https://github.com/ebbjs/ebbjs/issues/501) — `useQuery`, the `q` root, and the removal of `useEntity`.
- [#502](https://github.com/ebbjs/ebbjs/issues/502) — this docs and examples migration.
