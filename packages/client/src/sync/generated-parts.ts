/**
 * Resolve an entity's generated parts from the local cache: the
 * document entities backing its derived collaborative-text fields, and
 * the generated edges that link to them.
 *
 * A membership change must carry these parts into the entity's new
 * groups — the document needs its own `entityGroup` rows, and the edge
 * must be re-emitted so the server scopes it to the new group
 * (per-Update delivery, #473). The types and pure values live in
 * `@ebbjs/write`; this module owns the storage reads.
 */

import type { StorageAdapter } from "@ebbjs/storage/types";
import type { EntityRegistry } from "@ebbjs/schema";
import {
  NO_GENERATED_PARTS,
  type GeneratedDocument,
  type GeneratedEdge,
  type GeneratedMembership,
  type GeneratedParts,
} from "@ebbjs/write";

export type { GeneratedDocument, GeneratedEdge, GeneratedMembership, GeneratedParts };
export { NO_GENERATED_PARTS };

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
