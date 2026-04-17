import { encodeSync } from "@ebbjs/core";
import { Action } from "@ebbjs/core";
import { createAction } from "@ebbjs/core";
import { createClock, localEvent } from "@ebbjs/core";
import { GroupSeed, GroupMemberSeed, EntitySeed, SeedData } from "./types";

export { GroupSeed, GroupMemberSeed, EntitySeed, SeedData };

export function buildSeedAction(actorId: string, data: SeedData): Action {
  const clock = createClock();
  if (data.baseHlc) {
    clock.l = BigInt(data.baseHlc);
  }

  const updates = [];

  for (const group of data.groups) {
    updates.push({
      subject_id: group.id,
      subject_type: "group",
      method: "put",
      data: {
        name: { value: group.name, update_id: "seed_update", hlc: localEvent(clock) },
      },
    });
  }

  for (const member of data.groupMembers) {
    updates.push({
      subject_id: member.id,
      subject_type: "groupMember",
      method: "put",
      data: {
        actorId: { value: member.actorId, update_id: "seed_update", hlc: localEvent(clock) },
        groupId: { value: member.groupId, update_id: "seed_update", hlc: localEvent(clock) },
        permissions: {
          value: member.permissions,
          update_id: "seed_update",
          hlc: localEvent(clock),
        },
      },
    });
  }

  for (const entity of data.entities) {
    const fields: Record<string, { value: unknown; hlc: string; updateId: string }> = {};
    for (const patch of entity.patches) {
      for (const [key, val] of Object.entries(patch.fields)) {
        fields[key] = val;
      }
    }

    updates.push({
      subject_id: entity.id,
      subject_type: entity.type,
      method: "put",
      data: fields,
    });
  }

  const { action } = createAction({ actorId, updates, clock });
  return action;
}

export async function seed(baseUrl: string, actorId: string, data: SeedData): Promise<void> {
  const action = buildSeedAction(actorId, data);
  const body = encodeSync(action);

  const res = await fetch(`${baseUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": actorId,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seed failed: ${res.status} ${text}`);
  }
}
