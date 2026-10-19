/**
 * Resolve an entity's generated parts from the local cache: the
 * document entities backing its derived collaborative-text fields, and
 * the generated edges that link to them.
 *
 * A membership change must carry these parts into the entity's new
 * groups — the document needs its own `entityGroup` rows, and the edge
 * must be re-emitted so the server scopes it to the new group
 * (per-Update delivery, #473). Domain relationships do not travel:
 * walking them would drag the graph transitively, so only fields the
 * registry marks `derived` are considered.
 */

import type { StorageAdapter } from "@ebbjs/storage/types";

import type { EntityRegistry } from "../schema/entity-registry";

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

/**
 * Read the entity's live generated parts. Only the registry's `derived`
 * map is walked, so a domain relationship never appears even when a
 * live row exists for it.
 *
 * Documents are deduped by target id: two derived fields may share one
 * explicit document entity via `e.collaborativeText({ entity })`, and
 * duplicate `entityGroup` puts would create duplicate rows.
 */
export async function readGeneratedParts(
  storage: StorageAdapter,
  registry: EntityRegistry,
  entityType: string,
  entityId: string,
): Promise<GeneratedParts> {
  const derived = registry.get(entityType)?.derived ?? {};
  if (Object.keys(derived).length === 0) return NO_GENERATED_PARTS;

  const documentsById = new Map<string, string>();
  const edges: GeneratedEdge[] = [];

  for (const field of Object.keys(derived)) {
    const rel = registry.getRelationship(entityType, field);
    if (rel === undefined) continue;
    const links = await storage.entities.queryByRelationshipSource({
      as: field,
      type: rel.type,
      sourceId: entityId,
    });
    const link = links[0];
    if (link === undefined) continue;

    documentsById.set(link.targetId, rel.target.name);
    edges.push({
      relationshipId: link.relationshipId,
      sourceId: entityId,
      targetId: link.targetId,
      field,
      type: rel.type,
    });
  }

  const documents: GeneratedDocument[] = await Promise.all(
    [...documentsById].map(async ([id, type]) => {
      const memberships = await storage.entities.queryByMembershipEntity(id);
      return {
        id,
        type,
        memberships: memberships.map((membership) => ({
          membershipId: membership.membershipId,
          groupId: membership.groupId,
        })),
      };
    }),
  );

  return { documents, edges };
}
