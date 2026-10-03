/**
 * Seed helpers — bootstrap the demo group + member + document on first load.
 *
 * The full `@ebbjs/server` package pulls in Node-only deps
 * (`child_process`, `fs`) for the server harness, so we can't import
 * it directly from the browser. We deep-import `seed-client.js` from
 * the built dist instead — it's pure-fetch + msgpack and runs fine in
 * the browser.
 *
 * The shape mirrors what `seed-client.buildSingleEntitySeed` produces.
 */

import { createAction, createClock, encodeSync, localEvent } from "@ebbjs/core";

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

/** A permissive shape for seed data — matches `SeedData` in @ebbjs/server. */
export interface SeedData {
  groups: ReadonlyArray<{ id: string; name: string }>;
  groupMembers: ReadonlyArray<{
    id: string;
    actorId: string;
    groupId: string;
    permissions: readonly string[];
  }>;
  entities?: ReadonlyArray<{
    id: string;
    type: string;
    patches: ReadonlyArray<{
      fields: Record<string, { value: unknown; update_id: string; hlc: string }>;
    }>;
  }>;
  relationships?: ReadonlyArray<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    field: string;
  }>;
  entityGroups?: ReadonlyArray<{
    id: string;
    entityId: string;
    groupId: string;
  }>;
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
 * Build a single ebb-native Action that creates the group, member, doc,
 * and relationship. Mirrors `seed-client.buildSeedAction`.
 */
function buildSeedAction(actorId: string, data: SeedData) {
  const clock = createClock();
  const updates = [];

  for (const group of data.groups) {
    updates.push({
      subject_id: group.id,
      subject_type: "group",
      method: "put" as const,
      data: {
        fields: {
          name: { value: group.name, update_id: "seed_update", hlc: localEvent(clock) },
        },
      },
    });
  }

  for (const member of data.groupMembers) {
    updates.push({
      subject_id: member.id,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        fields: {
          actor_id: { value: member.actorId, update_id: "seed_update", hlc: localEvent(clock) },
          group_id: { value: member.groupId, update_id: "seed_update", hlc: localEvent(clock) },
          permissions: {
            value: member.permissions,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
        },
      },
    });
  }

  for (const entity of data.entities ?? []) {
    const fields: Record<string, { value: unknown; hlc: string; update_id: string }> = {};
    for (const patch of entity.patches) {
      for (const [key, val] of Object.entries(patch.fields)) {
        fields[key] = val;
      }
    }
    updates.push({
      subject_id: entity.id,
      subject_type: entity.type,
      method: "put" as const,
      data: { fields },
    });
  }

  for (const membership of data.entityGroups ?? []) {
    updates.push({
      subject_id: membership.id,
      subject_type: "entityGroup",
      method: "put" as const,
      data: {
        fields: {
          entity_id: {
            value: membership.entityId,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
          group_id: {
            value: membership.groupId,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
        },
      },
    });
  }

  const { action } = createAction({ actorId, updates, clock });
  return action;
}

/**
 * Build an action that adds `actorId` as a member of `groupId`. Run
 * idempotently on every demo load so any actor can join the demo group
 * without a separate signup flow.
 *
 * The action's actor_id is the demo-seeder (who already has
 * `groupMember.*` permission) — only the seeder can authorize the
 * `groupMember.put` verb. The new member's actor_id is in the payload.
 */
export function buildAddMemberAction(
  actorId: string,
  groupId: string = DEMO_GROUP_ID,
): ReturnType<typeof createAction>["action"] {
  const clock = createClock();
  const memberId = `gm_${actorId}`;
  const update = {
    subject_id: memberId,
    subject_type: "groupMember",
    method: "put" as const,
    data: {
      fields: {
        actor_id: { value: actorId, update_id: "add_member", hlc: localEvent(clock) },
        group_id: { value: groupId, update_id: "add_member", hlc: localEvent(clock) },
        permissions: {
          value: ["text_document.*", "group.read", "groupMember.*", "relationship.*"],
          update_id: "add_member",
          hlc: localEvent(clock),
        },
      },
    },
  };
  // Action is attributed to the seeder (the actor making the request),
  // not the actor being added — otherwise the server rejects the put.
  const { action } = createAction({ actorId: "demo-seeder", updates: [update], clock });
  return action;
}

/**
 * POST an "add member" action. Idempotent — re-running for an
 * already-member actor is fine (the server will accept the redundant
 * put for the same groupMember entity). Sent on behalf of
 * `demo-seeder`, who already has `groupMember.*` permission.
 */
export async function addMember(baseUrl: string, actorId: string, groupId?: string): Promise<void> {
  const action = buildAddMemberAction(actorId, groupId);
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${baseUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": "demo-seeder",
    },
    body: body as BodyInit,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`addMember failed: ${res.status} ${text}`);
  }
  // Tolerate already-existing member rejections.
  try {
    const json = JSON.parse(text);
    if (json.rejected && json.rejected.length > 0) {
      const onlyConflicts = json.rejected.every(
        (r: { reason?: string }) =>
          r.reason === "already_exists" || r.reason === "duplicate_action",
      );
      if (!onlyConflicts) {
        // eslint-disable-next-line no-console
        console.warn("[addMember] rejected:", json.rejected);
      }
    }
  } catch {
    // ignore non-JSON
  }
}

/**
 * POST the seed Action to the server. Idempotent — re-running on an
 * already-seeded group is safe; the server will dedup by action id (the
 * HLC differs but the action body is the same... actually no, the HLC
 * advances, so the action id changes). The server will write duplicates
 * for the same group/entity. We treat that as acceptable for a demo —
 * repeated seeds don't corrupt state.
 *
 * If the seed fails because the entity already exists, that's fine —
 * we'll proceed assuming the bootstrap worked.
 */
export async function seed(baseUrl: string, actorId: string, data: SeedData): Promise<void> {
  const action = buildSeedAction(actorId, data);
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${baseUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": actorId,
    },
    body: body as BodyInit,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Seed failed: ${res.status} ${text}`);
  }
  try {
    const json = JSON.parse(text);
    if (json.rejected && json.rejected.length > 0) {
      // Already-seeded group/entity causes rejections. Tolerate.
      const onlyConflicts = json.rejected.every(
        (r: { reason?: string }) =>
          r.reason === "already_exists" || r.reason === "duplicate_action",
      );
      if (!onlyConflicts) {
        throw new Error(`Seed rejected: ${text}`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Seed")) {
      throw e;
    }
    // Ignore JSON parse errors if status is ok
  }
}
