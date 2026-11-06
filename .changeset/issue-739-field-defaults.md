---
"@ebbjs/schema": minor
---

Declarative field defaults: `e.string().default("normal")` stamps a plain JSON
Schema `default` annotation on the field's property schema. The annotation is
inert for validation (`Value.Check` ignores it) and for the wire, but it is
enumerable, so a default change is already a `schema_hash` change. A derived
collaborative-text field cannot declare one.
