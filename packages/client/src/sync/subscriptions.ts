/**
 * The subscription registry (#937): one table of the client's query and row
 * subscriptions, and the only place a read's component values are claimed.
 *
 * A subscription owns the data it reads. Each entry carries its read set, its
 * own subscription revision, the result its consumer published, the leases its
 * dependencies need, and whether it is still live. Claims are refcounted by the
 * replica's lease table, so two subscriptions reading one `(row, component)`
 * share one resident value and one residency entry.
 *
 * A released query result does not end (#941). It goes inactive and keeps its
 * result, its revision, and the claims it owns for one residency TTL — the same
 * lifetime a released component value gets — so a remount inside it re-reads
 * neither the store nor the source. When the TTL elapses the result and its
 * claims end together; a row entry, which holds a row for a mounted reader
 * rather than a reusable result, ends on its last release.
 *
 * Dispatch is dependency-indexed (#938): the registry hands the change
 * dispatcher what each entry reads — its components and models, or the row it
 * watches plus the membership subject that files it — together with every
 * derived-index key it declared or its consumer supplied through `depend`
 * (#1007), merged and deduped into one key set per entry. The dispatcher hands
 * back only the entries a batch touches. A batch is matched by kind (#939): a
 * content change by the component it names, a membership change by the model
 * the row entered or left, which every reader of that model observes. What an
 * entry was holding that the replica no longer has travels with the batch as
 * the unload signal, read off the residency table rather than the journal.
 *
 * One dispatcher owns the one journal position, reads the journal once per
 * batch, and advances to the batch revision before any listener runs, so a
 * listener that throws cannot leave an entry behind for a later batch to jump
 * past; the throw is reported and never skips a peer.
 *
 * An entry's revision is the revision its consumer has processed. Dispatch
 * moves it for a consumer that had caught up with the previous batch and only
 * for such a one, and only when the consumer did not set it itself — by seeking
 * or by holding — so a consumer whose result will lag (an async run in flight,
 * or an inactive result a relevant change left behind) keeps the revision its
 * result reflects, and a `stale` status stays visible until a run settles and
 * seeks forward. An entry a batch does not touch is never visited: one that was
 * caught up at its last dispatch reports the dispatcher's own revision, so an
 * idle result stays `current` without a write per entry.
 *
 * A consumer owns the meaning of its own result: a query entry publishes its
 * snapshot and depends on the rows it projected, a row entry is leased on the
 * components its read selected — or on every component its row carries when it
 * selected nothing. The consumer's private run state rides on the entry too,
 * so there is no second table beside the registry.
 *
 * A dev-only watchdog reports the one leak this model cannot heal by itself
 * (#944): a subscription nothing ever releases. Residency has no cap and no
 * eviction by size, so a mounted reader whose cleanup never runs holds its
 * values for the session; the registry says so, in development only, rather
 * than pinning a body in silence.
 */

import { componentModel } from "@ebbjs/core";
import {
  residencyTtlOf,
  unrefTimer,
  type LeaseTimerHandle,
  type Replica,
  type ReplicaChange,
  type Release,
  type Revision,
} from "@ebbjs/storage/replica";

import {
  createChangeDispatcher,
  knownIndexErrorFor,
  UnknownIndexError,
  type ChangeBatch,
  type DispatchCounts,
  type IndexDependency,
  type SubscriptionDependencies,
} from "./dependency-index";
import { MEMBERSHIP_INDEX, createIndexResolvers } from "./index-resolvers";
import { compileReadComponents, type CompiledReadComponents } from "./query-plan";
import type { PatchShape } from "./query-execute";

/** Registry-local sequence number; stable for the life of one entry. */
export type SubscriptionId = number;

/** What a subscription reads: a lowered query's result, or one row. */
export type SubscriptionKind = "query" | "row";

/**
 * `live` while a subscriber holds the entry; `inactive` while a released query
 * result still owns its claims and waits out the residency TTL; `terminal`
 * once it has ended and released everything. A row entry never goes inactive:
 * it holds a row for a mounted reader, not a result to reuse. A terminal
 * handle is inert.
 */
export type SubscriptionState = "live" | "inactive" | "terminal";

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

/**
 * A subscription's identity: a query key (shared per query) or a row id plus
 * the components its read selected (shared per row selection).
 */
export type SubscriptionSpec =
  | {
      readonly kind: "query";
      /** The result key two chains lowering to the same read share. */
      readonly key: string;
      /** Component names read: exact (`todo/title`) or whole-model (`todo/*`). */
      readonly reads: readonly string[];
      /**
       * Models whose row set the read observes. A create or delete names no
       * component, so this is what carries a membership dependency.
       */
      readonly sources?: readonly string[];
      /**
       * Derived-index reads the query declared (#961): a relation target, a
       * component's existence, a group scope. Dispatch matches these instead
       * of the component names in {@link SubscriptionSpec.covered}.
       */
      readonly indices?: readonly IndexDependency[];
      /**
       * Components the declared indices replace as the dispatcher's match key.
       * The read set keeps them for claims and re-checks; dispatch leaves them
       * to a resolver, which falls back to the read set's breadth.
       */
      readonly covered?: readonly string[];
    }
  | {
      readonly kind: "row";
      /**
       * The row this subscription reads. Two selections of one row are two
       * entries, so the row plus its selection is what they share by.
       */
      readonly row: string;
      /**
       * The components the row read selected. Absent claims every resident
       * component, which is what an unrestricted row read observes.
       */
      readonly components?: readonly string[];
    };

/**
 * A change batch, called on every entry the batch touches. `unloaded` names the
 * values the entry was holding that the replica dropped with it — the residency
 * loss the journal does not describe, which `unloaded` events are built on
 * (#940). It is empty when the entry lost nothing.
 *
 * `writer` mutates the entry the listener belongs to, whether or not the
 * listener's own handle still holds a subscriber: an inactive result is still
 * dispatched so it can mark itself stale, and it must publish that without a
 * share. The writer never releases.
 */
export type ChangeListener<TResult = unknown> = (
  changes: readonly ReplicaChange[],
  revision: Revision,
  unloaded: readonly string[],
  writer: SubscriptionWriter<TResult>,
) => void;

/** What a listener may do to its entry. Everything a handle can do but release. */
export interface SubscriptionWriter<TResult = unknown> {
  /** The result the entry currently holds; `undefined` before the first. */
  readonly result: TResult | undefined;
  /**
   * The revision this entry's published result reflects — the position its
   * consumer has processed. Dispatch hands the entry the batch's revision, so
   * a consumer that keeps the result it already published reads this to see
   * the revision that result truly reflects, not the one dispatch moved to.
   */
  readonly reflected: Revision;
  /**
   * The values this entry currently claims, one per row it touches: a source
   * row or a joined target, which need not be a row of the result.
   */
  readonly dependencies: readonly Dependency[];
  /** Publish the result this entry currently holds. */
  publish(result: TResult): void;
  /** Set the revision the entry's consumer has processed through. */
  seek(revision: Revision): void;
  /**
   * Keep the revision where it is: the result still reflects the one the entry
   * holds, so dispatch must not advance it to the batch's on the consumer's
   * behalf. A run that settles later seeks forward to the revision it produced.
   */
  hold(): void;
  /**
   * Hold exactly these values, releasing the ones dropped, and declare the
   * derived-index keys the consumer derived for itself (#1007) — the
   * membership rows a result holds, for a read whose keys come from its result
   * rather than its query.
   *
   * `indices` absent means "no opinion": the keys already supplied stay in
   * force, which is what a caller holding only a claim set — the patch path
   * calling `depend(claims)` — relies on. `[]` withdraws them. Supplied keys
   * are merged with the entry's declared ones and deduped by `(index, key)`;
   * the dispatcher is handed the merged set, so adding or removing a key costs
   * this entry's own re-index and nothing else.
   */
  depend(dependencies: readonly Dependency[], indices?: readonly IndexDependency[]): void;
}

/**
 * One entry's observable state. This is what {@link SubscriptionRegistry}
 * introspection hands out: a view, never a share, so nothing it exposes can
 * release a claim it does not own.
 */
export interface SubscriptionSnapshot<TResult = unknown, TConsumer = unknown> {
  readonly id: SubscriptionId;
  readonly kind: SubscriptionKind;
  /**
   * The sharing key: the query key, or the row id. Two row entries for one row
   * select different components, so the row id alone does not identify one.
   */
  readonly key: string;
  /** The row a row subscription reads; `null` for a query subscription. */
  readonly row: string | null;
  /** The components this subscription reads: declared plus depended on. */
  readonly reads: ReadSet;
  /**
   * The subscription revision: the revision this entry's consumer has
   * processed. Dispatch advances it for an entry that was caught up, but a
   * consumer whose result still reflects an older revision (an async run in
   * flight, a stale inactive result) holds it there until the run settles. An
   * entry no batch has touched since it was caught up reports the dispatcher's
   * revision instead of a stored one; {@link SubscriptionWriter.reflected} is
   * always the revision its result reflects.
   */
  readonly revision: Revision;
  /** The result the consumer last published; `undefined` before the first. */
  readonly result: TResult | undefined;
  /**
   * The consumer's own state for this entry. The registry stores the reference
   * it was opened with and never reads it, so a consumer's run bookkeeping
   * lives on the one entry rather than in a second table beside it.
   */
  readonly consumer: TConsumer;
  /** The values this entry keeps resident. */
  readonly dependencies: readonly Dependency[];
  readonly state: SubscriptionState;
  /**
   * Subscribers sharing this entry. A query entry at zero is inactive: it keeps
   * its result and claims until the residency TTL, then ends. A row entry at
   * zero ends immediately.
   */
  readonly refs: number;
}

/**
 * One entry's handle: a share of the entry, plus the writer its owner uses while
 * the entry exists. Releasing the last share makes a query entry inactive; the
 * entry, not the handle, owns the claims and releases them when it ends.
 */
export interface Subscription<TResult = unknown, TConsumer = unknown>
  extends SubscriptionSnapshot<TResult, TConsumer>, SubscriptionWriter<TResult> {
  /**
   * Drop this handle's subscriber; the last one makes a query entry inactive
   * (or ends a row entry) and a timed query entry releases its claims when its
   * TTL elapses. Idempotent per handle, so one subscriber releasing twice
   * cannot end an entry a peer still holds.
   */
  release(): void;
  /** Run `listener` on every batch that touches this entry; returns a detach. */
  onChange(listener: ChangeListener<TResult>): () => void;
}

/** Leak visibility: how many subscriptions are live and what they hold. */
export interface SubscriptionStats {
  readonly live: number;
  /**
   * Released query results still owning their claims. Counted apart from
   * `live` because nothing is subscribed, but their claims are not a leak
   * until the residency TTL has elapsed.
   */
  readonly inactive: number;
  readonly byKind: Readonly<Record<SubscriptionKind, number>>;
  /** Components the entries declared they read, held or claimed. */
  readonly dependencies: number;
  /** Claims still resolving; a non-zero count after a settle is a leak. */
  readonly pending: number;
  /** What the last dispatched batch cost the dependency indices. */
  readonly dispatch: DispatchCounts;
}

/**
 * The dev-only lease watchdog (#944).
 *
 * A refcounted, uncapped residency model has no pressure valve, so the leak it
 * cannot heal itself is a subscription that is never released: a mounted reader
 * whose cleanup never ran holds its values for the life of the client. Two
 * reports cover it — a live entry whose claim set has not moved for
 * {@link LeaseWatchdogOptions.staleAfterMs}, and a `close()` that leaves live
 * readers behind.
 *
 * Anti-spam rule: one warning per quiet period. The period runs from the last
 * claim-set change, and an entry already reported for its current claim set is
 * never reported again for it. A claim-set change proves the reader is working,
 * so it starts a new period; nothing re-reports an unchanged set.
 */
export interface LeaseWatchdogOptions {
  /**
   * Whether the watchdog runs. Defaults to on outside a production build —
   * `process.env.NODE_ENV === "production"` makes it inert — so a shipped app
   * pays neither the timer nor the messages and a development one is told. A
   * bundle that carries no `process` at all counts as production: a diagnostic
   * must never assume development from an absent flag.
   */
  readonly enabled?: boolean;
  /** How long a claim set must sit unchanged before it is reported. Default 5m. */
  readonly staleAfterMs?: number;
  /** How often the registry looks for one. Default 1m, so a report is prompt. */
  readonly intervalMs?: number;
  /** Milliseconds clock for the quiet period; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Where a report goes; defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

export interface SubscriptionRegistryOptions {
  /**
   * How long a released query result stays warm: its result, its revision, and
   * the claims it owns. Defaults to the storage package's
   * `DEFAULT_RESIDENCY_TTL_MS` (60s), the same one lifetime a released
   * component value gets, so one answer covers both. A non-positive or
   * non-finite value disables expiry, so an inactive result keeps its result
   * and its claims until a remount of the same read or `close()`.
   */
  readonly residencyTtlMs?: number;
  /** The dev-only leak watchdog; `false` turns it off outright. */
  readonly watchdog?: LeaseWatchdogOptions | false;
}

export interface SubscriptionRegistry {
  /**
   * Find or create the entry for `spec`, counting one subscriber. Two calls on
   * one key share one entry, one revision, and one lease set. An inactive entry
   * is taken back as it stands — same result, same claims, same consumer state
   * — and `consumer` is only stored when this call creates the entry.
   */
  open<TResult = unknown>(spec: SubscriptionSpec): Subscription<TResult, undefined>;
  open<TResult = unknown, TConsumer = unknown>(
    spec: SubscriptionSpec,
    consumer: TConsumer,
  ): Subscription<TResult, TConsumer>;
  /**
   * The entry for `kind` and `key` as it stands, counting no subscriber: what a
   * consumer reads before subscribing, and how a remount finds the result it
   * left inactive. Absent once the entry has ended.
   *
   * `key` is the entry's map key: a query key names one entry, while a row's
   * identity also covers the components its read selected, so a row id names
   * only the whole-row entry. Only query entries are looked up this way.
   */
  peek<TResult = unknown, TConsumer = unknown>(
    kind: SubscriptionKind,
    key: string,
  ): SubscriptionSnapshot<TResult, TConsumer> | undefined;
  /** A non-owning snapshot of every entry, live or inactive, in creation order. */
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
      if (reads.sources.has(model)) return true;
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
 * The rows a batch lets a result patch in place (#942), or `null` when any
 * change it makes to `reads` must re-run the query.
 *
 * A patch rewrites a row's projection where the row already sits, so it is the
 * same result as a re-run only when the change cannot move it: a content change
 * (not a tombstone) to a component the result projects, naming no predicate,
 * order key, join target, or structural key. A membership change re-runs,
 * because a row entering, leaving, or refiling can change the set the result is
 * drawn from. A change the entry does not read is not its concern and does not
 * block a patch.
 */
export const patchableRows = (
  reads: ReadSet,
  shape: PatchShape,
  changes: readonly ReplicaChange[],
): readonly string[] | null => {
  if (!shape.allowed) return null;
  const ids = new Set<string>();
  for (const change of changes) {
    if (!touchesReadSet(reads, change)) continue;
    if (change.kind !== "content" || change.deleted) return null;
    let patchable = false;
    for (const component of change.components) {
      const model = componentModel(component);
      if (shape.keys.components.has(component) || shape.keys.models.has(model)) return null;
      if (!shape.projected.components.has(component) && !shape.projected.models.has(model)) {
        return null;
      }
      patchable = true;
    }
    if (patchable) ids.add(change.id);
  }
  return [...ids];
};

/**
 * The values a row subscription claims: the components its read selected that
 * the replica holds, or every component the row carries when it selected
 * nothing. A selected component that never arrived was never leased, so
 * claiming it would invent a release the entry never held; deriving the claim
 * set from residency is what keeps a release reportable exactly once.
 */
const rowDependencies = (
  replica: Replica,
  row: string,
  selected?: readonly string[],
): readonly Dependency[] => {
  const resident = replica.residentComponents(row);
  const components =
    selected === undefined
      ? resident
      : resident.filter((component) => selected.includes(component));
  const unique = [...new Set(components)];
  return unique.length === 0 ? [] : [{ id: row, components: unique }];
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
  sources: readonly string[],
): ReadSet => {
  if (dependencies.length === 0) return compileReadComponents(declared, sources);
  const components = new Set(declared);
  for (const dependency of dependencies) {
    for (const component of dependency.components) components.add(component);
  }
  return compileReadComponents([...components], sources);
};

/** One key's identity under an index; the NUL cannot occur in a name or an id. */
const indexIdentity = (dependency: IndexDependency): string =>
  `${dependency.index}\u0000${dependency.key}`;

/**
 * The derived-index keys a list of declarations names, deduped by
 * `(index, key)` in first-seen order. First-seen order gives the dispatcher one
 * stable registration order; a key named twice is one key, so a consumer may
 * hand over a list it built without deduping.
 */
const mergeIndices = (
  ...sets: readonly (readonly IndexDependency[])[]
): readonly IndexDependency[] => {
  const seen = new Set<string>();
  const merged: IndexDependency[] = [];
  for (const set of sets) {
    for (const dependency of set) {
      const identity = indexIdentity(dependency);
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(dependency);
    }
  }
  return merged;
};

/**
 * Whether two key sets are the same, in any order: a consumer derives its keys
 * from a result whose row order may change without the set of keys changing,
 * and a reorder must not cost a re-index on the path that runs after every run.
 * Both sides are deduped, so equal length plus one containment is equality.
 */
const sameIndices = (a: readonly IndexDependency[], b: readonly IndexDependency[]): boolean => {
  if (a.length !== b.length) return false;
  const seen = new Set(a.map(indexIdentity));
  return b.every((dependency) => seen.has(indexIdentity(dependency)));
};

/**
 * What the dispatcher indexes for one entry: its reads, or the row it watches,
 * plus every derived-index key it declared — the query's own, the membership
 * row a row entry is filed by, and the keys its consumer supplied, merged and
 * deduped (#1007).
 */
const indexDependencies = (entry: {
  readonly kind: SubscriptionKind;
  readonly row: string | null;
  readonly reads: ReadSet;
  readonly declaredIndices: readonly IndexDependency[];
  readonly suppliedIndices: readonly IndexDependency[];
  readonly covered: readonly string[];
}): SubscriptionDependencies => {
  if (entry.kind === "row" && entry.row !== null) {
    return {
      rows: [entry.row],
      indices: mergeIndices([{ index: MEMBERSHIP_INDEX, key: entry.row }], entry.suppliedIndices),
    };
  }
  // A component an index read subsumes stays in the read set (it is leased and
  // re-checked there) but not in the dispatch set: the resolver is the
  // narrower key, and answers `null` when it cannot narrow, which touches every
  // entry that declared the index — the component set's breadth, never less.
  const covered = new Set(entry.covered);
  // A covered whole-model dependency also covers the exact components claims
  // add later: a joined target row's resident values are claimed as
  // `user/name`, and leaving that in the dispatch set would undo the join
  // narrowing the index was introduced for.
  const isCovered = (component: string): boolean =>
    covered.has(component) || covered.has(`${componentModel(component)}/*`);
  return {
    components: [...entry.reads.components].filter((component) => !isCovered(component)),
    models: [...entry.reads.models].filter((model) => !covered.has(`${model}/*`)),
    sources: [...entry.reads.sources],
    indices: mergeIndices(entry.declaredIndices, entry.suppliedIndices),
  };
};

/** Mutable entry state behind a read-only handle. */
interface Entry<TResult, TConsumer = unknown> {
  readonly id: SubscriptionId;
  readonly kind: SubscriptionKind;
  readonly key: string;
  readonly row: string | null;
  /** The entry's place in the registry map: kind plus sharing key. */
  readonly mapKey: string;
  readonly declaredReads: readonly string[];
  /** Models whose row set a query read observes; empty for a row read. */
  readonly declaredSources: readonly string[];
  /** Derived-index reads the query declared; empty for a row read. */
  readonly declaredIndices: readonly IndexDependency[];
  /**
   * Derived-index keys the consumer derived from its current result (#1007).
   * Merged with the declared ones for dispatch, and replaced wholesale on
   * every `depend` that states them; `[]` means the consumer has none.
   */
  suppliedIndices: readonly IndexDependency[];
  /** Components the declared indices replace as the dispatcher's match key. */
  readonly covered: readonly string[];
  /** The components a row read selected; absent claims every resident one. */
  readonly rowComponents: readonly string[] | undefined;
  /** The consumer state the entry was opened with; never interpreted here. */
  readonly consumer: TConsumer;
  readonly listeners: Set<ChangeListener<TResult>>;
  reads: ReadSet;
  /** The revision this entry's consumer has processed: its result reflects it. */
  revision: Revision;
  /**
   * Whether the listener in flight set the revision itself, by seeking or by
   * holding. An entry that neither did is caught up with the batch dispatch
   * handed it, so its revision moves with the batch after the listener runs.
   */
  declared: boolean;
  /**
   * The revision of the last batch dispatch handed this entry and finished
   * evaluating. Only a touched entry gets one, which is what tells an entry no
   * batch has touched since it was caught up — its revision may derive from the
   * dispatcher — apart from one whose consumer declared lag or whose last batch
   * could not be evaluated.
   */
  dispatched: Revision;
  /**
   * Whether dispatch handed this entry a batch it could not finish. Its
   * revision and `dispatched` both stay behind, so it must not derive its
   * revision from the dispatcher's until a later dispatch succeeds and clears
   * this.
   */
  stranded: boolean;
  result: TResult | undefined;
  dependencies: readonly Dependency[];
  state: SubscriptionState;
  refs: number;
  /**
   * The timer that ends an inactive result. Armed only while `inactive`, so a
   * live or reopened entry holds no second timer; `null` when retention is
   * disabled or the entry is not inactive.
   */
  retentionTimer: LeaseTimerHandle | null;
  /**
   * Guards the retention callback the same way the lease table guards expiry:
   * a timer dispatched for one inactive period cannot end an entry that has
   * been reopened since.
   */
  retentionGeneration: number;
  /** Claims the entry currently holds; swapped whenever dependencies change. */
  releases: readonly Release[];
  /**
   * Bumped on every dependency change and on end. An acquisition that resolves
   * behind a newer generation releases what it took instead of keeping it.
   */
  generation: number;
  /** Acquisitions in flight, so a leak is visible before it settles. */
  pending: number;
  /**
   * When its claim set last moved, on the watchdog's clock; the quiet period
   * runs from here, so it starts at open and restarts on every change.
   */
  claimsSince: number;
  /** The quiet period already reported, so one claim set warns once. */
  warnedAt: number | null;
}

/**
 * The selection's share of a row entry's key. Two reads of one row that select
 * different components claim different values, so they must not share an entry:
 * one lease set, one release report, per selection. Sorted, so the same
 * selection shares whichever order it was declared in; absent (a whole-row
 * read) is a key of its own.
 */
const rowSelectionKey = (components: readonly string[] | undefined): string =>
  components === undefined ? "" : `\u0000[${[...components].sort().join(",")}]`;

const mapKeyOf = (kind: SubscriptionKind, key: string): string => `${kind}\u0000${key}`;

const registryKey = (spec: SubscriptionSpec): string =>
  mapKeyOf(
    spec.kind,
    spec.kind === "query" ? spec.key : `${spec.row}${rowSelectionKey(spec.components)}`,
  );

const sharingKey = (spec: SubscriptionSpec): string =>
  spec.kind === "query" ? spec.key : spec.row;

const declaredReads = (spec: SubscriptionSpec): readonly string[] =>
  spec.kind === "query" ? spec.reads : [];

const declaredSources = (spec: SubscriptionSpec): readonly string[] =>
  spec.kind === "query" ? (spec.sources ?? []) : [];

/** How long a claim set must sit unchanged before the watchdog reports it. */
const DEFAULT_WATCHDOG_STALE_MS = 5 * 60_000;

/** How often the watchdog looks, so a report lands within a minute of the horizon. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * A dev-only diagnostic must not run in a production build, and the gate has to
 * be provably inert there. A bundler folds the whole expression when it defines
 * `process.env.NODE_ENV`, so this shape — absent `process` first, the flag
 * second — folds to `false` outright and leaves no `typeof process` behind. The
 * order is what makes the un-folded form safe too: a browser bundle carries no
 * `process` at all, so it reads as production rather than as "no flag, so
 * development".
 *
 * `env` is optional because a probe that exists is not a probe that is whole:
 * some bundlers and test harnesses define a bare `process = {}`, and reading
 * `env.NODE_ENV` off it would throw a `TypeError` while the client is being
 * constructed. With the chain a bare shim answers "no flag" and runs the
 * watchdog as it would in any other development host. The chain is free in a
 * production build: the bundler still matches the defined member expression.
 */
const devWatchdog = (): boolean =>
  typeof process === "undefined" ? false : process.env?.NODE_ENV !== "production";

/** The watchdog settings an entry's lifecycle is measured against. */
interface LeaseWatchdog {
  readonly enabled: boolean;
  readonly staleAfterMs: number;
  readonly intervalMs: number;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

/** A refused index declaration, re-stated for the subscription an author wrote. */
const unknownIndexFor = (error: unknown, entry: { readonly key: string }): unknown =>
  error instanceof UnknownIndexError ? knownIndexErrorFor(error, entry.key) : error;

/**
 * Build the registry over a live replica. Every query and row subscription goes
 * through this one table, so this is also the one place that dispatches a
 * change batch and the one place a read's leases are acquired and released.
 *
 * A released query result does not end: it owns the claims it read until the
 * residency TTL elapses, then result and claims end together (#941). That is
 * the one lifetime an unwatched read stays warm for, and a remount inside it
 * takes the entry back without reading or acquiring anything.
 */
export const createSubscriptionRegistry = (
  replica: Replica,
  options: SubscriptionRegistryOptions = {},
): SubscriptionRegistry => {
  const entries = new Map<string, Entry<unknown>>();
  const residencyTtlMs = residencyTtlOf(options.residencyTtlMs);
  // `false` is the off switch, not an empty config: falling through to the
  // defaults would let the dev gate turn the watchdog back on.
  const configured = options.watchdog === false ? { enabled: false } : (options.watchdog ?? {});
  const watchdog: LeaseWatchdog = {
    enabled: configured.enabled ?? devWatchdog(),
    staleAfterMs: configured.staleAfterMs ?? DEFAULT_WATCHDOG_STALE_MS,
    intervalMs: configured.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS,
    now: configured.now ?? (() => Date.now()),
    warn: configured.warn ?? ((message: string) => console.warn(message)),
  };
  let nextId = 0;
  let closed = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  const disarmWatchdog = (): void => {
    if (watchdogTimer === null) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  };

  /**
   * Report every live entry that has held one claim set past the horizon. A
   * reader holding nothing keeps no memory alive, so it is not reported; a
   * reader already reported for this claim set is not reported again.
   */
  const scanWatchdog = (): void => {
    if (closed) return;
    const at = watchdog.now();
    for (const entry of entries.values()) {
      if (entry.state !== "live" || entry.refs <= 0) continue;
      if (entry.warnedAt !== null) continue;
      const quietMs = at - entry.claimsSince;
      if (quietMs < watchdog.staleAfterMs) continue;
      const claims = entry.dependencies.reduce(
        (count, dependency) => count + dependency.components.length,
        0,
      );
      if (claims === 0) continue;
      entry.warnedAt = at;
      watchdog.warn(
        `[Subscriptions] lease watchdog: ${entry.kind} subscription ${JSON.stringify(entry.key)} ` +
          `has held the same ${claims} claim(s) for ${Math.round(quietMs / 1000)}s with a live ` +
          "subscriber. A mounted reader that never releases leaks what it holds — check that " +
          "its cleanup runs (#944).",
      );
    }
  };

  /** Lazily armed: a registry with no entries runs no timer. */
  const armWatchdog = (): void => {
    if (!watchdog.enabled || watchdogTimer !== null || closed) return;
    const timer = setInterval(scanWatchdog, watchdog.intervalMs);
    unrefTimer(timer);
    watchdogTimer = timer;
  };

  const clearRetention = <TResult, TConsumer>(entry: Entry<TResult, TConsumer>): void => {
    entry.retentionGeneration += 1;
    if (entry.retentionTimer === null) return;
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  };

  const endEntry = <TResult, TConsumer>(entry: Entry<TResult, TConsumer>): void => {
    if (entry.state === "terminal") return;
    clearRetention(entry);
    entry.state = "terminal";
    entry.generation += 1;
    const releases = entry.releases;
    entry.releases = [];
    entry.dependencies = [];
    entry.listeners.clear();
    entries.delete(entry.mapKey);
    dispatcher.remove(entry as unknown as Entry<unknown>);
    if (entries.size === 0) disarmWatchdog();
    for (const release of releases) release();
  };

  /**
   * Last subscriber left. A query result keeps its result and its claims for one
   * residency TTL — the same lifetime a released component value gets — then
   * ends, releasing both. A row entry ends at once: it holds a row for a mounted
   * reader, and there is no result left to warm.
   */
  const retire = <TResult, TConsumer>(entry: Entry<TResult, TConsumer>): void => {
    if (entry.kind !== "query") {
      endEntry(entry);
      return;
    }
    // Clear before arming, so "one retention timer per entry" holds however the
    // entry left `inactive` — a structural guarantee rather than a promise of
    // every path. The bump also invalidates a callback already dispatched.
    clearRetention(entry);
    entry.state = "inactive";
    // `residencyTtlMs: 0` disables expiry for the replica's values, so it
    // disables it for the result holding them too: no timer, live until a
    // remount takes it back.
    if (!Number.isFinite(residencyTtlMs)) return;
    const generation = entry.retentionGeneration;
    const timer = setTimeout(() => {
      entry.retentionTimer = null;
      if (entry.state !== "inactive" || entry.refs > 0) return;
      if (entry.retentionGeneration !== generation) return;
      endEntry(entry);
    }, residencyTtlMs);
    unrefTimer(timer);
    entry.retentionTimer = timer;
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

  const depend = <TResult>(
    entry: Entry<TResult>,
    dependencies: readonly Dependency[],
    indices?: readonly IndexDependency[],
  ): void => {
    // An inactive result may still be settling a run it started while mounted;
    // its claims follow the result it holds until the result ends. The list is
    // the claim set of the result the entry still publishes, not a live
    // dispatch set: a value the replica dropped while the entry was inactive
    // stays listed until the result re-runs, costing one dispatch and at most
    // one extra run on remount. Recomputing it here instead would be a re-run —
    // the claim set is derived from a result, so only a new result can heal it —
    // done for nobody while the entry is inactive.
    if (entry.state === "terminal") return;
    const next = mergeComponents(dependencies);
    // Absent keys are not a declaration of none: a caller handing only claims
    // keeps the keys it supplied before, while `[]` is how it withdraws them.
    const nextIndices = indices === undefined ? entry.suppliedIndices : mergeIndices(indices);
    // Keys get their own check rather than joining `sameDependencies`: claims
    // and keys move independently. A claim move re-leases, recompiles the read
    // set, and restarts the watchdog's quiet period; a key move only re-indexes
    // this one entry. Folding the key into the claim check would re-lease for a
    // key-only change and bump the generation of an acquire that has not
    // resolved yet.
    const claimsMoved = !sameDependencies(entry.dependencies, next);
    const keysMoved = !sameIndices(entry.suppliedIndices, nextIndices);
    if (!claimsMoved && !keysMoved) return;
    /** What this move is about to overwrite, so a refused declaration restores it. */
    const held = {
      suppliedIndices: entry.suppliedIndices,
      dependencies: entry.dependencies,
      reads: entry.reads,
      generation: entry.generation,
      claimsSince: entry.claimsSince,
      warnedAt: entry.warnedAt,
    };
    /**
     * Re-index the entry, and undo the whole move if the dispatcher refuses the
     * declaration (#1006). A refusal is not a partial move: the entry keeps the
     * keys, claims, read set, acquire generation and quiet period it held, so
     * what dispatch reaches it through is still what the entry says it depends
     * on. A key-only move touched nothing but the keys, and restoring the rest
     * is then a write of the value already there.
     */
    const reindex = (): void => {
      try {
        dispatcher.add(entry as unknown as Entry<unknown>, indexDependencies(entry));
      } catch (err) {
        Object.assign(entry, held);
        throw unknownIndexFor(err, entry);
      }
    };
    if (keysMoved) entry.suppliedIndices = nextIndices;
    if (!claimsMoved) {
      reindex();
      return;
    }
    entry.dependencies = next;
    // A claim set that moved proves this reader is working: its quiet period
    // restarts and a report already made for the old set no longer applies.
    entry.claimsSince = watchdog.now();
    entry.warnedAt = null;
    entry.reads = compileReads(entry.declaredReads, next, entry.declaredSources);
    entry.generation += 1;
    // A query entry is indexed by the components it reads, so a claim that
    // added components re-indexes it in the same step. A row entry's record
    // names only its row and the keys it supplied, so a new claim cannot move
    // it — only a key-set move does.
    if (entry.kind === "query" || keysMoved) {
      reindex();
    }
    void acquire(entry as unknown as Entry<unknown>, next, entry.generation);
  };

  /** A view of one entry: accessors, no ownership. */
  const snapshotOf = <TResult, TConsumer>(
    entry: Entry<TResult, TConsumer>,
  ): SubscriptionSnapshot<TResult, TConsumer> => ({
    id: entry.id,
    kind: entry.kind,
    key: entry.key,
    row: entry.row,
    get reads() {
      return entry.reads;
    },
    get revision() {
      // Level with the last batch it was handed: the entry is untouched by
      // anything since, so the dispatcher's revision is the honest one. Behind
      // it: the consumer declared the revision its result still reflects, or
      // dispatch could not finish the batch it was handed.
      return entry.stranded || entry.revision < entry.dispatched
        ? entry.revision
        : Math.max(entry.revision, dispatcher.revision());
    },
    get result() {
      return entry.result;
    },
    get consumer() {
      return entry.consumer;
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
   * The writer a listener mutates its entry through. It acts while the entry
   * exists — including after the listener's own share was released, while the
   * result is inactive — because a result that settles behind its last
   * subscriber must still keep the claims it read.
   */
  const writerOf = <TResult, TConsumer>(
    entry: Entry<TResult, TConsumer>,
  ): SubscriptionWriter<TResult> => ({
    get result() {
      return entry.result;
    },
    get reflected() {
      return entry.revision;
    },
    get dependencies() {
      return entry.dependencies;
    },
    publish: (result: TResult) => {
      if (entry.state !== "terminal") entry.result = result;
    },
    seek: (revision: Revision) => {
      if (entry.state === "terminal") return;
      entry.revision = revision;
      entry.declared = true;
    },
    hold: () => {
      entry.declared = true;
    },
    depend: (dependencies: readonly Dependency[], indices?: readonly IndexDependency[]) => {
      depend(entry, dependencies, indices);
    },
  });

  /**
   * Hand one touched entry its batch.
   *
   * The batch moves the entry's revision only for a consumer that was caught up
   * with the previous one, and only after its listeners run, unless one of them
   * set the revision itself: a listener that throws cannot leave a caught-up
   * entry behind for a later batch to jump past, and a batch cannot report a
   * lagging one caught up. A consumer whose result still reflects an older
   * revision holds it, so the lag stays visible until a run settles and seeks
   * forward.
   *
   * An inactive result is still dispatched: a change that touches what it read
   * must reach it so a remount knows the result is stale without re-reading the
   * journal, and so an unrelated change can leave it `current`.
   */
  const notify = (entry: Entry<unknown>, batch: ChangeBatch): void => {
    if (entry.state === "terminal") return;
    // Caught up when the batch began: the consumer has processed everything the
    // entry was handed so far. A consumer that declared lag — its result still
    // reflects an older revision, an async run in flight — is not, and keeps
    // its revision until the run settles and seeks forward.
    const caughtUp = entry.revision >= entry.dispatched;
    entry.declared = false;
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
        depend(
          entry as unknown as Entry<unknown>,
          rowDependencies(replica, entry.row, entry.rowComponents),
        );
      }
    } catch (err) {
      // Dispatch bookkeeping is as load-bearing as a listener here: one entry
      // it cannot evaluate must not starve the rest. The revision and the
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
    const writer = writerOf(entry);
    // A listener may detach a peer, so iterate a snapshot, and report a failure
    // instead of letting one consumer skip the rest.
    for (const listener of Array.from(entry.listeners)) {
      try {
        listener(batch.changes, batch.revision, lost, writer);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[Subscriptions] change listener threw:", err);
      }
    }
    // A consumer that neither moved nor held its revision has processed the
    // batch, so its result is as current as the batch. This runs after the
    // listeners, including a throw, so an entry dispatch reached is never left
    // behind for a later batch to jump past.
    if (caughtUp && !entry.declared) entry.revision = batch.revision;
  };

  // The resolvers here are a fixed set, so the registry can tell an index it
  // cannot answer for from one it cannot narrow. A development build refuses
  // such a declaration at subscribe time, where its author is looking; a
  // production build keeps the fallback, because an extra touch is better than
  // an app that will not start over a name it cannot serve.
  const dispatcher = createChangeDispatcher<Entry<unknown>>({
    journal: replica,
    indices: createIndexResolvers(replica),
    requireResolvers: devWatchdog(),
    onChange: notify,
  });

  const handleOf = <TResult, TConsumer>(
    entry: Entry<TResult, TConsumer>,
  ): Subscription<TResult, TConsumer> => {
    // SAFETY: the mutators are attached below, before the handle escapes.
    const handle = snapshotOf(entry) as unknown as Subscription<TResult, TConsumer>;
    /** One handle releases once: a peer's share is not this handle's to drop. */
    let released = false;
    /** A released handle still acts on the entry while the entry exists. */
    const writable = (): boolean => entry.state !== "terminal";
    // `Object.assign` defines the methods beside the snapshot's accessors;
    // spreading the snapshot would freeze every accessor at its current value.
    Object.assign(handle, {
      release: () => {
        if (released) return;
        released = true;
        if (entry.state === "terminal") return;
        entry.refs -= 1;
        if (entry.refs <= 0) retire(entry);
      },
      publish: (result: TResult) => {
        if (writable()) entry.result = result;
      },
      seek: (revision: Revision) => {
        if (!writable()) return;
        entry.revision = revision;
        entry.declared = true;
      },
      hold: () => {
        entry.declared = true;
      },
      depend: (dependencies: readonly Dependency[], indices?: readonly IndexDependency[]) => {
        depend(entry, dependencies, indices);
      },
      onChange: (listener: ChangeListener<TResult>) => {
        if (!writable()) return () => {};
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
        };
      },
    });
    // `Object.assign` copies a value, not an accessor, so the one field the
    // handle reads live is defined on its own.
    Object.defineProperty(handle, "reflected", {
      get: () => entry.revision,
      enumerable: true,
      configurable: true,
    });
    return handle;
  };

  return {
    open<TResult, TConsumer>(
      spec: SubscriptionSpec,
      consumer?: TConsumer,
    ): Subscription<TResult, TConsumer> {
      const mapKey = registryKey(spec);
      const existing = entries.get(mapKey);
      if (existing !== undefined) {
        if (existing.state === "inactive") {
          // The remount inside the TTL: take the entry back as it stands, so
          // the result, its revision, and the claims it owns all survive.
          clearRetention(existing);
          existing.refs = 1;
          existing.state = "live";
          // The watchdog measures a mounted reader, so a remount starts a new
          // quiet period rather than inheriting the release it came out of.
          existing.claimsSince = watchdog.now();
          existing.warnedAt = null;
        } else {
          existing.refs += 1;
        }
        // SAFETY: the consumer that opened the entry restores the result type
        // it published under the same sharing key.
        return handleOf(existing as unknown as Entry<TResult, TConsumer>);
      }
      const entry: Entry<unknown, TConsumer> = {
        id: (nextId += 1),
        kind: spec.kind,
        key: sharingKey(spec),
        row: spec.kind === "row" ? spec.row : null,
        mapKey,
        declaredReads: declaredReads(spec),
        declaredSources: declaredSources(spec),
        declaredIndices: spec.kind === "query" ? (spec.indices ?? []) : [],
        suppliedIndices: [],
        covered: spec.kind === "query" ? (spec.covered ?? []) : [],
        rowComponents: spec.kind === "row" ? spec.components : undefined,
        consumer: consumer as TConsumer,
        listeners: new Set(),
        reads: compileReadComponents(declaredReads(spec), declaredSources(spec)),
        revision: replica.revision,
        declared: false,
        dispatched: replica.revision,
        stranded: false,
        result: undefined,
        dependencies: [],
        state: "live",
        refs: 1,
        retentionTimer: null,
        retentionGeneration: 0,
        releases: [],
        generation: 0,
        pending: 0,
        claimsSince: watchdog.now(),
        warnedAt: null,
      };
      // SAFETY: an entry's state is independent of the result type it carries,
      // which the consumer that opened it restores on its own handle.
      const handle = handleOf(entry) as unknown as Subscription<TResult, TConsumer>;
      // A registry closed before this subscription opened hands back an inert
      // handle: the caller's release path stays a no-op rather than leaking.
      if (closed) {
        entry.state = "terminal";
        return handle;
      }
      entries.set(mapKey, entry);
      try {
        dispatcher.add(entry, indexDependencies(entry));
      } catch (err) {
        // A refused declaration fails the open, so the registry holds nothing
        // for a key that never became a subscription (#1006).
        entries.delete(mapKey);
        entry.state = "terminal";
        throw unknownIndexFor(err, entry);
      }
      armWatchdog();
      if (entry.kind === "row" && entry.row !== null) {
        depend(entry, rowDependencies(replica, entry.row, entry.rowComponents));
      }
      return handle;
    },
    peek<TResult, TConsumer>(kind: SubscriptionKind, key: string) {
      const entry = entries.get(mapKeyOf(kind, key));
      if (entry === undefined) return undefined;
      // SAFETY: the consumer restores the types it opened the entry with.
      return snapshotOf(entry as unknown as Entry<TResult, TConsumer>);
    },
    entries: () => Array.from(entries.values()).map((entry) => snapshotOf(entry)),
    stats: () => {
      let live = 0;
      let inactive = 0;
      let query = 0;
      let row = 0;
      let dependencies = 0;
      let pending = 0;
      for (const entry of entries.values()) {
        if (entry.state === "inactive") inactive += 1;
        else {
          live += 1;
          if (entry.kind === "query") query += 1;
          else row += 1;
        }
        dependencies += entry.dependencies.reduce((count, dep) => count + dep.components.length, 0);
        pending += entry.pending;
      }
      return {
        live,
        inactive,
        byKind: { query, row },
        dependencies,
        pending,
        dispatch: dispatcher.stats(),
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      // The last chance to name a reader that outlived its client: teardown
      // ends every entry, so a live one here is a cleanup that never ran.
      const live = Array.from(entries.values()).filter(
        (entry) => entry.state === "live" && entry.refs > 0,
      );
      const claims = live.reduce(
        (count, entry) =>
          count +
          entry.dependencies.reduce((held, dependency) => held + dependency.components.length, 0),
        0,
      );
      disarmWatchdog();
      for (const entry of Array.from(entries.values())) endEntry(entry);
      dispatcher.close();
      // Reported last, from numbers taken first: a sink that throws must not
      // leave the registry closed while its entries still hold their claims.
      if (watchdog.enabled && live.length > 0) {
        watchdog.warn(
          `[Subscriptions] lease watchdog: close() with ${live.length} live subscription(s) ` +
            `holding ${claims} claim(s). The client outlived its mounted readers, so their ` +
            "cleanup will never run (#944).",
        );
      }
    },
  };
};
