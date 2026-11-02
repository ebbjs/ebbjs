---
"@ebbjs/client": minor
"@ebbjs/react": minor
---

Converge on one write interface: every write is now an action.

Ebb is pre-1.0 and has no consumers yet, so the removed surface ships as a
minor (0.3.0 → 0.4.0) rather than a major. Nothing persisted changes — no wire
format, no stored shape, no migration — so there is no upgrade path to protect.

`defineAction(schema, (drafts, params) => ...)` is the only write surface.
Mount it at `createClient({ schema, actions })` and call it as
`client.actions.<name>(params)`. One callback commits as one Action, and a
rejection throws `ActionRejectedError` instead of returning `rejected`.

Removed:

- `client.atomic(...)` — move its callback body into a `defineAction` callback;
  the draft verbs are unchanged.
- The per-entity write verbs on `client.<entity>` (`create` / `update` /
  `delete` / `duplicate` / `link` / `unlink` / `setLinks` / `addToGroup` /
  `removeFromGroup` / `setGroups`), and the same verbs on `client.group` /
  `client.membership`. Those namespaces are read-only now; call the matching
  draft verb inside an action. `create` still requires `groups`, and `create` /
  `duplicate` still return a handle with `.id` for multi-entity actions.
- `useEntityMutations` from `@ebbjs/react` — call `client.actions.<name>` from
  `useClient` instead.

Renamed types: `AtomicActionError` → `ActionRejectedError`, `AtomicDrafts` →
`ActionDrafts`, `AtomicDraftNamespace` → `DraftNamespace`, `AtomicCreateOptions` →
`DraftCreateOptions`. The entity namespace's `CreateOptions` / `DuplicateOptions`
are now `DraftCreateOptions` / `DraftDuplicateOptions`, and a draft `create` /
`duplicate` returns a `CreatedEntity` handle rather than `CreateResult`.
`AtomicCreateInput` is gone: a draft `create` now takes the entity's typed wire
fields (plus derived-body strings and relationship pointers), the way the
removed namespace `create` did.

New: `EntityValues<typeof entity>` names the value shape of an entity's wire
fields, so an action's patch parameter follows the schema instead of
restating it (`Partial<EntityValues<typeof issue>>`).

`client.seed(...)` and the low-level `client.write(actions)` are unchanged, as
are reads, collaborative text, conflicts, and presence.
