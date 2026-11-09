---
"@ebbjs/schema": patch
"@ebbjs/write": patch
"@ebbjs/client": patch
"@ebbjs/react": patch
---

Declare components as the unit of a model's identity.

`@ebbjs/schema` now exports `defineComponent`, `ComponentDef`, `ModelDef`, and
`ModelRegistry`. `defineModel` accepts named components and bare field builders
in one map; a builder normalises to an anonymous component named
`<model>/<field>`, so existing field declarations keep their meaning.
`ModelDef.components` records the declarations and `ModelDef.shape` is derived
from them. Components declare their policy, including `loading: "eager" | "lazy"`. `defineSchema` takes `models` instead of `entities`, and rejects a
component whose name does not belong to its model.

This is a shape change only: the wire, storage, and merge rules are unchanged.
The rename is mechanical — `defineEntity` → `defineModel`, `EntityDef` →
`ModelDef`, `EntityRegistry` → `ModelRegistry` — and has no compatibility alias.
