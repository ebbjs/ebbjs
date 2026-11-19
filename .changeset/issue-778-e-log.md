---
"@ebbjs/schema": minor
"@ebbjs/client": minor
---

`e.log(entrySchema)` declares an append-only log component: a keyed component whose
entries may only be added. Its wire shape is an ordinary map, so merge, storage, and the
server need no new code; the entry payload is opaque and the map key is minted by the
writer, never parsed. A log must be the component's own shape — a field-map component is
one atomic merge position — so `defineComponent` now refuses a nested log and an app
declares the engine leaf and the log as sibling components.

`SyncClient.write` now drives the append-only guard from the registry
(`ModelRegistry.isLogField`) and generic schema helpers (`logEntriesOf`, `logRewrites`),
so a rewrite is refused with the component and keys named for any declared log, not only
a `/content` component. A caller that kept `content: e.map(TextCellSchema)` loses
append-only protection and must switch to `e.log(TextCellSchema)`.

Breaking (pre-release): the text body's `version` leaf is gone. `DOC_VERSION_FIELD`,
`CURRENT_TEXT_VERSION`, `versionField`, `assertKnownVersion`, `DocumentVersionError`, and
`TextDocument.hydrate`'s `version` parameter are deleted; an `engine` leaf replaces the
format check in #783, and the pre-release store reset is the compatibility answer
(#775 decision 12). Also removed as dead: `appendOnlyRewrites`, `CellFieldValueSchema`,
`contentKeys`, `readCellFields`, and `isLogPosition`.
