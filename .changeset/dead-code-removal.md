---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
---

Internals that nothing reached are gone; no public API changed.

`@ebbjs/core` drops an unexported module of typebox-wrapping validators that no importer,
package export, or test referenced. `@ebbjs/storage` drops the component-set helpers the
per-component existence index superseded, with their cases moved onto the surviving
functions. `@ebbjs/schema` drops the anchor comparator and the cut-coverage helper the
projection already inlines. `@ebbjs/client` drops an unused conflict-oracle alias, keeps
three conflict and query-plan helpers private to their own modules, and trims two presence
fields that were written and never read.
