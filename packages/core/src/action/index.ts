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

/** Stamp a client-authored update with its id, leaving its envelope as built. */
const stampUpdate = (update: UpdateInput): Update => {
  const id = update.id ?? generateId(ID_PREFIX_UPDATE);
  switch (update.method) {
    case "delete":
      return { id, subject_id: update.subject_id, method: "delete", data: null };
    case "drop":
      return {
        id,
        subject_id: update.subject_id,
        component: update.component,
        method: "drop",
        data: null,
      };
    default:
      return {
        id,
        subject_id: update.subject_id,
        component: update.component,
        method: update.method,
        data: update.data,
      };
  }
};

export function createAction(options: CreateActionOptions): {
  action: Action;
  hlc: HLCTimestamp;
} {
  const { actorId, updates, clock } = options;

  const hlc = localEvent(clock);

  const action: Action = {
    id: generateId(ID_PREFIX_ACTION),
    actor_id: actorId,
    hlc,
    gsn: 0,
    updates: updates.map(stampUpdate),
  };

  return { action, hlc };
}
