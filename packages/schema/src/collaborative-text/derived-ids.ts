/**
 * Deterministic ids for the rows a derived field implies: the document
 * entity backing an `e.collaborativeText()` body, and the relationship
 * from the parent to it.
 *
 * ebb has no server-side migrations — every migration is a client write
 * (#696) — so these rows are created by whichever client first finds them
 * missing. A minted id would let two clients address the same absent row
 * under two different ids, producing two documents, two relationships,
 * and text split across them. Identity is therefore derived from facts
 * every client already agrees on: the parent id (globally unique, never
 * reused), the field accessor (the relationship's stable identity on that
 * parent), and — for the document — the document entity's name.
 *
 * Nothing else enters the id. No clock, no actor, no schema version, no
 * parent type.
 *
 * The encoding is length-prefixed rather than `e_derived_<parent>_<field>`.
 * Field names are arbitrary strings, so the readable form maps
 * `("e_ab", "c_d")` and `("e_ab_c", "d")` onto one id. `entityGroupId`
 * length-prefixes its first component for the same reason.
 *
 * Neither namespace is reachable by minting: `generateId` emits `<prefix>_`
 * plus 16 chars of `[a-z0-9]`, so a minted id carries exactly one `_`.
 */

import type { EntityRegistry } from "../entity-registry";

import { generatedDocEntityName } from "./schema";

/** The shared `<plen>_<parentId><flen>_<field>` core both ids build on. */
const derivedKey = (parentId: string, field: string): string =>
  `${parentId.length}_${parentId}${field.length}_${field}`;

/**
 * The document entity id for a derived body of `field` on `parentId`.
 *
 * `documentType` is the document's entity name, and it belongs in the id
 * only here: the server binds an id to the type it was first committed
 * under, so renaming a body's document has to yield a new document.
 */
export const derivedDocumentId = (parentId: string, field: string, documentType: string): string =>
  `e_derived_${derivedKey(parentId, field)}${documentType}`;

/**
 * The relationship id linking `parentId` to its derived document for
 * `field`.
 *
 * Deliberately independent of the document type: the relationship's
 * identity is `(parent, field)`, so a document rename re-points this same
 * row instead of orphaning it — the server allows `target_id` / `type` /
 * `field` changes on a relationship `put` and refuses only source changes.
 */
export const derivedRelationshipId = (parentId: string, field: string): string =>
  `rel_derived_${derivedKey(parentId, field)}`;

/** Both ids for one derived body, plus the document entity name they encode. */
export interface DerivedBodyIds {
  readonly documentType: string;
  readonly documentId: string;
  readonly relationshipId: string;
}

/** Everything a derived body's identity depends on. */
export interface DerivedBodyFacts {
  readonly registry: EntityRegistry;
  /** The parent's entity name, as registered — not the document's. */
  readonly entityName: string;
  /** The parent entity's id. */
  readonly parentId: string;
  /** The parent's field accessor. */
  readonly field: string;
}

/**
 * Locate a derived body in the id space: the one place that decides what
 * its document entity is called, so the create operation and the draft
 * planner cannot derive two different ids for the same body.
 *
 * The document is the schema's generated entity unless
 * `e.collaborativeText({ entity })` named one explicitly.
 */
export const derivedBodyIds = (facts: DerivedBodyFacts): DerivedBodyIds => {
  const { registry, entityName, parentId, field } = facts;
  const documentType =
    registry.getRelationship(entityName, field)?.target.name ??
    generatedDocEntityName(entityName, field);
  return {
    documentType,
    documentId: derivedDocumentId(parentId, field, documentType),
    relationshipId: derivedRelationshipId(parentId, field),
  };
};
