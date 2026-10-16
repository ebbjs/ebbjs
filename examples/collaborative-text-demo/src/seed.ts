/**
 * Seed helpers — bootstrap the demo group + member + document on first load.
 *
 * Rows are plain data submitted through the shared seed layer
 * (`@ebbjs/client/seed`), the same path `@ebbjs/server.seed()` uses: the
 * client builds one Action and submits it through the public write path,
 * applying the shared rejection-tolerance policy.
 */

import type { SeedData } from "@ebbjs/client";

export const DEMO_GROUP_ID = "grp_demo";
export const DEMO_MEMBER_ID = "gm_demo";
export const DEMO_MEMBERSHIP_ID = "eg_demo";
export const DEMO_DOC_ID = "doc_demo";

/**
 * Derived seed IDs for a given group id. Used by `bootstrap` to seed
 * an isolated group per Playwright spec so `cf_actions` from a prior
 * spec doesn't leak into the next one (see #197). Same prefixes as
 * the demo defaults so the seed shape stays uniform.
 */
export function deriveSeedIds(groupId: string): {
  memberId: string;
  membershipId: string;
  docId: string;
} {
  return {
    memberId: `gm_${groupId}`,
    membershipId: `eg_${groupId}`,
    docId: `doc_${groupId}`,
  };
}

/** Build the seed payload for the demo: one group, one member, one empty doc. */
export function buildDemoSeed(groupId: string = DEMO_GROUP_ID): SeedData {
  const { memberId, membershipId, docId } = deriveSeedIds(groupId);

  return {
    groups: [{ id: groupId, name: "Demo Group" }],
    groupMembers: [
      {
        id: memberId,
        actorId: "demo-seeder", // Seed runs as a dedicated actor
        groupId,
        // Wildcard permission so anyone in the group can write the doc.
        permissions: ["text_document.*", "group.*", "groupMember.*", "relationship.*"],
      },
    ],
    entities: [
      {
        id: docId,
        type: "text_document",
        patches: [{ fields: {} }], // empty document
      },
    ],
    entityGroups: [
      {
        id: membershipId,
        entityId: docId,
        groupId,
      },
    ],
  };
}

/**
 * Build a seed payload adding `actorId` as a member of `groupId`. Run
 * idempotently on every demo load so any actor can join the demo group
 * without a separate signup flow.
 *
 * The seed is submitted on behalf of the `demo-seeder` (who already has
 * `groupMember.*` permission) — only the seeder can authorize the
 * `groupMember.put` verb. The new member's actor_id is in the row.
 */
export function buildAddMemberSeed(actorId: string, groupId: string = DEMO_GROUP_ID): SeedData {
  return {
    groups: [],
    groupMembers: [
      {
        id: `gm_${actorId}`,
        actorId,
        groupId,
        permissions: ["text_document.*", "group.read", "groupMember.*", "relationship.*"],
      },
    ],
    entities: [],
  };
}
