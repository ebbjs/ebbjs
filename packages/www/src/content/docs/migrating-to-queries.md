---
title: "Migrating to queries"
description: "How to move from entity accessors and useEntity to the query read surface — what changed, what became internal, and what is not here yet."
---

> **Shipped.** This page tracks the docs and examples migration in [#502](https://github.com/ebbjs/ebbjs/issues/502), part of the [local query engine epic](https://github.com/ebbjs/ebbjs/issues/495). The React surface landed in [#501](https://github.com/ebbjs/ebbjs/issues/501); the engine, namespace split, and replica lifecycle ([#499](https://github.com/ebbjs/ebbjs/issues/499)) landed before it. [#500](https://github.com/ebbjs/ebbjs/issues/500) remains open.

The public read surface is `query()` for a collection and `get(id, { select })` for one row. The entity namespace stays — it is still the schema-bound API — but it is read-only: every write is an Action mounted as `client.actions.<name>` ([#692](https://github.com/ebbjs/ebbjs/issues/692)). The async row accessors and the collection `subscribe` remain internal.

## What changed

| Before                                       | After                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `client.<entity>.get(id)` plus row accessors | `query()` for lists, `get(id, { select })` for one row; accessors stay internal                                  |
| `await row.assignee`, `await row.comments`   | `.with({ assignee: true, comments: true })` on the chain                                                         |
| `await row.groups`                           | `.with({ groups: true })`, or `row.groupIds` for the ids alone                                                   |
| `client.<entity>.subscribe(filter, cb)`      | `useQuery` in React, `query().result()` / `query().subscribe(cb)` otherwise                                      |
| `useEntity(build, deps)`                     | `useQuery((q: QueryRoot<Schema>) => ...)`                                                                        |
| Single row by id                             | `get(id, { select })`                                                                                            |
| Writes                                       | One path: `defineAction`, mounted as `client.actions.<name>` ([#692](https://github.com/ebbjs/ebbjs/issues/692)) |

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

The chain is immutable, so a helper can return a partially-built query and the caller keeps narrowing it. `where` takes a field, a registered relationship `as`, or the reserved `groups` key; `or` starts a new AND-group (`.where(a).where(b).or(c)` is `(a AND b) OR c`). `select(...)` names the fields to project; the same declaration decides the components the read leases and re-runs on.

## Single rows

The grammar has no `id` predicate on a query, so one row is read through the
namespace with the same selection a query takes:

```ts
const issue = await client.issue.get(issueId, { select: { title: true, status: true } });
if (issue === null) return missing;
const off = issue.subscribe((event) => {
  if (event.type === "snapshot") render(event.row);
});
```

The selection narrows both the projection and the components the read leases.
`subscribe` keeps those components leased until `off()`, and reports `snapshot`
or `unloaded` events. A collection query plus `find` is still the way to read a
row out of a filtered, ordered list.

## Relationships and membership are joins

`with(...)` is one level deep. A source-side relationship joins forward (one-cardinality to a row or `null`, many to an array), a target-side one joins in reverse (always an array), and `groups` is built in on every entity. The joined keys are typed from the schema's relationship map, so a nested selector is a compile error.

```tsx
q.workspace.query().with({ groups: true });
q.issue.query().where("status", "open").with({ assignee: true, comments: true });
```

To filter by an edge instead of projecting it, use the relationship's `as` key as a `where` key. A relationship key wins over a same-named field, matching the old accessors. `.where("groups", groupId)` filters built-in membership through the replica's index.

Every query row also carries `groupIds`, its live group ids, read from the same index. A workspace switcher or a board can read the ids straight off the row instead of denormalising a `group_id` field or projecting the group rows. The ids come from membership rows, so one can name a group whose row is not materialized; use `.with({ groups: true })` when you need the group's fields. Joined target rows and chains over already-materialized candidates are plain projections (fields plus `id`) and carry no `groupIds`.

## `get(id, { select })` is the single-row read

`get(id, { select })` is public: it is the single-row read beside `query()`, and the selection is what it projects and leases. The async row accessors it attaches and the collection `subscribe(filter, cb)` remain `@internal`; applications should not build on those. Projected query rows carry the entity `id` as an addressing key, so the id an action needs (`client.actions.<name>({ id, ... })`) comes from the row itself.

`.toRaw()` remains the untyped escape hatch on a chain when you need the wire envelope rather than the projected row.

## Writes: one path

Writes converge on actions ([#692](https://github.com/ebbjs/ebbjs/issues/692)).
`defineAction(schema, (drafts, params) => ...)` is the only write declaration,
mounted at `createClient` and called as `client.actions.<name>(params)`:

```ts
export const renameIssue = defineAction(
  schema,
  ({ issue }, params: { id: string; title: string }) =>
    issue.update(params.id, { title: params.title }),
);

await client.actions.renameIssue({ id: issue.id, title });
```

The drafts reach every write the removed namespace verbs reached — `create` /
`update` / `delete` / `duplicate`, `link` / `unlink` / `setLinks`, and the
membership verbs, plus the system `group` / `membership` namespaces. `create`
still requires `groups`. One callback is one Action, however many entities and
groups it touches, and a rejection throws `ActionRejectedError`.

`client.<entity>` is read-only, `client.atomic` is gone, and
`useEntityMutations` is removed from `@ebbjs/react`. Components call
`client.actions.<name>` through `useClient`. There is no `useAction` or
optimistic-update hook yet; actions stay imperative.

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

- **No `id` predicate on a query.** Read one row with `get(id, { select })`, or query the collection and `find` it.
- **Paging is deferred.** `limit(n)` is the only paging control; there is no cursor, offset, or page-boundary API.
- **Document bodies are not a query ([#500](https://github.com/ebbjs/ebbjs/issues/500)).** A collaborative-text body is its own document entity, read when opened rather than scanned. Use the low-level `client.textDocument(id)` for it until that slice lands.

## Tracking

- [Epic #495](https://github.com/ebbjs/ebbjs/issues/495) — the local query engine and its decisions.
- [#501](https://github.com/ebbjs/ebbjs/issues/501) — `useQuery`, the `q` root, and the removal of `useEntity`.
- [#502](https://github.com/ebbjs/ebbjs/issues/502) — this docs and examples migration.
