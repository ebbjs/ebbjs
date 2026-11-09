/**
 * The cascade a membership change must carry: the live targets of every
 * relationship the source declares `contained`, and the edges themselves so
 * an add can re-emit them under the new group scope.
 *
 * Containment is not link visibility. A relationship that is not `contained`
 * keeps the group it was written under (#789); only a contained target moves
 * with its source. Reading these parts from storage stays in `@ebbjs/client`.
 *
 * A **target** is deduped by id (two accessors may reach one row), while an
 * **edge** is per relationship row, because a re-emitted edge is addressed by
 * its own id.
 */

/** One live relationship row from a cascading accessor. */
export interface CascadeEdge {
  readonly relationshipId: string;
  readonly sourceId: string;
  readonly targetId: string;
  /** The accessor that reached the target. */
  readonly field: string;
  /** The relationship's wire `type`. */
  readonly type: string;
}

/** One live `entityGroup` row of a cascaded target. */
export interface CascadeMembership {
  readonly membershipId: string;
  readonly groupId: string;
}

/** A cascaded target and the groups it is currently filed into. */
export interface CascadeTarget {
  readonly id: string;
  readonly type: string;
  readonly memberships: readonly CascadeMembership[];
}

/** Everything a membership change carries alongside the source's own delta. */
export interface CascadeParts {
  readonly targets: readonly CascadeTarget[];
  readonly edges: readonly CascadeEdge[];
}

/** No cascading relationships, or none linked — one frozen identity. */
export const NO_CASCADE: CascadeParts = Object.freeze({
  targets: [],
  edges: [],
});
