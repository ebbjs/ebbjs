---
"@ebbjs/client": minor
---

Give each derived query index one module (#1003).

The relation, existence and scope index families now own both directions of
their contract: the index dependencies a read declares, and the keys a change
resolves to under them. `structuralReads` composes over the same registered
family list `createIndexResolvers` serves, so a declaration and its resolver
cannot drift apart, and a hypothetical fourth index is one family module plus
one entry in that list.

The relation coverage rule — forward, one-cardinality, non-self, pinned by
every OR group — moves beside the index it protects. The wire index names,
`createIndexResolvers`' keyed record, the touched sets, and dispatch lookup
counts are unchanged. `structuralReads` is exported, and for a read that mixes
families its `indices` and `covered` arrays now list relation declarations
first; the members are the same.
