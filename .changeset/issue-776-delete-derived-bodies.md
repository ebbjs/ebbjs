---
"@ebbjs/schema": major
"@ebbjs/write": major
"@ebbjs/client": major
---

`e.collaborativeText()` and the derived-body mechanism are deleted.

A text body is no longer a hidden part of its parent. A document is an entity
the app declares, and a relationship it declares:

```ts
const note = defineEntity("note", { title: e.string() });
const textDocument = defineEntity(
  "text_document",
  { content: e.map(TextCellSchema), version: e.number() },
  { materialization: "on-demand" },
);
const schema = defineSchema({
  entities: { note, text_document: textDocument },
  relationships: {
    body: defineRelationship({
      source: note,
      target: textDocument,
      as: "body",
      sourceCardinality: "one",
    }),
  },
});
```

Creating a note with its document is `create` + `create` + `link` inside one
`defineAction`, so both rows and their link still land in one Action. No body
input, no generated entity, and no hidden part is involved.

What else changes:

- `defineSchema` produces exactly the entities and relationships it is given.
  Nothing is generated, so no schema hash, permission string, entity name, id,
  or row accessor is minted behind the app's back.
- A forward-one accessor over a document relationship resolves the target
  entity, like any other link. Open the row with `client.textDocument(id, type)`
  or through the document entity's own namespace.
- `defineSchema` rejects an entity-map key that differs from the definition's
  own `name` with `EntityKeyMismatchError`. A preset keyed under another name
  would otherwise have addressed another entity type — and another permission
  string.
- Deleted: `e.collaborativeText`, `EntityDef.derived`, `DerivedKeys`,
  `DerivedAccessors`, `DerivedFieldDef`, `WireFields`, `expandDerivedFields`,
  `derivedBodyIds`, `generatedDocEntityName`, `isCollaborativeText`,
  `RelationshipKind` and the relationship `kind`, the `generatedParts`
  capability, and the reserved `text_document__` entity prefix.
- Moving a note between groups does **not** move its document. That gap is
  deliberate: relationships will own their group membership (#790), and no
  interim cascade ships here.
