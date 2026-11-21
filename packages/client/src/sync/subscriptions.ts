/**
 * The subscription registry (#937): one table of the client's live query and
 * row subscriptions, and the only place a read's component values are claimed.
 *
 * A subscription owns the data it reads. Each entry carries its read set, its
 * own revision cursor, the result its consumer published, the leases its
 * dependencies need, and whether it is still live. Claims are refcounted by the
 * replica's lease table, so two subscriptions reading one `(row, component)`
 * share one resident value and one residency entry; releasing the last claim
 * starts the residency grace period and the value leaves when it elapses.
 *
 * Dispatch is dependency-indexed (#938): the registry hands the change
 * dispatcher what each entry reads — its components and models, or the row it
 * watches plus the membership subject that files it — and the dispatcher hands
 * back only the entries a batch touches. A batch is matched by kind (#939): a
 * content change by the component it names, a membership change by the model
 * the row entered or left, which every reader of that model observes. What an
 * entry was holding that the replica no longer has travels with the batch as
 * the unload signal, read off the residency table rather than the journal.
 *
 * One dispatcher owns the one journal cursor, reads the journal once per batch,
 * and advances to the batch revision before any listener runs, so a listener
 * that throws cannot leave an entry behind for a later batch to jump past; the
 * throw is reported and never skips a peer.
 *
 * An entry's cursor is the revision its consumer has processed. Dispatch moves
 * it for a consumer that had caught up with the previous batch and only for
 * such a one, so a consumer whose result will lag — an async run in flight —
 * keeps the revision its result reflects through later batches, and a `stale`
 * status stays visible until the run settles and seeks forward. An entry a
 * batch does not touch is never visited: one that was caught up at its last
 * dispatch reports the dispatcher's own cursor, so an idle result stays
 * `current` without a write per entry, while one that declared lag keeps
 * reporting the revision its consumer is behind.
 *
 * A consumer owns the meaning of its own result: a query entry publishes its
 * snapshot and depends on the rows it projected, a row entry is leased on the
 * components its row carries.
 */

import { componentModel, EBB_COMPONENTS, systemValueString } from "@ebbjs/core";
import type { Replica, ReplicaChange, Release, Revision } from "@ebbjs/storage/replica";

import {
  createChangeDispatcher,
  type ChangeBatch,
  type SubscriptionDependencies,
} from "./dependency-index";
import { compileReadComponents, type CompiledReadComponents } from "./query-plan";

/** Registry-local sequence number; stable for the life of one entry. */
export type SubscriptionId = number;

/** What a subscription reads: a lowered query's result, or one row. */
export type SubscriptionKind = "query" | "row";

/**
 * `live` while the entry holds its claims; `terminal` once it has ended and
 * released them. A terminal handle is inert, and so is a released one: every
 * operation after the handle's one release is a no-op.
 */
export type SubscriptionState = "live" | "terminal";

/** The components a subscription reads, split for change matching. */
export type ReadSet = CompiledReadComponents;

/**
 * One row's component values a subscription keeps resident. A row entry claims
 * the components its row carries; a query entry claims what its result used.
 */
export interface Dependency {
  readonly id: string;
  readonly components: readonly string[];
}

/** A subscription's identity: a query key (shared per query) or a row id. */
export type SubscriptionSpec =
  | {
      readonly kind: "query";
      /** The cache key two chains lowering to the same read share. */
      readonly key: string;
      /** Component names read: exact (`todo/title`) or whole-model (`todo/*`). */
      readonly reads: readonly string[];
    }
  | {
      readonly kind: "row";
      /** The row this subscription reads; also the entry's sharing key. */
      readonly row: string;
    };

/**
 * A change batch, called on every live entry the batch touches. `unloaded`
 * names the values the entry was holding that the replica dropped with it — the
 * residency loss the journal does not describe, which `unloaded` events are
 * built on (#940). It is empty when the entry lost nothing.
 */
export type ChangeListener = (
  changes: readonly ReplicaChange[],
  revision: Revision,
  unloaded: readonly string[],
) => void;

/**
 * One live entry's observable state. This is what {@link SubscriptionRegistry}
 * introspection hands out: a view, never a share, so nothing it exposes can
 * release a claim it does not own.
 */
export interface SubscriptionSnapshot<TResult = unknown> {
  readonly id: SubscriptionId;
  readonly kind: SubscriptionKind;
  /** The sharing key: the query key, or the row id. */
  readonly key: string;
  /** The row a row subscription reads; `null` for a query subscription. */
  readonly row: string | null;
  /** The components this subscription reads: declared plus depended on. */
  readonly reads: ReadSet;
  /**
   * The revision this entry's consumer has processed. Dispatch advances it for
   * a caught-up entry before its listeners run; a consumer whose result still
   * reflects an older revision (an async run in flight) seeks back to it and
   * holds it there until the run settles. An entry no batch has touched since
   * it was caught up reports the dispatcher's cursor instead of a stored one.
   */
  readonly cursor: Revision;
  /** The result the consumer last published; `undefined` before the first. */
  readonly result: TResult | undefined;
  /** The values this entry keeps resident. */
  readonly dependencies: readonly Dependency[];
  readonly state: SubscriptionState;
  /** Subscribers sharing this entry. It ends when the last one releases. */
  readonly refs: number;
}

/** One live subscription. Ending it releases every claim it holds. */
export interface Subscription<TResult = unknown> extends SubscriptionSnapshot<TResult> {
  /**
   * Drop this handle's subscriber; the last one ends the entry and releases its
   * claims. Idempotent per handle, so one subscriber releasing twice cannot end
   * an entry a peer still holds.
   */
  release(): void;
  /** Publish the result this entry currently holds. */
  publish(result: TResult): void;
  /** Advance the cursor: the entry has caught up through `revision`. */
  seek(revision: Revision): void;
  /** Hold exactly these values, releasing the ones dropped. */
  depend(dependencies: readonly Dependency[]): void;
  /** Run `listener` on every batch that touches this entry; returns a detach. */
  onChange(listener: ChangeListener): () => void;
}

/** Leak visibility: how many subscriptions are live and what they hold. */
export interface SubscriptionStats {
  readonly live: number;
  readonly byKind: Readonly<Record<SubscriptionKind, number>>;
  /** Components the live entries declared they read, held or claimed. */
  readonly dependencies: number;
  /** Claims still resolving; a non-zero count after a settle is a leak. */
  readonly pending: number;
}

export interface SubscriptionRegistry {
  /**
   * Find or create the entry for `spec`, counting one subscriber. Two calls on
   * one key share one entry, one cursor, and one lease set.
   */
  open<TResult = unknown>(spec: SubscriptionSpec): Subscription<TResult>;
  /** A non-owning snapshot of every live entry, in creation order. */
  entries(): readonly SubscriptionSnapshot<unknown>[];
  stats(): SubscriptionStats;
  /** End every entry, releasing its claims, and stop dispatching. */
  close(): void;
}

/**
 * A content change touches a read set when it names a component the set reads
 * or one of its model's whole. A membership change names no component: it
 * touches every reader of the model the row entered or left, exact or whole,
 * because a row can move the set carrying anything.
 */
export const touchesReadSet = (reads: ReadSet, change: ReplicaChange): boolean => {
  if (change.kind === "membership") {
    for (const model of change.models) {
      if (reads.models.has(model)) return true;
      for (const component of reads.components) {
        if (componentModel(component) === model) return true;
      }
    }
    return false;
  }
  for (const component of change.components) {
    if (reads.components.has(component)) return true;
    if (reads.models.has(componentModel(component))) return true;
  }
  return false;
};

/**
 * The derived index a row subscription depends on: the member entity its
 * membership row files. A link is a key of its source row, so a row carrying
 * `ebb/link` is its own subject and the row index already answers for it; a
 * membership row names a different row, which is what this index is for.
 */
const MEMBERSHIP_INDEX = "membership";

/** The values a row subscription claims: every component its row carries. */
const rowDependencies = (replica: Replica, row: string): readonly Dependency[] => {
  const components = replica.residentComponents(row);
  return components.length === 0 ? [] : [{ id: row, components }];
};

/** One dependency per row, with its components deduped. */
const mergeComponents = (dependencies: readonly Dependency[]): readonly Dependency[] => {
  const merged = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    const components = merged.get(dependency.id) ?? new Set<string>();
    for (const component of dependency.components) components.add(component);
    merged.set(dependency.id, components);
  }
  const out: Dependency[] = [];
  for (const [id, components] of merged) {
    if (components.size > 0) out.push({ id, components: [...components] });
  }
  return out;
};

const sameDependencies = (a: readonly Dependency[], b: readonly Dependency[]): boolean =>
  a.length === b.length &&
  a.every(
    (dependency, index) =>
      dependency.id === b[index].id &&
      dependency.components.length === b[index].components.length &&
      dependency.components.every((component, at) => component === b[index].components[at]),
  );

/** The entry's read set: what it declared, plus every component it claims. */
const compileReads = (
  declared: readonly string[],
  dependencies: readonly Dependency[],
): ReadSet => {
  if (dependencies.length === 0) return compileReadComponents(declared);
  const components = new Set(declared);
  for (const dependency of dependencies) {
    for (const component of dependency.components) components.add(component);
  }
  return compileReadComponents([...components]);
};

/** What the dispatcher indexes for one entry: its reads, or the row it watches. */
const indexDependencies = (entry: {
  readonly kind: SubscriptionKind;
  readonly row: string | null;
  readonly reads: ReadSet;
}): SubscriptionDependencies =>
  entry.kind === "row" && entry.row !== null
    ? { rows: [entry.row], indices: [{ index: MEMBERSHIP_INDEX, key: entry.row }] }
    : { components: [...entry.reads.components], models: [...entry.reads.models] };

/** Mutable entry state behind a read-only handle. */
interface Entry<TResult> {
  readonly id: SubscriptionId;
  readonly kind: SubscriptionKind;
  readonly key: string;
  readonly row: string | null;
  /** The entry's place in the registry map: kind plus sharing key. */
  readonly mapKey: string;
  readonly declaredReads: readonly string[];
  readonly listeners: Set<ChangeListener>;
  reads: ReadSet;
  /** The revision this entry's consumer has processed. */
  cursor: Revision;
  /**
   * The revision of the last batch dispatch handed this entry and finished
   * evaluating. Only a touched entry gets one, which is what tells an entry no
   * batch has touched since it was caught up — its cursor may derive from the
   * dispatcher — apart from one whose consumer declared lag or whose last batch
   * could not be evaluated.
   */
  dispatched: Revision;
  /**
   * Whether dispatch handed this entry a batch it could not finish. Its cursor
   * and `dispatched` both stay behind, so it must not derive its cursor from
   * the dispatcher's until a later dispatch succeeds and clears this.
   */
  stranded: boolean;
  result: TResult | undefined;
  dependencies: readonly Dependency[];
  state: SubscriptionState;
  refs: number;
  /** Claims the entry currently holds; swapped whenever dependencies change. */
  releases: readonly Release[];
  /**
   * Bumped on every dependency change and on end. An acquisition that resolves
   * behind a newer generation releases what it took instead of keeping it.
   */
  generation: number;
  /** Acquisitions in flight, so a leak is visible before it settles. */
  pending: number;
}

const registryKey = (spec: SubscriptionSpec): string =>
  `${spec.kind}\u0000${spec.kind === "query" ? spec.key : spec.row}`;

const sharingKey = (spec: SubscriptionSpec): string =>
  spec.kind === "query" ? spec.key : spec.row;

const declaredReads = (spec: SubscriptionSpec): readonly string[] =>
  spec.kind === "query" ? spec.reads : [];

/**
 * Build the registry over a live replica. Every live query and row subscription
 * goes through this one table, so this is also the one place that dispatches a
 * change batch and the one place a read's leases are acquired and released.
 */
export const createSubscriptionRegistry = (replica: Replica): SubscriptionRegistry => {
  const entries = new Map<string, Entry<unknown>>();
  let nextId = 0;
  let closed = false;

  const endEntry = <TResult>(entry: Entry<TResult>): void => {
    if (entry.state === "terminal") return;
    entry.state = "terminal";
    entry.generation += 1;
    const releases = entry.releases;
    entry.releases = [];
    entry.dependencies = [];
    entry.listeners.clear();
    entries.delete(entry.mapKey);
    dispatcher.remove(entry as unknown as Entry<unknown>);
    for (const release of releases) release();
  };

  /**
   * Take the claims for one dependency set. The set is acquired before the old
   * one is released, so a value shared by both never leaves the replica in
   * between; a set superseded while it resolves drops what it took.
   */
  const acquire = async (
    entry: Entry<unknown>,
    dependencies: readonly Dependency[],
    generation: number,
  ): Promise<void> => {
    entry.pending += 1;
    let results: PromiseSettledResult<Release>[];
    try {
      results = await Promise.allSettled(
        dependencies.map((dependency) => replica.acquire(dependency.id, dependency.components)),
      );
    } finally {
      entry.pending -= 1;
    }
    // A row that could not be claimed leaves its value to the residency grace
    // period; the rows that could be are still worth holding.
    const acquired = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (entry.generation !== generation || entry.state === "terminal") {
      for (const release of acquired) release();
      return;
    }
    const previous = entry.releases;
    entry.releases = acquired;
    for (const release of previous) release();
  };

  const depend = <TResult>(entry: Entry<TResult>, dependencies: readonly Dependency[]): void => {
    if (entry.state !== "live") return;
    const next = mergeComponents(dependencies);
    if (sameDependencies(entry.dependencies, next)) return;
    entry.dependencies = next;
    entry.reads = compileReads(entry.declaredReads, next);
    entry.generation += 1;
    // A query entry is indexed by the components it reads, so a claim that
    // added components re-indexes it in the same step. A row entry's record
    // names only its row, so a new claim cannot move it.
    if (entry.kind === "query") {
      dispatcher.add(entry as unknown as Entry<unknown>, indexDependencies(entry));
    }
    void acquire(entry as unknown as Entry<unknown>, next, entry.generation);
  };

  /** A live, read-only view of one entry: accessors, no ownership. */
  const snapshotOf = <TResult>(entry: Entry<TResult>): SubscriptionSnapshot<TResult> => ({
    id: entry.id,
    kind: entry.kind,
    key: entry.key,
    row: entry.row,
    get reads() {
      return entry.reads;
    },
    get cursor() {
      // Level with the last batch it was handed: the entry is untouched by
      // anything since, so the dispatcher's cursor is the honest one. Behind
      // it: the consumer declared the revision its result still reflects, or
      // dispatch could not finish the batch it was handed.
      return entry.stranded || entry.cursor < entry.dispatched
        ? entry.cursor
        : Math.max(entry.cursor, dispatcher.cursor());
    },
    get result() {
      return entry.result;
    },
    get dependencies() {
      return entry.dependencies;
    },
    get state() {
      return entry.state;
    },
    get refs() {
      return entry.refs;
    },
  });

  /**
   * Hand one touched entry its batch. The entry is level with the batch once its
   * own bookkeeping has succeeded, but its cursor moves only if the consumer had
   * caught up with the previous one, and that happens before any listener runs:
   * a listener that throws cannot leave a caught-up entry behind for a later
   * batch to jump past, and a batch cannot report a lagging one caught up.
   */
  const notify = (entry: Entry<unknown>, batch: ChangeBatch): void => {
    if (entry.state !== "live") return;
    // Caught up when the batch began: the consumer has processed everything the
    // entry was handed so far. A consumer that declared lag — its result still
    // reflects an older revision, an async run in flight — is not, and keeps
    // its cursor until the run settles and seeks forward.
    const caughtUp = entry.cursor >= entry.dispatched;
    let lost: readonly string[] = [];
    try {
      // What the entry held and the replica no longer has, read off the lease
      // table rather than the journal: the change that took the value away can
      // be a membership change, a tombstone, or no journal entry at all (#939).
      // Captured before the row preamble moves the claims, and inside it so a
      // lookup that throws strands the entry like any other bookkeeping.
      lost = entry.dependencies.flatMap((dependency) =>
        dependency.components.filter(
          (component) => !replica.isComponentResident(dependency.id, component),
        ),
      );
      if (entry.kind === "row" && entry.row !== null) {
        // The row's resident components move with the change, and a row that
        // left the replica has nothing left to hold.
        depend(entry as unknown as Entry<unknown>, rowDependencies(replica, entry.row));
      }
    } catch (err) {
      // Dispatch bookkeeping is as load-bearing as a listener here: one entry
      // it cannot evaluate must not starve the rest. The cursor and the
      // dispatch revision both stay behind, and the entry is marked stranded so
      // it cannot report the batch it never evaluated as processed; the next
      // gap hands it the batch again as caught up, and that clears the mark.
      // eslint-disable-next-line no-console
      console.error("[Subscriptions] subscription match threw:", err);
      entry.stranded = true;
      return;
    }
    entry.dispatched = batch.revision;
    entry.stranded = false;
    if (entry.state !== "live") return;
    if (caughtUp) entry.cursor = batch.revision;
    // A listener may detach a peer, so iterate a snapshot, and report a failure
    // instead of letting one consumer skip the rest.
    for (const listener of Array.from(entry.listeners)) {
      try {
        listener(batch.changes, batch.revision, lost);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[Subscriptions] change listener threw:", err);
      }
    }
  };

  const membershipSubjects = (change: ReplicaChange): readonly string[] => {
    // A membership row files a different row than the one it is, so the member
    // is only reachable by reading the changed row — once per change, not once
    // per subscription. A membership row arriving or leaving is a membership
    // change that names no component, so the row itself says what it files.
    if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership))
      return [];
    const changed = replica.get(change.id);
    if (changed === undefined) return [];
    const id = systemValueString(changed, MEMBERSHIP_INDEX, "entity_id");
    return id !== null && id.length > 0 ? [id] : [];
  };

  const dispatcher = createChangeDispatcher<Entry<unknown>>({
    journal: replica,
    indices: { [MEMBERSHIP_INDEX]: membershipSubjects },
    onChange: notify,
  });

  const handleOf = <TResult>(entry: Entry<TResult>): Subscription<TResult> => {
    // SAFETY: the mutators are attached below, before the handle escapes.
    const handle = snapshotOf(entry) as unknown as Subscription<TResult>;
    /** One handle releases once: a peer's share is not this handle's to drop. */
    let released = false;
    const live = (): boolean => !released && entry.state === "live";
    // `Object.assign` defines the methods beside the snapshot's accessors;
    // spreading the snapshot would freeze every accessor at its current value.
    Object.assign(handle, {
      release: () => {
        if (released) return;
        released = true;
        if (entry.state !== "live") return;
        entry.refs -= 1;
        if (entry.refs <= 0) endEntry(entry);
      },
      publish: (result: TResult) => {
        if (live()) entry.result = result;
      },
      seek: (revision: Revision) => {
        if (live()) entry.cursor = revision;
      },
      depend: (dependencies: readonly Dependency[]) => {
        if (!released) depend(entry, dependencies);
      },
      onChange: (listener: ChangeListener) => {
        if (!live()) return () => {};
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
        };
      },
    });
    return handle;
  };

  return {
    open<TResult>(spec: SubscriptionSpec): Subscription<TResult> {
      const mapKey = registryKey(spec);
      const existing = entries.get(mapKey);
      if (existing !== undefined) {
        existing.refs += 1;
        // SAFETY: the consumer that opened the entry restores the result type
        // it published under the same sharing key.
        return handleOf(existing as unknown as Entry<TResult>);
      }
      const entry: Entry<unknown> = {
        id: (nextId += 1),
        kind: spec.kind,
        key: sharingKey(spec),
        row: spec.kind === "row" ? spec.row : null,
        mapKey,
        declaredReads: declaredReads(spec),
        listeners: new Set(),
        reads: compileReadComponents(declaredReads(spec)),
        cursor: replica.revision,
        dispatched: replica.revision,
        stranded: false,
        result: undefined,
        dependencies: [],
        state: "live",
        refs: 1,
        releases: [],
        generation: 0,
        pending: 0,
      };
      // SAFETY: an entry's state is independent of the result type it carries,
      // which the consumer that opened it restores on its own handle.
      const handle = handleOf(entry) as unknown as Subscription<TResult>;
      // A registry closed before this subscription opened hands back an inert
      // handle: the caller's release path stays a no-op rather than leaking.
      if (closed) {
        entry.state = "terminal";
        return handle;
      }
      entries.set(mapKey, entry);
      dispatcher.add(entry, indexDependencies(entry));
      if (entry.kind === "row" && entry.row !== null) {
        depend(entry, rowDependencies(replica, entry.row));
      }
      return handle;
    },
    entries: () => Array.from(entries.values()).map((entry) => snapshotOf(entry)),
    stats: () => {
      let query = 0;
      let row = 0;
      let dependencies = 0;
      let pending = 0;
      for (const entry of entries.values()) {
        if (entry.kind === "query") query += 1;
        else row += 1;
        dependencies += entry.dependencies.reduce((count, dep) => count + dep.components.length, 0);
        pending += entry.pending;
      }
      return { live: query + row, byKind: { query, row }, dependencies, pending };
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of Array.from(entries.values())) endEntry(entry);
      dispatcher.close();
    },
  };
};
