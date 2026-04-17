import { encodeSync } from "@ebbjs/core";
import { Action } from "@ebbjs/core";
import { createAction } from "@ebbjs/core";
import { createClock, localEvent } from "@ebbjs/core";
import { GroupSeed, GroupMemberSeed, EntitySeed, RelationshipSeed, SeedData } from "./types";

export type { GroupSeed, GroupMemberSeed, EntitySeed, RelationshipSeed, SeedData, Action };

export function buildSeedAction(actorId: string, data: SeedData): Action {
  const clock = createClock();

  const updates = [];

  for (const group of data.groups) {
    updates.push({
      subject_id: group.id,
      subject_type: "group",
      method: "put" as const,
      data: {
        name: { value: group.name, update_id: "seed_update", hlc: localEvent(clock) },
      },
    });
  }

  for (const member of data.groupMembers) {
    updates.push({
      subject_id: member.id,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        actor_id: { value: member.actorId, update_id: "seed_update", hlc: localEvent(clock) },
        group_id: { value: member.groupId, update_id: "seed_update", hlc: localEvent(clock) },
        permissions: {
          value: member.permissions,
          update_id: "seed_update",
          hlc: localEvent(clock),
        },
      },
    });
  }

  for (const entity of data.entities ?? []) {
    const fields: Record<string, { value: unknown; hlc: string; updateId: string }> = {};
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

  for (const rel of data.relationships ?? []) {
    updates.push({
      subject_id: rel.id,
      subject_type: "relationship",
      method: "put" as const,
      data: {
        source_id: { value: rel.sourceId, update_id: "seed_update", hlc: localEvent(clock) },
        target_id: { value: rel.targetId, update_id: "seed_update", hlc: localEvent(clock) },
        type: { value: rel.type, update_id: "seed_update", hlc: localEvent(clock) },
        field: { value: rel.field, update_id: "seed_update", hlc: localEvent(clock) },
      },
    });
  }

  const { action } = createAction({ actorId, updates, clock });
  return action;
}

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
      throw new Error(`Seed rejected: ${text}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Seed")) {
      throw e;
    }
    // Ignore JSON parse errors if status is ok
  }
}
