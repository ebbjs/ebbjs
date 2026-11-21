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
 * The registry also owns the one dispatch loop: it subscribes to the replica
 * once, reads the journal once per batch, and dispatches the batch through every
 * live entry. The entry's cursor advances before its listeners run, so a
 * listener that throws cannot leave the entry behind for a later batch to jump
 * past; a throw is reported and never skips a peer. An entry whose result will
 * lag — an async run in flight — declares it by seeking back to the revision
 * its result reflects, so a later journal gap is still visible. The scan over
 * entries here is what #938 replaces with dependency indices; the entry shape —
 * read set, row, cursor, dependencies — is what those indices are built from.
 *
 * A consumer owns the meaning of its own result: a query entry publishes its
 * snapshot and depends on the rows it projected, a row entry is leased on the
 * components its row carries.
 */

import {
  carriesComponent,
  carriesLink,
  componentModel,
  systemValueString,
  type Entity,
} from "@ebbjs/core";
import type { Replica, ReplicaChange, Release, Revision } from "@ebbjs/storage/replica";

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

/** A change batch, called on every live entry the batch touches. */
export type ChangeListener = (changes: readonly ReplicaChange[], revision: Revision) => void;

/** One live subscription. Ending it releases every claim it holds. */
export interface Subscription<TResult = unknown> {
  readonly id: SubscriptionId;
  readonly kind: SubscriptionKind;
  /** The sharing key: the query key, or the row id. */
  readonly key: string;
  /** The row a row subscription reads; `null` for a query subscription. */
  readonly row: string | null;
  /** The components this subscription reads: declared plus depended on. */
  readonly reads: ReadSet;
  /**
   * The revision this entry has been dispatched through. A consumer whose
   * result still reflects an older revision (an async run in flight) seeks
   * back to it, and advances it when the run settles.
   */
  readonly cursor: Revision;
  /** The result the consumer last published; `undefined` before the first. */
  readonly result: TResult | undefined;
  /** The values this entry keeps resident. */
  readonly dependencies: readonly Dependency[];
  readonly state: SubscriptionState;
  /** Subscribers sharing this entry. It ends when the last one releases. */
  readonly refs: number;
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
  /** Every live entry, in creation order. */
  entries(): readonly Subscription<unknown>[];
  stats(): SubscriptionStats;
  /** End every entry, releasing its claims, and stop dispatching. */
  close(): void;
}

/** A change touches a read set when it names a component or a whole model read. */
export const touchesReadSet = (reads: ReadSet, change: ReplicaChange): boolean => {
  for (const component of change.components) {
    if (reads.components.has(component)) return true;
    if (reads.models.has(componentModel(component))) return true;
  }
  // A change that names no component comes from a row that carried none (a
  // tombstone or a scope eviction): only a whole-model read can observe it.
  return change.components.length === 0 && reads.models.size > 0;
};

/**
 * The id an accessor change belongs to. A link is a key of its source row, so a
 * row carrying `ebb/link` is its own subject; a membership row names the member
 * entity it files. #938 serves this from the `row` and `index:membership`
 * indices instead of reading the row per change.
 */
const accessorSubjectId = (entity: Entity): string | null => {
  if (carriesLink(entity)) return entity.id;
  if (!carriesComponent(entity, "membership")) return null;
  const id = systemValueString(entity, "membership", "entity_id");
  return id !== null && id.length > 0 ? id : null;
};

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
  cursor: Revision;
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
  let dispatcherCursor: Revision = replica.revision;
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
    // SAFETY: an entry's state is independent of the result type it carries.
    void acquire(entry as unknown as Entry<unknown>, next, entry.generation);
  };

  const handleOf = <TResult>(entry: Entry<TResult>): Subscription<TResult> => {
    /** One handle releases once: a peer's share is not this handle's to drop. */
    let released = false;
    const live = (): boolean => !released && entry.state === "live";
    return {
      id: entry.id,
      kind: entry.kind,
      key: entry.key,
      row: entry.row,
      get reads() {
        return entry.reads;
      },
      get cursor() {
        return entry.cursor;
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
      release: () => {
        if (released) return;
        released = true;
        if (entry.state !== "live") return;
        entry.refs -= 1;
        if (entry.refs <= 0) endEntry(entry);
      },
      publish: (result) => {
        if (live()) entry.result = result;
      },
      seek: (revision) => {
        if (live()) entry.cursor = revision;
      },
      depend: (dependencies) => {
        if (!released) depend(entry, dependencies);
      },
      onChange: (listener) => {
        if (!live()) return () => {};
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
        };
      },
    };
  };

  /** Whether a batch touches an entry; the scan #938 replaces with indices. */
  const touchedBy = (entry: Entry<unknown>, changes: readonly ReplicaChange[]): boolean => {
    if (entry.kind === "query")
      return changes.some((change) => touchesReadSet(entry.reads, change));
    const row = entry.row;
    if (row === null) return false;
    return changes.some((change) => {
      if (change.id === row) return true;
      const changed = replica.get(change.id);
      return changed !== undefined && accessorSubjectId(changed) === row;
    });
  };

  const dispatch = (): void => {
    const revision = replica.revision;
    if (revision === dispatcherCursor) return;
    const changes = replica.changesSince(dispatcherCursor);
    // An empty batch on an advanced revision is a journal gap (a replica
    // `load`): any subscription may have changed.
    const gap = changes.length === 0;
    dispatcherCursor = revision;
    // Snapshot the entries: a listener may end its own entry or open another.
    for (const entry of Array.from(entries.values())) {
      if (entry.state !== "live") continue;
      if (entry.kind === "row" && entry.row !== null) {
        // The row's resident components move with the change, and a row that
        // left the replica has nothing left to hold.
        depend(entry, rowDependencies(replica, entry.row));
        if (entry.state !== "live") continue;
      }
      // The batch is dispatched through this entry before anyone runs: a
      // listener that throws must not leave the entry behind for a later batch
      // to advance past the change it missed.
      entry.cursor = revision;
      if (!gap && !touchedBy(entry, changes)) continue;
      // A listener may detach a peer, so iterate a snapshot, and report a
      // failure instead of letting one consumer skip the rest.
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener(changes, revision);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[Subscriptions] change listener threw:", err);
        }
      }
    }
  };

  const detach = replica.subscribe(() => dispatch());

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
      const entry: Entry<TResult> = {
        id: (nextId += 1),
        kind: spec.kind,
        key: sharingKey(spec),
        row: spec.kind === "row" ? spec.row : null,
        mapKey,
        declaredReads: declaredReads(spec),
        listeners: new Set(),
        reads: compileReadComponents(declaredReads(spec)),
        cursor: replica.revision,
        result: undefined,
        dependencies: [],
        state: "live",
        refs: 1,
        releases: [],
        generation: 0,
        pending: 0,
      };
      const handle = handleOf(entry);
      // A registry closed before this subscription opened hands back an inert
      // handle: the caller's release path stays a no-op rather than leaking.
      if (closed) {
        entry.state = "terminal";
        return handle;
      }
      entries.set(mapKey, entry as unknown as Entry<unknown>);
      if (entry.kind === "row" && entry.row !== null) {
        depend(entry, rowDependencies(replica, entry.row));
      }
      return handle;
    },
    entries: () =>
      [...entries.values()].map((entry) => handleOf(entry)) as readonly Subscription<unknown>[],
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
      detach();
      for (const entry of Array.from(entries.values())) endEntry(entry);
    },
  };
};
