import type { Action } from "@ebbjs/core";
import { addedUpdates, mergeActionUpdates } from "../internal/action-merge";
import type { ActionLog, LoggedAction } from "../types/action-log";

/**
 * MemoryActionLog — in-memory implementation of ActionLog.
 *
 * ## State
 * - `actions` — Actions in append order; the entry at index `i` sits at
 *   log position `i + 1`, so positions are 1-based, contiguous, and stable
 *   across re-delivery of the same Action id
 * - `typeIndex` — maps entity type to set of entity IDs affected (for query optimization)
 *
 * ## Materialization Flow
 * 1. Action received via `append()`
 * 2. Entities mentioned in action are marked dirty by caller (DirtyTracker)
 * 3. EntityStore.materialize() replays actions for dirty entities
 *
 * ## Internal Helpers
 * - `updateTypeIndex()` — merges action's entity IDs into the type index, deduplicating
 */
interface ActionLogState {
  actions: readonly Action[];
  typeIndex: readonly (readonly [type: string, entityIds: readonly string[]])[];
}

const updateTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  action: Action,
): (readonly [string, readonly string[]])[] => {
  const map = new Map<string, Set<string>>();
  for (const [type, entityIds] of typeIndex) {
    map.set(type, new Set(entityIds));
  }
  for (const update of action.updates) {
    const existing = map.get(update.subject_type);
    if (existing) {
      existing.add(update.subject_id);
    } else {
      map.set(update.subject_type, new Set([update.subject_id]));
    }
  }
  return Array.from(map.entries()).map(([type, ids]) => [type, Array.from(ids)] as const);
};

export const createMemoryActionLog = (): ActionLog => {
  let state: ActionLogState = {
    actions: [],
    typeIndex: [],
  };

  const append = async (action: Action): Promise<LoggedAction> => {
    const index = state.actions.findIndex((stored) => stored.id === action.id);
    const existing = index === -1 ? undefined : state.actions[index];

    // One Action can arrive once per group it touches (#473); merge them
    // under the position the id first claimed.
    const stored =
      existing === undefined
        ? action
        : { ...existing, updates: mergeActionUpdates(existing.updates, action.updates) };

    const created = existing === undefined;
    const position = created ? state.actions.length + 1 : index + 1;
    const added = addedUpdates(existing?.updates ?? [], action.updates);

    state = {
      actions: created
        ? [...state.actions, stored]
        : state.actions.map((candidate) => (candidate.id === action.id ? stored : candidate)),
      typeIndex: updateTypeIndex(state.typeIndex, stored),
    };

    return { action: stored, position, added };
  };

  return {
    append,

    async appendMany(actions: readonly Action[]): Promise<readonly LoggedAction[]> {
      const entries: LoggedAction[] = [];
      for (const action of actions) entries.push(await append(action));
      return entries;
    },

    async readTail(afterPosition: number): Promise<readonly LoggedAction[]> {
      return state.actions.slice(afterPosition).map((action, offset) => ({
        action,
        position: afterPosition + offset + 1,
        added: action.updates,
      }));
    },

    async lastPosition(): Promise<number> {
      return state.actions.length;
    },

    async getAll(): Promise<readonly Action[]> {
      return state.actions;
    },

    async getForEntity(entityId: string): Promise<readonly Action[]> {
      const found = state.actions.filter((action) =>
        action.updates.some((update) => update.subject_id === entityId),
      );
      return found.sort((a, b) => a.gsn - b.gsn);
    },

    async clear(): Promise<void> {
      state = { actions: [], typeIndex: [] };
    },
  };
};
