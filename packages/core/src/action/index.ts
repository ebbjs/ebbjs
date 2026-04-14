import { Action, Update, UpdateInput } from "../types/action.js";
import { HLCTimestamp } from "../types/hlc.js";
import { HLCState } from "../hlc/index.js";
import { localEvent } from "../hlc/clock.js";
import { generateId, ID_PREFIX_ACTION, ID_PREFIX_UPDATE } from "../id/index.js";

export interface CreateActionOptions {
  actorId: string;
  updates: UpdateInput[];
  clock: HLCState;
}

export function createAction(options: CreateActionOptions): {
  action: Action;
  hlc: HLCTimestamp;
} {
  const { actorId, updates, clock } = options;

  const hlc = localEvent(clock);

  const builtUpdates: Update[] = updates.map((u) => ({
    id: u.id ?? generateId(ID_PREFIX_UPDATE),
    subject_id: u.subject_id,
    subject_type: u.subject_type as Update["subject_type"],
    method: u.method as Update["method"],
    data: u.data as Update["data"],
  }));

  const action: Action = {
    id: generateId(ID_PREFIX_ACTION),
    actor_id: actorId,
    hlc,
    gsn: 0,
    updates: builtUpdates,
  };

  return { action, hlc };
}
