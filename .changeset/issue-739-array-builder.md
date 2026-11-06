---
"@ebbjs/schema": minor
---

Add `e.array(value)`, the list-field builder, with the same `.default()`
chain as the other builders. It keeps array fields (such as a
many-relationship's canonical FK set) in the `e` vocabulary instead of
dropping to raw TypeBox, so their create/read shape is the one the SDK owns.
