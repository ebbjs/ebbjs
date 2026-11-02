# One write interface (#692)

Implementation note for [issue #692](https://github.com/ebbjs/ebbjs/issues/692)
— "refactor(client): single write interface". It records the decisions this
change takes, the surface that replaces the current three, and the semantics the
draft planner must keep. Everything here is **[decided]** for this PR; the
issue's open questions are listed in [What this does not settle](#what-this-does-not-settle).

## The three shapes today

| Shape          | Entry point                                                                                                                  | What it commits                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Namespace verb | `client.<entity>.create / update / delete / duplicate / link / unlink / setLinks / addToGroup / removeFromGroup / setGroups` | one Action, awaited, returns `WriteResponse.rejected` |
| Atomic wrapper | `client.atomic((drafts) => …)`                                                                                               | one Action from a callback's collected drafts         |
| Defined action | `defineAction(schema, cb)` mounted as `client.actions.<name>(params)`                                                        | one Action; **throws** on rejection                   |

The namespace verbs and `defineAction` already share the same operations
(`sync/operations.ts`) and the same committer, so the duplication is surface,
not mechanism. `client.atomic` is the intermediate rung: same runtime as
`defineAction`, without the reusable, out-of-component declaration.

## Decisions

1. **`defineAction` is the only way to write.** `client.atomic(...)` is removed;
   the namespace write verbs are removed. `client.<entity>` becomes read-only.
   **[decided]**
2. **Actions throw.** A server rejection raises `ActionRejectedError` from every
   action. The namespace's "return `rejected` and let the caller look" branch is
   gone: one behaviour, one place to catch. **[decided]**
3. **Draft parity.** The drafts reach every write the namespace verbs reached:
   `create` / `update` / `delete` / `duplicate` / `link` / `unlink` /
   `setLinks` / `addToGroup` / `removeFromGroup` / `setGroups`, plus the system
   `group` / `membership` namespaces. Nothing is dropped, so a single-entity app
   writes `client.actions.updateIssue({ id, patch })`. The system namespaces keep
   the verbs their namespace forms had and lack only the membership verbs an
   `entityGroup` row makes meaningless. **[decided]**
4. **The system `membership` draft grows `update` / `delete`.** `groupMember`
   rows could only be created through the planner, which is why
   `examples/issue-tracker`'s `leaveWorkspace` is two Actions today
   (`src/workspace.ts` says so). With `membership.delete` in the same batch as
   the profile's `removeFromGroup`, leaving is one Action. **[decided]**
5. **`client.write` / `client.seed` stay.** They are the transport (and the
   schema-less fixture path), not the application write surface. The one other
   writer that bypasses an action is the field layer: a `TextDocument`
   (`e.collaborativeText()`) submits its own compressed Action as local edits
   flush, through `client.write`, with no draft callback in between. That is the
   field type's own write protocol, not an application mutation, and this change
   leaves it alone. **[decided]**
6. **`useEntityMutations` is removed from `@ebbjs/react`.** It is a pass-through
   to the namespace verbs; with those gone there is nothing to bind. Components
   call `client.actions.<name>` (or the app's own wrapper) instead.
   **[decided]**
7. **The `Atomic*` type names become `Action*` / `Draft*`.** With no atomic
   surface left, the prefix is noise: `ActionDrafts`, `DraftNamespace`,
   `SystemDraftNamespace`, `ActionRejectedError`, `ActionResolutionError`,
   `ActionRejection`, `ActionCapability`. `CreatedEntity` keeps its name.
   **[decided]**
8. **The module moves**: `sync/atomic.ts` → `sync/drafts.ts`, exporting
   `createActionRuntime`. **[decided]**

## The surface

```ts
// module scope — one declaration, mounted at createClient
export const createIssue = defineAction(
  schema,
  ({ issue }, params: { readonly title: string; readonly groupId: string }) =>
    issue.create({ title: params.title, status: "todo" }, { groups: [params.groupId] }),
);

const client = createClient({ serverUrl, actorId, schema, actions: { createIssue } });
const { id } = await client.actions.createIssue({ title: "Ship it", groupId });
```

### Entity draft namespace

```ts
interface DraftNamespace<TFields> {
  create(input, opts: { groups: readonly GroupRef[]; validate?: boolean }): CreatedEntity<TFields>;
  update(id: string, patch: Partial<WireStatic<TFields>>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
  duplicate(
    id: string,
    opts?: { at?: "current" | "preSync"; groups?; validate? },
  ): CreatedEntity<TFields>;
  link(id: string, as: string, target: PointerValue): void;
  unlink(id: string, as: string): void;
  setLinks(id: string, as: string, patch: ManyPointerValue): void;
  addToGroup(id: string, groupId: GroupRef): void;
  removeFromGroup(id: string, groupId: GroupRef): void;
  setGroups(id: string, groupIds: readonly GroupRef[]): void;
}
```

Every verb is **synchronous**: it records work against the collector and the
Action is submitted when the callback returns. `create` / `duplicate` return a
handle carrying the minted id (so a later verb in the same callback can point at
it); the rest return `void`.

### System draft namespaces

```ts
// The shared entity verbs (update / delete / duplicate / link / unlink /
// setLinks) plus a custom `create`; membership verbs are absent.
group: SystemDraftNamespace<GroupFields>;
membership: SystemDraftNamespace<GroupMemberFields> & {
  update(id: string, patch: Partial<WireStatic<GroupMemberFields>>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
};
```

`group.create` keeps the bootstrap (the group row plus the acting actor's
membership, one Action), and `membership.create` stays a plain system put.
`membership.update` / `delete` keep the local `last_group_member` guard that
used to live in the namespace. Nothing else the system namespaces could write is
dropped — a group can still be renamed, copied, or deleted, and a `groupMember`
row can still be duplicated and linked.

## The planner

Today the callback is synchronous and runs before any read: `create` mints ids
and pushes operations directly, while membership verbs push _intents_ that a
resolver walks after the callback. Parity needs the same treatment for every
verb that reads the local replica before it can build its Updates:

| Verb                             | Needs from the local view                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`                         | nothing (its groups are the argument)                                                                                                                                |
| `update` / `delete`              | the entity's live group set                                                                                                                                          |
| `duplicate`                      | the source row (`current` or the earliest conflict's `before`), its live groups when `groups` is omitted, and `last_group_member` when the source is a `groupMember` |
| `link` / `setLinks`              | the entity's live group set                                                                                                                                          |
| `unlink`                         | the one-cardinality relationship row's id, plus the live group set                                                                                                   |
| `addToGroup` / `removeFromGroup` | the entity's live memberships (a live group makes the add a no-op; a remove needs the row id)                                                                        |
| `setGroups`                      | same, in full                                                                                                                                                        |
| `membership.update` / `delete`   | the `groupMember` guard (group + permissions of the group's member view)                                                                                             |

So the collector keeps **one ordered list of steps** — either a ready
`OperationCall` or a pending `DraftIntent`. After the callback the resolver
walks that list in order, resolves each intent against the local view, and
splices the resulting calls into the same position. Order is load-bearing:

- `create` then `update` of the same id must emit the put before the patch.
- `create` then `addToGroup` must not read the (not yet materialized) local row
  for the entity's groups; and `removeFromGroup` after a batch-local create
  must see the batch's own groups.

The collector therefore carries a minimal batch overlay, consulted before the
capability:

```ts
batching: Map<string /* entity id */, { groups: Set<string>; parts: GeneratedParts }>;
```

`create` seeds it; `addToGroup` / `removeFromGroup` / `setGroups` update it as
they resolve. A read falls through to the capability when the id is absent.

Intent resolution order is the callback's call order, which is what makes
"create, then patch, then share" a coherent single Action.

**The overlay states what the batch does, not what the store holds.** Once a
membership verb has resolved, the overlay carries the post-delta group set, so a
verb later in the same callback is scoped to the groups the entity will be in by
then — `setGroups(id, [g2])` followed by `update(id, patch)` scopes the patch to
`g2`, not to the groups the store still shows. That is the only reading under
which the per-Update delivery scope matches the Action's own order. The reverse
order is unaffected: `update` before `setGroups` uses the pre-delta set, because
that is what the overlay held when it resolved.

## Semantics that must not move

- **One Action.** Every draft call in one callback lands in one Action, in call
  order, spanning groups freely (each Update is delivered by its own scope).
- **Validation timing.** Field validation still runs during the commit (before
  the wire), not at draft time; `validate: false` still opts out.
- **Idempotence.** `addToGroup` on a group the entity already holds stays a
  no-op (no Update), which is what keeps a retry safe.
- **`last_group_member` and last-membership refusals.** A locally provable
  refusal throws before the wire, exactly as it does today; an empty local view
  still defers to the server.
- **Derived bodies.** `create` with an `e.collaborativeText()` field still mints
  the document + edge + membership in the same Action, and a later membership
  verb in the same callback still carries the batch-minted parts.
- **Rejection handling.** `ActionRejectedError` carries the rejected Updates,
  same shape as today's `AtomicActionError`.

## File plan

| Path                                                                                        | Change                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/client/src/sync/atomic.ts` → `drafts.ts`                                          | draft verbs, ordered step list + batch overlay, `createActionRuntime`, renames                                                                                                                         |
| `packages/client/src/sync/operations.ts`                                                    | add `duplicateEntity` operation (mint ids from `OpContext`, so duplicate keeps one write path)                                                                                                         |
| `packages/client/src/sync/namespace.ts`                                                     | drop the write verbs from `EntityNamespace` / `GroupNamespace` / `MembershipNamespace` and from the factories; `WriteCapability` becomes `ReadCapability` (the registry plus the text-document opener) |
| `packages/client/src/sync/client.ts`                                                        | drop the `client.atomic` property; mount `client.actions` on `createActionRuntime`; extend the capability with the reads the planner needs                                                             |
| `packages/client/src/index.ts`                                                              | export `ActionDrafts`, `DraftNamespace`, `ActionRejectedError`, … ; drop the removed types                                                                                                             |
| `packages/react/src/use-entity-mutations.ts`                                                | delete (with its test and its README mention)                                                                                                                                                          |
| `examples/issue-tracker/**`                                                                 | actions module per feature area; forms/detail call `client.actions.*`; `leaveWorkspace` becomes one Action                                                                                             |
| `packages/client/README.md`, `packages/react/README.md`, `packages/www/src/content/docs/**` | one write path in the docs                                                                                                                                                                             |
| `packages/client/src/**/__tests__/**`                                                       | tests drive writes through a mounted action; new tests for the added verbs                                                                                                                             |

## What this does not settle

- **The `defineActions` spelling.** The issue says "defineActions" but the
  export is `defineAction` and it declares one Action; this PR keeps
  `defineAction` and flags the discrepancy rather than renaming an export the
  issue does not name precisely.
- **A testing helper for actions** (the issue's third proposal) — not delivered.
  The issue rules out a testing framework, and this PR adds no public seam: the
  callback a definition holds lives behind a non-exported symbol, so an app
  cannot call it with a fake draft object. Testing an action today means driving
  it through a client, which is what
  `packages/client/src/sync/__tests__/draft-verbs.test.ts` does. A public pattern
  is a follow-up; claiming it is done here would be wrong. The seam it needs is
  prepared: `ActionCapability` keeps its commit members flat and nests the local
  reads under `read`, so a harness can seed the read half and capture the commit
  half without reimplementing either, and the runtime body stops mixing a read
  with an effect.
- **Migration / deprecation.** Out of scope: the old surface is deleted, not
  aliased, and the changeset is a minor for `@ebbjs/client` and `@ebbjs/react`
  (pre-1.0, no consumers to migrate).
