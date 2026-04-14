import { Action, Update, UpdateInput } from "../types/action";
import { HLCTimestamp } from "../types/hlc";
import { HLCState } from "../hlc/index";
import { localEvent } from "../hlc/clock";
import { generateId, ID_PREFIX_ACTION, ID_PREFIX_UPDATE } from "../id/index";

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
