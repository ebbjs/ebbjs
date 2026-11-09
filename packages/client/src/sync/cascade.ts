/**
 * Resolve an entity's containment cascade from the local cache: every live
 * target of a relationship the entity declares `contained`, plus the edges
 * that reached them.
 *
 * A membership change must carry a contained target into the entity's new
 * groups: the target needs its own `entityGroup` rows, and the edge is
 * re-emitted so the server scopes it to the new group (per-Update delivery,
 * #473). Containment is not link visibility: a relationship that is not
 * `contained` keeps the group it was written under (#789). The types and pure
 * values live in `@ebbjs/write`; this module owns the storage reads.
 */

import type { StorageAdapter } from "@ebbjs/storage/types";
import type { EntityRegistry } from "@ebbjs/schema";
import {
  NO_CASCADE,
  type CascadeEdge,
  type CascadeMembership,
  type CascadeParts,
  type CascadeTarget,
} from "@ebbjs/write";

export type { CascadeEdge, CascadeMembership, CascadeParts, CascadeTarget };
export { NO_CASCADE };

/**
 * Read the entity's live cascade. Only relationships declared `contained`
 * are walked, so a non-contained edge never drags its target even when a
 * live row exists for it.
 *
 * Targets are deduped by id: two accessors may reach one row, and duplicate
 * `entityGroup` puts would create duplicate memberships.
 */
export async function readCascadeParts(
  storage: StorageAdapter,
  registry: EntityRegistry,
  entityType: string,
  entityId: string,
): Promise<CascadeParts> {
  const cascading = registry.getContainedRelationshipsForSource(entityType);
  if (cascading.length === 0) return NO_CASCADE;

  const targetsById = new Map<string, string>();
  const edges: CascadeEdge[] = [];

  for (const rel of cascading) {
    const links = await storage.entities.queryByRelationshipSource({
      as: rel.as,
      type: rel.type,
      sourceId: entityId,
    });
    for (const link of links) {
      targetsById.set(link.targetId, rel.target.name);
      edges.push({
        relationshipId: link.relationshipId,
        sourceId: entityId,
        targetId: link.targetId,
        field: rel.as,
        type: rel.type,
      });
    }
  }

  if (targetsById.size === 0) return NO_CASCADE;

  const targets: CascadeTarget[] = await Promise.all(
    [...targetsById].map(async ([id, type]) => {
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

  return { targets, edges };
}
