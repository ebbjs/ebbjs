---
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
---

Permissions name the component a write names, and grants match by ancestry.

There is no opt-in. `permission: "own"` is deleted from `defineComponent`; a schema that still
declares it now fails at load with an unknown-option error rather than being accepted quietly.
`ModelRegistry.permissionOf` is deleted.

A grant covers a write when its subject is the write's subject or an ancestor of it, and its verb
matches or is `*`:

```diff
- "note.update"     // only the model subject
+ "note.*"          // covers note/title and note/body
+ "note/title.*"    // covers note/title, not note/body
```

A user row's create and delete still name no component, so they check the model: `note.create` and
`note.delete` keep their meaning. A value write checks the component named on the wire, so a
`note/body` update requires `note/body.update` (satisfied by `note.*`, `note.*`'s model ancestor
`note.update`, or a `note/body` grant). Every component an Action writes must be covered; an
Action that writes `note/title` and `note/body` needs a grant for both.

The platform's four components need no special case: `ebb/grant` is a subject under `ebb`, so
`ebb.*` covers it. `fullGroupPermissions` is one `<model>.*` wildcard per model instead of one per
component.

Writes can be field-granular; reads cannot. Read filtering remains a group fan-out property, so a
component grant narrows what a member may write, not what they may read.
