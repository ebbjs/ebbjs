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

import type { Action, FieldValue, Update } from "@ebbjs/core";
import type { ConflictEntry, ConflictStore } from "@ebbjs/storage/types";

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
 * Rebuild the conflicting fields into one patch per subject. Each Update
 * carries a fresh `update_id` + HLC and only the fields that lost, so a
 * field the peer did not touch is left on its current value. The original
 * method is not preserved: re-stamping the losing values on top of the
 * current state is a patch whatever method first carried them.
 *
 * `null` when the Action carried no field the conflict named.
 */
const rebaseAction = (entry: ConflictEntry, deps: RebaseStamper): Action | null => {
  const conflicting = new Set(entry.fields);
  const bySubject = new Map<
    string,
    { subjectId: string; subjectType: string; fields: Record<string, FieldValue> }
  >();
  for (const update of entry.action.updates) {
    const lost = Object.entries(readFields(update)).filter(([name]) => conflicting.has(name));
    if (lost.length === 0) continue;
    const key = `${update.subject_id}\u0000${update.subject_type}`;
    const subject = bySubject.get(key) ?? {
      subjectId: update.subject_id,
      subjectType: update.subject_type,
      fields: {},
    };
    for (const [name, field] of lost) subject.fields[name] = field;
    bySubject.set(key, subject);
  }

  const updates = [...bySubject.values()].map((subject): Update => {
    const updateId = deps.generateUpdateId();
    const hlc = deps.hlc();
    const fields: Record<string, FieldValue> = {};
    for (const [name, field] of Object.entries(subject.fields)) {
      fields[name] = { value: field.value, update_id: updateId, hlc };
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
