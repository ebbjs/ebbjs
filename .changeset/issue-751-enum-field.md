---
"@ebbjs/schema": minor
---

Add `e.enum(values)` — a closed-set field builder. The field reads as the
members' literal union, so `EntityValues` narrows and a `switch` over it can be
exhaustive, and a write carrying a value outside the set fails local validation
through the same path as a wrong type. `.default()` takes a member and composes
like the other builders.

Strings are the app case; numbers and booleans are accepted as literals.
`orderBy` follows the stored value — numbers numerically, everything else by
locale, an absent value last — not declaration order.

The schema README also documents the TypeBox escape hatch: anything `e` does
not cover, including nested `Type.Object` values for `e.map`, can be passed
straight to `defineEntity`.
