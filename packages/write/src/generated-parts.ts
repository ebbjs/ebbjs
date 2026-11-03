/**
 * The generated parts an entity's membership change must carry: the
 * document entities backing its derived collaborative-text fields, and
 * the generated edges that link to them.
 *
 * Domain relationships do not travel: walking them would drag the graph
 * transitively, so only fields the registry marks `derived` are
 * considered. Reading these parts from storage stays in `@ebbjs/client`.
 */

/** A generated edge: the live `relationship` row linking parent to document. */
export interface GeneratedEdge {
  readonly relationshipId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly field: string;
  readonly type: string;
}

/** One live `entityGroup` row of a generated document. */
export interface GeneratedMembership {
  readonly membershipId: string;
  readonly groupId: string;
}

/** A generated document entity and the groups it is currently filed into. */
export interface GeneratedDocument {
  readonly id: string;
  readonly type: string;
  readonly memberships: readonly GeneratedMembership[];
}

/** The generated parts an entity's membership change must carry. */
export interface GeneratedParts {
  readonly documents: readonly GeneratedDocument[];
  readonly edges: readonly GeneratedEdge[];
}

/** No derived fields, or none linked — a value that shares one frozen identity. */
export const NO_GENERATED_PARTS: GeneratedParts = Object.freeze({
  documents: [],
  edges: [],
});
