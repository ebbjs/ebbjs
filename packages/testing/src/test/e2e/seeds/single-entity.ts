import type { GroupSeed, SeedData } from "@ebbjs/testing";

/** What a caller may pin; everything else comes from the fixture's defaults. */
export interface SingleEntityFixtureOptions {
  /**
   * Replaces the default group list. The first group anchors the grant and the
   * membership: this fixture is one actor, one group, one entity.
   */
  groups?: readonly GroupSeed[];
  actorId?: string;
  entityId?: string;
  model?: string;
}

/**
 * The one fixture the e2e suite seeds, alongside the ids a test asserts on, so
 * a test never re-spells an id the seed chose. Override any of them and the
 * seed and the assertions move together.
 */
export interface SingleEntityFixture {
  readonly seed: SeedData;
  readonly groupId: string;
  readonly actorId: string;
  readonly entityId: string;
  readonly model: string;
}

const DEFAULT_GROUP: GroupSeed = { id: "grp_001", name: "Test Group" };
const DEFAULT_ACTOR_ID = "actor_test";
const DEFAULT_ENTITY_ID = "ent_001";
const DEFAULT_MODEL = "text_document";

/**
 * One group, one granted actor, and one entity with no components at all — the
 * zero-component row the e2e suite proves materializes as a live row.
 */
export function buildSingleEntitySeed(
  options: SingleEntityFixtureOptions = {},
): SingleEntityFixture {
  const groups = options.groups ?? [DEFAULT_GROUP];
  const groupId = groups[0]?.id ?? DEFAULT_GROUP.id;
  const actorId = options.actorId ?? DEFAULT_ACTOR_ID;
  const entityId = options.entityId ?? DEFAULT_ENTITY_ID;
  const model = options.model ?? DEFAULT_MODEL;

  return {
    groupId,
    actorId,
    entityId,
    model,
    seed: {
      groups: [...groups],
      grants: [
        {
          id: `gm_${actorId}`,
          actorId,
          groupId,
          permissions: [`${model}.*`, "read", "write"],
        },
      ],
      entities: [
        {
          id: entityId,
          model,
          patches: [],
        },
      ],
      relationships: [],
      memberships: [
        {
          id: `eg_${entityId}`,
          entityId,
          groupId,
        },
      ],
    },
  };
}
