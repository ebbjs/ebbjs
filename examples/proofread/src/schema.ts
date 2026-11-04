/**
 * The example's data model.
 *
 * The function reads a `document` and creates `comment` rows. The document
 * link is a plain field: the function files each comment into the caller's
 * workspace group, and v1 has no relationship write in this example.
 */
import { defineEntity, defineSchema, e } from "@ebbjs/schema";

export const document = defineEntity("document", {
  title: e.string(),
  body: e.string(),
});

export const comment = defineEntity("comment", {
  documentId: e.string(),
  body: e.string(),
});

export const schema = defineSchema({
  entities: { document, comment },
  version: 1,
});

export type Schema = typeof schema;
