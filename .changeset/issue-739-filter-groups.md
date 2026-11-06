---
"@ebbjs/client": major
"@ebbjs/schema": major
---

A filter is now a disjunction of groups.

```ts
type FilterGroup = Record<string, string | number | boolean | null>;
type Filter = readonly FilterGroup[];
```

Keys within a group are ANDed; groups are ORed. `[{ priority: "normal" }]` is the
old single-object filter, `[{ priority: "normal" }, { priority: null }]` reads as
normal or unset, and `[]`, `[{}]`, `null`, or an omitted filter is unfiltered —
an empty conjunction is TRUE, so any empty group drops the whole filter. A
`null` entry (`[null]`) is malformed and rejected as `invalid_filter`; a `null`
value inside a group (`[{ priority: null }]`) is the predicate "no live value"
and stays distinguishable from it. The 64-key budget applies per group.

`EntityRegistry.validateFilter` takes the group list (or `null`) and reports
violations per group, naming the group index. `client.queryEntities` forwards
the list unchanged. `filterToGroups` lowers a `Filter` to the builder's existing
DNF `Query.groups`, so both paths evaluate one predicate language.

On the server, `QueryFilter.normalize/1` accepts `nil`, `[]`, or a list of
groups, and `build_filter_clauses` ANDs each group's clauses inside
parentheses, joins groups with `OR`, and wraps the disjunction so it composes
with the base `WHERE`.
