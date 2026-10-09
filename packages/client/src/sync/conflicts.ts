/**
 * Conflicts — the application-facing contract over the durable
 * `ConflictStore`.
 *
 * Conflict detection (#308) writes a losing Action into the store when an
 * inbound LWW write out-dates a still-pending local one. This module is
 * the read/resolve half of that seam: it caches the durable rows so the
 * conflict count is a synchronous observable for #125, and it turns the
 * application's `retry` / `discard` decision into the side effect that
 * decision implies.
 *
 * The manager is also the `ConflictStore` the Outbox writes through, so a
 * detection lands in the cache and fires `onChange` without a poll. The
 * underlying store stays the source of truth across a reload: the cache is
 * seeded from `rehydrate()` and refreshed on every mutation.
 */

import { isFieldMap, type Action, type FieldValue, type Update } from "@ebbjs/core";
import type {
  ConflictEntry,
  ConflictLoss,
  ConflictSlot,
  ConflictStore,
} from "@ebbjs/storage/types";

/** The application's decision for one conflict. */
export type ConflictResolution = "retry" | "discard";

/** Fired with the whole conflict set whenever it changes. */
export type ConflictChangeListener = (entries: readonly ConflictEntry[]) => void;

/**
 * The application-facing conflict surface, reachable as
 * `client.conflicts`.
 */
export interface Conflicts {
  /**
   * Conflicts awaiting resolution, oldest detection first. Awaits the
   * initial durable load, so a fresh client reports persisted rows.
   */
  list(): Promise<readonly ConflictEntry[]>;
  /**
   * Depth of the conflict set from the in-memory cache. Synchronous so a
   * framework binding can read it through `useSyncExternalStore`; pair it
   * with {@link onChange} to re-read when the set changes. `0` until the
   * initial load settles.
   */
  count(): number;
  /**
   * Resolve one conflict by `action.id`. Unknown ids are a no-op.
   *
   * - `retry` re-stamps the conflicting fields onto the current state —
   *   a fresh `update_id` + HLC per update, so they win — and re-enqueues
   *   the rebased Action as pending.
   * - `discard` drops the losing Action's optimistic writes and replays
   *   the action log, converging the affected entities on the server's
   *   view.
   */
  resolve(actionId: string, resolution: ConflictResolution): Promise<void>;
  /**
   * Subscribe to conflict-set changes: a detection, a resolution, or the
   * initial durable load. Returns an unsubscribe function. Listeners are
   * isolated — a throwing listener does not affect the others.
   */
  onChange(listener: ConflictChangeListener): () => void;
  /**
   * Load persisted conflicts into the in-memory cache. Runs eagerly at
   * construction as a single-flight operation (idempotent); returns that
   * same promise so callers can await it.
   */
  rehydrate(): Promise<void>;
}

/**
 * Collaborators the manager needs. Kept narrow so the manager performs no
 * I/O of its own beyond the injected store.
 */
export interface ConflictsDependencies {
  /** Durable conflict table. The manager is the only client-side writer. */
  store: ConflictStore;
  /**
   * Re-enqueue a rebased losing Action on the pending write path:
   * durable, optimistically applied, and scheduled to flush.
   */
  requeue(action: Action): Promise<void>;
  /**
   * Drop a losing Action's optimistic writes and re-materialize every
   * entity it touched from the action log.
   */
  reMaterialize(action: Action): Promise<void>;
  /**
   * Wrap rebased Updates in a fresh Action (new action id, advanced
   * clock). The Action's HLC is minted here.
   */
  stampAction(updates: readonly Update[]): Action;
  /** Fresh field HLC for a rebased Update. */
  hlc(): string;
  /** Fresh Update / FieldValue id. */
  generateUpdateId(): string;
}

/** The stamping collaborators {@link rebaseAction} needs. */
type RebaseStamper = Pick<ConflictsDependencies, "stampAction" | "hlc" | "generateUpdateId">;

/** The manager plus the store view the Outbox writes through. */
export interface ConflictManager {
  readonly conflicts: Conflicts;
  readonly store: ConflictStore;
}

/** The field map an Update carries, tolerating a fieldless `delete`. */
const readFields = (update: Update): Readonly<Record<string, FieldValue>> =>
  update.data?.fields ?? {};

/**
 * The losing Action's value at one slot. Updates apply in order, so the
 * last write found for a slot is the one that lands — the Action was
 * authored by this client, whose HLC advances with every update.
 */
const valueAtSlot = (action: Action, slot: ConflictSlot): FieldValue | undefined => {
  let found: FieldValue | undefined;
  for (const update of action.updates) {
    if (update.subject_id !== slot.subjectId) continue;
    let node: FieldValue | undefined = readFields(update)[slot.field];
    for (const key of slot.path) {
      if (node === undefined || !isFieldMap(node)) {
        node = undefined;
        break;
      }
      node = node.map[key];
    }
    if (node !== undefined) found = node;
  }
  return found;
};

/** Re-stamp every leaf under a value with one fresh `update_id` + HLC. */
const reStamp = (field: FieldValue, updateId: string, hlc: string): FieldValue => {
  if (!isFieldMap(field)) return { value: field.value, update_id: updateId, hlc };
  const map: Record<string, FieldValue> = {};
  for (const [key, child] of Object.entries(field.map)) {
    map[key] = reStamp(child, updateId, hlc);
  }
  return { map };
};

/** Wrap a value in its map-key path, innermost key last. */
const nestValue = (leaf: FieldValue, path: readonly string[]): FieldValue =>
  path.reduceRight<FieldValue>((child, key) => ({ map: { [key]: child } }), leaf);

/** Union two map trees so sibling keys lost together travel in one patch. */
const mergeTrees = (a: FieldValue, b: FieldValue): FieldValue => {
  if (!isFieldMap(a) || !isFieldMap(b)) return b;
  const map: Record<string, FieldValue> = { ...a.map };
  for (const [key, value] of Object.entries(b.map)) {
    const previous = map[key];
    map[key] = previous === undefined ? value : mergeTrees(previous, value);
  }
  return { map };
};

/**
 * Rebuild one field's losing value. A loss at the field root re-stamps
 * the whole value; otherwise each lost leaf is nested under its map
 * path and the trees are unioned.
 */
const fieldValue = (
  losses: readonly ConflictLoss[],
  action: Action,
  updateId: string,
  hlc: string,
): FieldValue | undefined => {
  const rootLoss = losses.find((loss) => loss.slot.path.length === 0);
  if (rootLoss !== undefined) {
    const value = valueAtSlot(action, rootLoss.slot);
    if (value !== undefined) return reStamp(value, updateId, hlc);
  }

  let tree: FieldValue | undefined;
  for (const loss of losses) {
    if (loss.slot.path.length === 0) continue;
    const value = valueAtSlot(action, loss.slot);
    if (value === undefined) continue;
    const nested = nestValue(reStamp(value, updateId, hlc), loss.slot.path);
    tree = tree === undefined ? nested : mergeTrees(tree, nested);
  }
  return tree;
};

/**
 * Rebuild the conflicting slots into one patch per subject. Each Update
 * carries a fresh `update_id` + HLC and only the slots that lost, so a
 * key the peer did not touch is left on its current value. The original
 * method is not preserved: re-stamping the losing values on top of the
 * current state is a patch whatever method first carried them.
 *
 * `null` when the Action carried no slot the conflict named.
 */
const rebaseAction = (entry: ConflictEntry, deps: RebaseStamper): Action | null => {
  const bySubject = new Map<
    string,
    { subjectId: string; subjectType: string; losses: ConflictLoss[] }
  >();
  for (const loss of entry.losses) {
    const update = entry.action.updates.find((u) => u.subject_id === loss.slot.subjectId);
    if (update === undefined) continue;
    const key = `${update.subject_id}\u0000${update.subject_type}`;
    const subject = bySubject.get(key) ?? {
      subjectId: update.subject_id,
      subjectType: update.subject_type,
      losses: [],
    };
    subject.losses.push(loss);
    bySubject.set(key, subject);
  }

  const updates = [...bySubject.values()].map((subject): Update => {
    const updateId = deps.generateUpdateId();
    const hlc = deps.hlc();
    const fields: Record<string, FieldValue> = {};
    const byField = new Map<string, ConflictLoss[]>();
    for (const loss of subject.losses) {
      const list = byField.get(loss.slot.field) ?? [];
      list.push(loss);
      byField.set(loss.slot.field, list);
    }
    for (const [field, losses] of byField) {
      const value = fieldValue(losses, entry.action, updateId, hlc);
      if (value !== undefined) fields[field] = value;
    }
    return {
      id: updateId,
      subject_id: subject.subjectId,
      subject_type: subject.subjectType,
      method: "patch",
      data: { fields },
    };
  });
  if (updates.length === 0) return null;
  return deps.stampAction(updates);
};

/**
 * Build the conflict manager over a durable store.
 *
 * Construction kicks off the initial load without caller involvement; a
 * rejected `list()` must not surface as an unhandled rejection, and an
 * awaiting caller still sees it.
 */
export function createConflicts(deps: ConflictsDependencies): ConflictManager {
  let entries: readonly ConflictEntry[] = [];
  let rehydration: Promise<void> | null = null;
  const listeners = new Set<ConflictChangeListener>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener(entries);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[Conflicts] onChange handler threw:", err);
      }
    }
  };

  /** Keep the cache exact and notify subscribers after each mutation. */
  const refresh = async (): Promise<void> => {
    entries = await deps.store.list();
    emit();
  };

  const rehydrate = (): Promise<void> => {
    rehydration ??= deps.store
      .list()
      .then((persisted) => {
        entries = [...persisted];
        emit();
      })
      .catch((err: unknown) => {
        // Clear the memo so a transient failure cannot brick the cache;
        // the next call retries the load.
        rehydration = null;
        throw err;
      });
    return rehydration;
  };

  /**
   * The Outbox's view. Detection `put`s and rollback `delete`s land here,
   * so the cache and listeners stay current without polling.
   */
  const store: ConflictStore = {
    async put(entry: ConflictEntry): Promise<void> {
      // Settle the initial load first: a `list()` issued at construction
      // could otherwise resolve after this refresh and overwrite the
      // cache with a snapshot taken before the put.
      await rehydrate();
      await deps.store.put(entry);
      await refresh();
    },
    async list(): Promise<readonly ConflictEntry[]> {
      await rehydrate();
      return entries;
    },
    async get(actionId: string): Promise<ConflictEntry | null> {
      await rehydrate();
      return entries.find((entry) => entry.action.id === actionId) ?? null;
    },
    async delete(actionId: string): Promise<void> {
      await rehydrate();
      await deps.store.delete(actionId);
      await refresh();
    },
    async clear(): Promise<void> {
      await rehydrate();
      await deps.store.clear();
      await refresh();
    },
  };

  const resolve = async (actionId: string, resolution: ConflictResolution): Promise<void> => {
    await rehydrate();
    const entry = entries.find((candidate) => candidate.action.id === actionId);
    if (entry === undefined) return;

    if (resolution === "retry") {
      // Enqueue before deleting: a durable-buffer failure must leave the
      // conflict resolvable rather than drop the user's write.
      const rebased = rebaseAction(entry, deps);
      if (rebased !== null) await deps.requeue(rebased);
    } else {
      await deps.reMaterialize(entry.action);
    }
    await store.delete(actionId);
  };

  void rehydrate().catch(() => {});

  const conflicts: Conflicts = {
    list: () => store.list(),
    count: () => entries.length,
    resolve,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rehydrate,
  };

  return { conflicts, store };
}
