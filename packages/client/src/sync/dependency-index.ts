/**
 * Dependency-indexed change dispatch (#938).
 *
 * One dispatcher owns one journal position and a set of inverted indices: which
 * subscriptions read a component, read a model whole, watch a row, or read a
 * derived index (`index:<name>` — a membership subject, a group scope, a
 * relation target, a component's presence). A batch then costs the
 * subscriptions it touches plus one lookup per dependency kind per change,
 * instead of every subscription checked against every change.
 *
 * The dispatcher is the only place a batch is read: `changesSince` is called
 * once, and the entries that survive the indices are the ones any work
 * happens for. An entry a batch does not touch is never visited — a caught-up
 * one's revision derives from the dispatcher's own, so the batch costs it
 * nothing.
 *
 * Gaps. A revision below the retained window, or an empty batch on an advanced
 * revision (a replica `load` replaces the journal), cannot be narrowed against:
 * every subscription may have changed, so every one is handed the batch. A
 * resolver that cannot name a change's keys is the same answer for the one
 * index it serves, so the entries that declared it are handed the batch.
 *
 * Missing resolvers. An index name no resolver serves is author error — a
 * typo'd name, or a family the registry forgot — and the lenient fallback would
 * hide it behind a batch that always touches the whole declarer set. So a
 * dispatcher built with {@link ChangeDispatcherOptions.requireResolvers} refuses
 * such an entry at registration instead, where the author is looking. `null`
 * from a served resolver is a different answer and keeps the declarer breadth
 * above: that change could have moved any key.
 *
 * The index is maintained as a map from entry to what it declared, so removing
 * or reseating an entry costs its own dependencies rather than a scan.
 */

import { componentModel } from "@ebbjs/core";
import type { ReplicaChange, Revision } from "@ebbjs/storage/replica";

/**
 * One derived-index read: `index:<name>`, keyed by `key`.
 */
export interface IndexDependency {
  /**
   * The index name: `membership` for the member entity a row subscription
   * files, `scope` for a group a read is scoped to, or a namespace name the
   * query read declares — `relation:<as>/<type>`, `exists:<component>`. The
   * dispatcher serves each from the resolver registered under its name, or
   * under the namespace it starts with.
   */
  readonly index: string;
  /** The key to match under that index: a bare id, not an `index:<key>` form. */
  readonly key: string;
}

/**
 * Everything one subscription declared it reads. A content change is matched by
 * component name — or, for a whole-model read, by the component's model prefix;
 * a membership change by the model the row entered or left, which every reader
 * of that model observes; a row watch by the changed id; and a derived-index
 * read by whatever the change resolves to under that index.
 */
export interface SubscriptionDependencies {
  /** Exact component names (`note/content`). */
  readonly components?: readonly string[];
  /** Models read whole (`note` stands for every `note/*` component). */
  readonly models?: readonly string[];
  /**
   * Models whose row set the subscription observes. A membership change names
   * no component, so the model the row entered or left is what reaches these
   * readers; unlike `models`, it does not observe a content change.
   */
  readonly sources?: readonly string[];
  /** Row ids watched directly. */
  readonly rows?: readonly string[];
  readonly indices?: readonly IndexDependency[];
}

/** What one dispatched batch cost. */
export interface DispatchCounts {
  /** Subscriptions the batch touched — the entries any work happens for. */
  readonly touched: number;
  /**
   * Index lookups performed, and nothing else: one per change for its row
   * watch, two per component it names (the component, then its model), one per
   * model-reader set for a change that names no component, and one per key a
   * change resolves to under each derived index. The per-batch registration
   * order sort and the notify calls are outside it, so this is lookup cost, not
   * total batch cost.
   */
  readonly lookups: number;
  /** Change × subscription pairs a scan of every entry would have examined. */
  readonly scanWork: number;
}

/** One batch, as handed to every subscription it touches. */
export interface ChangeBatch {
  readonly revision: Revision;
  readonly changes: readonly ReplicaChange[];
}

/**
 * The journal a dispatcher reads. The replica satisfies this: one change
 * reader, the revision it is at, the oldest revision the retained window still
 * answers, and a notification per mutating call.
 */
export interface ChangeJournal {
  readonly revision: Revision;
  readonly changeFloor: Revision;
  changesSince(revision: Revision): readonly ReplicaChange[];
  subscribe(listener: () => void): () => void;
}

/**
 * The keys one change names under one derived index, or `null` when the change
 * cannot be resolved against the index's current state — a link write whose
 * removed target the journal does not name, a row an eviction left no trace of.
 * `null` is not "no keys": every entry that declared the index is touched, the
 * same breadth the component read set gave before the index existed. The index
 * name is passed so a namespace resolver (one function serving every
 * `relation:<as>/<type>`) can answer for the index it was asked about.
 */
export type IndexResolver = (change: ReplicaChange, index: string) => readonly string[] | null;

/**
 * An entry declared an index no resolver serves, on a dispatcher whose resolver
 * set was declared complete. Author error: the query names an index the
 * registry cannot answer for, and the lenient fallback would have reported it
 * as nothing but a wider batch.
 */
export class UnknownIndexError extends Error {
  /** The index name the entry declared. */
  readonly index: string;
  /** The names the dispatcher's resolvers answer to, in registration order. */
  readonly known: readonly string[];
  /**
   * The subscription that declared it, when the refusal is re-stated for one.
   * The dispatcher indexes an opaque entry, so only the registry that built it
   * can say which subscription an author has to go and fix; it names it on the
   * way out. `null` for a dispatcher a test drives by hand.
   */
  readonly subject: string | null;

  constructor(index: string, known: readonly string[], subject: string | null = null) {
    const declared = subject === null ? "" : ` declared by "${subject}"`;
    super(`no resolver for index "${index}"${declared}; known indices: ${known.join(", ")}`);
    this.name = "UnknownIndexError";
    this.index = index;
    this.known = known;
    this.subject = subject;
  }
}

/**
 * The same refusal, naming the subscription that declared it. A dispatcher sees
 * an opaque entry, so the registry adds the key its author wrote; the dispatch
 * seam stays the one place the check runs.
 */
export const knownIndexErrorFor = (error: UnknownIndexError, subject: string): UnknownIndexError =>
  new UnknownIndexError(error.index, error.known, subject);

export interface ChangeDispatcherOptions<T> {
  readonly journal: ChangeJournal;
  /**
   * How a change resolves to derived-index keys, by index name. A key ending in
   * `*` is a namespace and serves every index name that starts with it, which
   * is how dynamically named indices (`relation:<as>/<type>`,
   * `exists:<component>`) are served without enumerating them. Only names an
   * entry actually declared are resolved, so an unused resolver costs nothing.
   * A declared index with no resolver is unresolvable, like a `null` answer —
   * unless {@link ChangeDispatcherOptions.requireResolvers} says this set is
   * complete, in which case `add` refuses it.
   */
  readonly indices?: Readonly<Record<string, IndexResolver>>;
  /**
   * Declare the resolver set complete: every index an entry declares must have
   * a resolver — an exact name, or a `*` namespace serving it — and `add`
   * refuses one that does not with {@link UnknownIndexError}. A registry that
   * builds its resolvers from a fixed set sets this, so the author of a query
   * hears about a typo'd index at subscribe time. Left unset, a name nothing
   * serves stays a `null` answer: every declarer is touched, which is what a
   * shipped build must do with a name it cannot serve.
   */
  readonly requireResolvers?: boolean;
  /** Hand one batch to one touched subscription. */
  readonly onChange: (entry: T, batch: ChangeBatch) => void;
}

export interface ChangeDispatcher<T> {
  /**
   * Index `entry`, replacing whatever it declared before. Removing it again
   * costs its own dependencies, never a scan of the table.
   */
  add(entry: T, dependencies: SubscriptionDependencies): void;
  /**
   * Drop `entry`, matched by object identity: an equal but distinct object is
   * simply not indexed, so removing it does nothing.
   */
  remove(entry: T): void;
  /** How many subscriptions are indexed. */
  size(): number;
  /** The revision the dispatcher has been dispatched through. */
  revision(): Revision;
  /** Counters from the last batch dispatched. */
  stats(): DispatchCounts;
  /** Stop dispatching and drop every entry. */
  close(): void;
}

const addTo = <T>(map: Map<string, Set<T>>, key: string, entry: T): void => {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, new Set([entry]));
  else bucket.add(entry);
};

const removeFrom = <T>(map: Map<string, Set<T>>, key: string, entry: T): void => {
  const bucket = map.get(key);
  if (bucket === undefined) return;
  bucket.delete(entry);
  if (bucket.size === 0) map.delete(key);
};

/** An entry's place in registration order, so a batch fans out deterministically. */
interface Indexed {
  readonly seq: number;
  readonly components: readonly string[];
  readonly models: readonly string[];
  readonly sources: readonly string[];
  readonly rows: readonly string[];
  readonly indices: readonly IndexDependency[];
}

const collectInto = <T>(touched: Set<T>, bucket: ReadonlySet<T> | undefined): void => {
  if (bucket === undefined) return;
  for (const entry of bucket) touched.add(entry);
};

/**
 * The models whose row set an entry observes: the ones it declared whole plus
 * the ones its exact component reads belong to. A component is named
 * `<model>/<field>`, so an exact read still observes that model's set changing.
 */
const sourcesOf = (indexed: {
  readonly components: readonly string[];
  readonly models: readonly string[];
  readonly sources: readonly string[];
}): ReadonlySet<string> => {
  const sources = new Set([...indexed.models, ...indexed.sources]);
  for (const component of indexed.components) sources.add(componentModel(component));
  return sources;
};

export const createChangeDispatcher = <T>(
  options: ChangeDispatcherOptions<T>,
): ChangeDispatcher<T> => {
  const { journal, onChange } = options;
  const exact = new Map<string, IndexResolver>();
  const namespaces: { readonly prefix: string; readonly resolve: IndexResolver }[] = [];
  for (const [name, resolve] of Object.entries(options.indices ?? {})) {
    if (name.endsWith("*")) namespaces.push({ prefix: name.slice(0, -1), resolve });
    else exact.set(name, resolve);
  }
  /** The names the resolvers answer to, as an author reads them back in an error. */
  const known = Object.keys(options.indices ?? {});
  /** One lookup per declared index name, memoized for the dispatcher's life. */
  const resolverCache = new Map<string, IndexResolver | null>();
  const resolverFor = (index: string): IndexResolver | null => {
    const cached = resolverCache.get(index);
    if (cached !== undefined) return cached;
    let found = exact.get(index) ?? null;
    if (found === null) {
      for (const candidate of namespaces) {
        if (index.startsWith(candidate.prefix)) {
          found = candidate.resolve;
          break;
        }
      }
    }
    resolverCache.set(index, found);
    return found;
  };
  const entries = new Map<T, Indexed>();
  const byComponent = new Map<string, Set<T>>();
  /** Readers of a model whole (`<model>/*`), for a content change. */
  const byModel = new Map<string, Set<T>>();
  /**
   * Every reader of a model's rows: whoever declared the model whole or reads
   * any component of it. A membership change names no component, so its model
   * is what reaches them.
   */
  const bySource = new Map<string, Set<T>>();
  const byRow = new Map<string, Set<T>>();
  /** `index:<name>` → key → entries. */
  const byIndex = new Map<string, Map<string, Set<T>>>();
  /** `index:<name>` → every entry that declared it, for an unresolvable change. */
  const byIndexAll = new Map<string, Set<T>>();
  let nextSeq = 0;
  let dispatched: Revision = journal.revision;
  let counts: DispatchCounts = { touched: 0, lookups: 0, scanWork: 0 };
  let closed = false;

  const drop = (entry: T): void => {
    const indexed = entries.get(entry);
    if (indexed === undefined) return;
    entries.delete(entry);
    for (const component of indexed.components) removeFrom(byComponent, component, entry);
    for (const model of indexed.models) removeFrom(byModel, model, entry);
    for (const model of sourcesOf(indexed)) removeFrom(bySource, model, entry);
    for (const row of indexed.rows) removeFrom(byRow, row, entry);
    for (const { index, key } of indexed.indices) {
      const bucket = byIndex.get(index);
      if (bucket === undefined) continue;
      removeFrom(bucket, key, entry);
      if (bucket.size === 0) byIndex.delete(index);
    }
    for (const index of new Set(indexed.indices.map((dependency) => dependency.index))) {
      removeFrom(byIndexAll, index, entry);
    }
  };

  /**
   * The subscriptions a batch touches, and what finding them cost. One lookup
   * per dependency kind per change: the row watch, then either the components
   * and their models for a content change or the models the row moved between
   * for a membership change.
   */
  const touchedBy = (changes: readonly ReplicaChange[]): { touched: Set<T>; lookups: number } => {
    const touched = new Set<T>();
    let lookups = 0;
    for (const change of changes) {
      lookups += 1;
      collectInto(touched, byRow.get(change.id));
      if (change.kind === "membership") {
        for (const model of change.models) {
          lookups += 1;
          collectInto(touched, bySource.get(model));
        }
      } else {
        for (const component of change.components) {
          lookups += 2;
          collectInto(touched, byComponent.get(component));
          collectInto(touched, byModel.get(componentModel(component)));
        }
      }
      for (const [index, buckets] of byIndex) {
        const resolve = resolverFor(index);
        const keys = resolve === null ? null : resolve(change, index);
        if (keys === null) {
          // The change cannot be narrowed against this index, so every entry
          // that declared it is handed the batch: the component read set's
          // breadth, never fewer.
          lookups += 1;
          collectInto(touched, byIndexAll.get(index));
          continue;
        }
        for (const key of keys) {
          lookups += 1;
          collectInto(touched, buckets.get(key));
        }
      }
    }
    return { touched, lookups };
  };

  /** Registration order, so a listener cannot depend on an arbitrary bucket order. */
  const inOrder = (touched: ReadonlySet<T>): readonly T[] =>
    [...touched].sort((a, b) => (entries.get(a)?.seq ?? 0) - (entries.get(b)?.seq ?? 0));

  const dispatch = (): void => {
    if (closed) return;
    const revision = journal.revision;
    if (revision === dispatched) return;
    if (entries.size === 0) {
      dispatched = revision;
      counts = { touched: 0, lookups: 0, scanWork: 0 };
      return;
    }
    const changes = journal.changesSince(dispatched);
    // Nothing to narrow against: the revision fell below the retained window,
    // or the journal was replaced wholesale (a `load`) and a revision jump is
    // all that is left of the batch.
    const gap = dispatched < journal.changeFloor || changes.length === 0;
    dispatched = revision;
    let found: { touched: Set<T>; lookups: number };
    try {
      found = gap ? { touched: new Set(entries.keys()), lookups: 0 } : touchedBy(changes);
    } catch (err) {
      // A resolver reads the changed row, and a change it cannot read leaves the
      // batch no more narrowable than a gap: one failure reports and hands every
      // entry the batch rather than losing it for all of them.
      // eslint-disable-next-line no-console
      console.error("[Dispatch] index resolver threw:", err);
      found = { touched: new Set(entries.keys()), lookups: 0 };
    }
    counts = {
      touched: found.touched.size,
      lookups: found.lookups,
      scanWork: changes.length * entries.size,
    };
    if (found.touched.size === 0) return;
    const batch: ChangeBatch = { revision, changes };
    // A listener may add or end a peer, so the fan-out runs over a snapshot.
    for (const entry of inOrder(found.touched)) onChange(entry, batch);
  };

  const detach = journal.subscribe(dispatch);

  return {
    add(entry, dependencies) {
      if (closed) return;
      // Before `drop`, so a refusal leaves the dispatcher exactly as it was and
      // the entry keeps the indexing it had.
      const declared = dependencies.indices ?? [];
      if (options.requireResolvers === true) {
        for (const { index } of declared) {
          if (resolverFor(index) === null) throw new UnknownIndexError(index, known);
        }
      }
      const seq = entries.get(entry)?.seq ?? (nextSeq += 1);
      drop(entry);
      const indexed: Indexed = {
        seq,
        components: dependencies.components ?? [],
        models: dependencies.models ?? [],
        sources: dependencies.sources ?? [],
        rows: dependencies.rows ?? [],
        indices: declared,
      };
      entries.set(entry, indexed);
      for (const component of indexed.components) addTo(byComponent, component, entry);
      for (const model of indexed.models) addTo(byModel, model, entry);
      for (const model of sourcesOf(indexed)) addTo(bySource, model, entry);
      for (const row of indexed.rows) addTo(byRow, row, entry);
      for (const { index, key } of indexed.indices) {
        let bucket = byIndex.get(index);
        if (bucket === undefined) byIndex.set(index, (bucket = new Map()));
        addTo(bucket, key, entry);
      }
      for (const index of new Set(indexed.indices.map((dependency) => dependency.index))) {
        let all = byIndexAll.get(index);
        if (all === undefined) byIndexAll.set(index, (all = new Set()));
        all.add(entry);
      }
    },
    remove: drop,
    size: () => entries.size,
    revision: () => dispatched,
    stats: () => counts,
    close: () => {
      if (closed) return;
      closed = true;
      detach();
      for (const entry of entries.keys()) drop(entry);
    },
  };
};
