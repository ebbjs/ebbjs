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
import { liveMemberships } from "./entity-group";

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

  const relationships = await storage.entities.query("relationship");
  const memberships = liveMemberships(await storage.entities.query("entityGroup"));

  const documentsById = new Map<string, string>();
  const edges: GeneratedEdge[] = [];

  for (const field of Object.keys(derived)) {
    const rel = registry.getRelationship(entityType, field);
    if (rel === undefined) continue;
    const row = relationships.find(
      (candidate) =>
        candidate.deleted_hlc === null &&
        candidate.data?.fields?.["source_id"]?.value === entityId &&
        candidate.data?.fields?.["field"]?.value === field &&
        candidate.data?.fields?.["type"]?.value === rel.type,
    );
    if (row === undefined) continue;
    const targetId = row.data?.fields?.["target_id"]?.value;
    if (typeof targetId !== "string") continue;

    documentsById.set(targetId, rel.target.name);
    edges.push({
      relationshipId: row.id,
      sourceId: entityId,
      targetId,
      field,
      type: rel.type,
    });
  }

  const documents: GeneratedDocument[] = [...documentsById].map(([id, type]) => ({
    id,
    type,
    memberships: memberships
      .filter((membership) => membership.entityId === id)
      .map((membership) => ({
        membershipId: membership.membershipId,
        groupId: membership.groupId,
      })),
  }));

  return { documents, edges };
}
