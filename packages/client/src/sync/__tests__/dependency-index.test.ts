/**
 * Unit tests for dependency-indexed dispatch (#938).
 *
 * A batch touches only the subscriptions whose declared dependencies intersect
 * it — component, model, row, and derived-index reads — so the cost of a batch
 * is the subscriptions it touches plus one index lookup per dependency kind per
 * change, instead of every entry checked against every change.
 */

import { describe, expect, it, vi } from "vitest";
import type { ReplicaChange, Revision } from "@ebbjs/storage/replica";

import {
  createChangeDispatcher,
  UnknownIndexError,
  type ChangeDispatcher,
  type IndexResolver,
  type SubscriptionDependencies,
} from "../dependency-index";

interface Sub {
  readonly id: number;
}

/** A component write: the change names what a reader can project. */
const change = (id: string, components: readonly string[], revision: Revision): ReplicaChange => ({
  revision,
  id,
  kind: "content",
  deleted: false,
  components,
});

/** A row entering or leaving a model's set: no component list, just the model. */
const membership = (id: string, models: readonly string[], revision: Revision): ReplicaChange => ({
  revision,
  id,
  kind: "membership",
  deleted: false,
  membership: "entered",
  models,
});

/**
 * A journal a test drives by hand, shaped like the replica's: `publish` is one
 * mutating call's notification, `reset` a `load`, and `trim` a window
 * advancing past what a slow reader has read.
 */
const testJournal = () => {
  let revision: Revision = 0;
  let changeFloor: Revision = 0;
  let journal: readonly ReplicaChange[] = [];
  const listeners = new Set<() => void>();
  let reads = 0;
  return {
    get revision() {
      return revision;
    },
    get changeFloor() {
      return changeFloor;
    },
    get reads() {
      return reads;
    },
    changesSince(from: Revision): readonly ReplicaChange[] {
      reads += 1;
      if (from < changeFloor) return [];
      return journal.filter((entry) => entry.revision > from);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Append a batch and notify, as one replica mutation would. */
    publish(changes: readonly ReplicaChange[]): void {
      journal = [...journal, ...changes];
      const last = changes[changes.length - 1];
      revision = last === undefined ? revision + 1 : last.revision;
      for (const listener of listeners) listener();
    },
    /** Replace the journal wholesale, the way a `load` does. */
    reset(next: Revision): void {
      journal = [];
      revision = next;
      changeFloor = next;
      for (const listener of listeners) listener();
    },
    /** Drop every entry at or below `floor`, as the window does on a bump. */
    trim(floor: Revision): void {
      changeFloor = floor;
      journal = journal.filter((entry) => entry.revision > floor);
      revision = Math.max(revision, floor);
      for (const listener of listeners) listener();
    },
  };
};

type TestJournal = ReturnType<typeof testJournal>;

/**
 * The derived-index keys a change names, per index: what a resolver answers
 * after reading the changed row.
 */
type KeysOf = (change: ReplicaChange) => Readonly<Record<string, readonly string[]>>;

const resolverFor =
  (keysOf: KeysOf, name: string): IndexResolver =>
  (change) =>
    keysOf(change)[name] ?? [];

interface Fixture {
  readonly entry: Sub;
  readonly dependencies: SubscriptionDependencies;
}

/**
 * The scan #938 replaces: every registered subscription checked against every
 * change. The oracle for "the set the indices touch".
 */
const scanTouched = (
  fixture: readonly Fixture[],
  changes: readonly ReplicaChange[],
  keysOf: (change: ReplicaChange) => Readonly<Record<string, readonly string[]>>,
): Set<number> => {
  const touched = new Set<number>();
  for (const { entry, dependencies } of fixture) {
    for (const next of changes) {
      const components = dependencies.components ?? [];
      const models = dependencies.models ?? [];
      // A row entering or leaving a model's set is visible to every reader of
      // that model; a content change is matched by name.
      const named =
        next.kind === "membership"
          ? next.models.some(
              (model) =>
                models.includes(model) ||
                components.some(
                  (component) => component.slice(0, component.indexOf("/")) === model,
                ),
            )
          : next.components.some(
              (component) =>
                components.includes(component) ||
                models.includes(component.slice(0, component.indexOf("/"))),
            );
      const rowRead = (dependencies.rows ?? []).includes(next.id);
      const keys = keysOf(next);
      const indexRead = (dependencies.indices ?? []).some(({ index, key }) =>
        (keys[index] ?? []).includes(key),
      );
      if (named || rowRead || indexRead) {
        touched.add(entry.id);
        break;
      }
    }
  }
  return touched;
};

/** A dispatcher over `journal` that records who it was handed, in order. */
const harness = (
  journal: TestJournal,
): {
  readonly dispatcher: ChangeDispatcher<Sub>;
  readonly notified: Set<number>;
  readonly order: number[];
} => {
  const notified = new Set<number>();
  const order: number[] = [];
  const dispatcher = createChangeDispatcher<Sub>({
    journal,
    onChange: (entry) => {
      notified.add(entry.id);
      order.push(entry.id);
    },
  });
  return { dispatcher, notified, order };
};

/** A deterministic pseudo-random generator so a fixture is reproducible. */
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("dependency-indexed dispatch: correctness", () => {
  it("touches exactly the subscriptions a scan touches", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const keysOf: KeysOf = (next) => ({
      membership:
        next.kind === "content"
          ? next.components.includes("ebb/membership")
            ? [next.id]
            : []
          : next.models.includes("ebb")
            ? [next.id]
            : [],
      scope: next.id.startsWith("eg_") ? ["grp_1"] : [],
    });
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: {
        membership: resolverFor(keysOf, "membership"),
        scope: resolverFor(keysOf, "scope"),
      },
      onChange: (entry) => notified.add(entry.id),
    });

    const fixture: readonly Fixture[] = [
      { entry: { id: 1 }, dependencies: { components: ["note/title"] } },
      { entry: { id: 2 }, dependencies: { models: ["note"] } },
      {
        entry: { id: 3 },
        dependencies: {
          components: ["note/content"],
          rows: ["n_7"],
          indices: [{ index: "membership", key: "n_7" }],
        },
      },
      { entry: { id: 4 }, dependencies: { rows: ["n_1"] } },
      { entry: { id: 5 }, dependencies: { components: ["ebb/link"] } },
      { entry: { id: 6 }, dependencies: { indices: [{ index: "scope", key: "grp_1" }] } },
    ];
    for (const { entry, dependencies } of fixture) dispatcher.add(entry, dependencies);

    const batches: readonly (readonly ReplicaChange[])[] = [
      [change("n_1", ["note/title"], 1)],
      [change("n_7", ["note/content"], 2)],
      [change("n_9", ["ebb/grant"], 3)],
      [membership("n_1", ["note"], 4)],
      [change("eg_1", ["ebb/membership"], 5)],
      [
        change("n_2", ["note/title"], 6),
        change("n_7", ["note/content"], 7),
        membership("n_1", ["note"], 8),
        change("eg_2", ["ebb/membership"], 9),
      ],
    ];

    for (const batch of batches) {
      notified.clear();
      journal.publish(batch);
      expect([...notified].sort((a, b) => a - b)).toEqual(
        [...scanTouched(fixture, batch, keysOf)].sort((a, b) => a - b),
      );
    }
  });

  it("touches the readers of a model on a membership change, and only exact names on a component write", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    dispatcher.add({ id: 1 }, { components: ["note/title"] });
    dispatcher.add({ id: 2 }, { components: ["note/status"] });
    dispatcher.add({ id: 3 }, { models: ["note"] });
    dispatcher.add({ id: 4 }, { components: ["page/title"] });

    // A row entering `note` names no component: every reader of `note`, exact
    // or whole, is affected; a reader of another model is not.
    journal.publish([membership("n_1", ["note"], 1)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([1, 2, 3]);

    // A component write is matched by name, so only its own readers see it.
    notified.clear();
    journal.publish([change("n_1", ["note/title"], 2)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("hands every entry the batch when a resolver throws", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: {
        membership: () => {
          throw new Error("resolve boom");
        },
      },
      onChange: (entry) => notified.add(entry.id),
    });
    dispatcher.add(
      { id: 1 },
      { components: ["note/title"], indices: [{ index: "membership", key: "n_1" }] },
    );
    dispatcher.add({ id: 2 }, { components: ["note/content"] });

    journal.publish([change("n_1", ["note/title"], 1)]);

    // A change it cannot resolve leaves the batch no more narrowable than a
    // gap: every entry is handed it rather than none.
    expect([...notified].sort()).toEqual([1, 2]);
    expect(dispatcher.stats()).toEqual({ touched: 2, lookups: 0, scanWork: 2 });
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
  });

  it("touches every entry that declared an index when the resolver cannot resolve the change", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: {
        "relation:*": (change) =>
          change.kind === "content" && change.components.includes("ebb/link") ? null : [change.id],
      },
      onChange: (entry) => notified.add(entry.id),
    });
    const relation = "relation:author/page";
    dispatcher.add({ id: 1 }, { indices: [{ index: relation, key: "u_1" }] });
    dispatcher.add({ id: 2 }, { indices: [{ index: relation, key: "u_2" }] });
    // Declares no relation index, so a fallback for one must not reach it.
    dispatcher.add({ id: 3 }, { components: ["note/title"] });

    notified.clear();
    journal.publish([change("p_1", ["page/title"], 1)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([]);

    // The row is a target: a read keyed on it was named.
    notified.clear();
    journal.publish([change("u_1", ["user/name"], 2)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([1]);

    // A link write may have removed an edge whose target the resolver cannot
    // name, so every entry that declared the index is touched.
    notified.clear();
    journal.publish([change("p_1", ["ebb/link"], 3)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(dispatcher.stats().touched).toBe(2);
  });

  it("serves dynamically named indices from a namespace resolver", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: { "exists:*": (change) => (change.kind === "content" ? change.components : []) },
      onChange: (entry) => notified.add(entry.id),
    });
    dispatcher.add({ id: 1 }, { indices: [{ index: "exists:todo/due", key: "todo/due" }] });
    dispatcher.add({ id: 2 }, { indices: [{ index: "exists:todo/owner", key: "todo/owner" }] });
    dispatcher.add({ id: 3 }, { components: ["todo/title"] });

    journal.publish([change("t_1", ["todo/due"], 1)]);
    expect([...notified].sort((a, b) => a - b)).toEqual([1]);
  });

  it("refuses a declared index no resolver serves when the resolver set is complete", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: { membership: () => [], scope: () => [] },
      requireResolvers: true,
      onChange: (entry) => notified.add(entry.id),
    });
    dispatcher.add({ id: 2 }, { components: ["note/title"] });

    // The typo is named, and so is everything the dispatcher can serve, so the
    // author reads the fix out of the error instead of guessing.
    expect(() =>
      dispatcher.add({ id: 1 }, { indices: [{ index: "relation:typo/typo", key: "u_1" }] }),
    ).toThrow(UnknownIndexError);
    expect(() =>
      dispatcher.add({ id: 1 }, { indices: [{ index: "relation:typo/typo", key: "u_1" }] }),
    ).toThrow(/relation:typo\/typo/);
    expect(() =>
      dispatcher.add({ id: 1 }, { indices: [{ index: "relation:typo/typo", key: "u_1" }] }),
    ).toThrow(/membership, scope/);

    // Nothing was indexed for the refused entry, so the dispatcher is exactly
    // what it was: one entry, and the batch it alone matches reaches it.
    expect(dispatcher.size()).toBe(1);
    journal.publish([change("n_1", ["note/title"], 1)]);
    expect([...notified]).toEqual([2]);

    // A refused reindex keeps the entry's previous indexing: the old component
    // read still reaches it, and the refused one indexed nothing.
    expect(() =>
      dispatcher.add(
        { id: 2 },
        {
          components: ["note/body"],
          indices: [{ index: "relation:typo/typo", key: "u_1" }],
        },
      ),
    ).toThrow(UnknownIndexError);
    notified.clear();
    journal.publish([change("n_1", ["note/title"], 2)]);
    expect([...notified]).toEqual([2]);
  });

  it("accepts a declared index a namespace resolver serves", () => {
    const journal = testJournal();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: { membership: () => [], "relation:*": (change) => [change.id] },
      requireResolvers: true,
      onChange: () => {},
    });

    // A dynamically named index has no entry of its own in the resolver set:
    // the namespace is what declares it served.
    expect(() =>
      dispatcher.add({ id: 1 }, { indices: [{ index: "relation:author/page", key: "u_1" }] }),
    ).not.toThrow();
    expect(dispatcher.size()).toBe(1);
  });

  it("keeps the declarer breadth when a served resolver answers null", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      indices: {
        membership: () => [],
        "relation:*": (change) =>
          change.kind === "content" && change.components.includes("ebb/link") ? null : [change.id],
      },
      requireResolvers: true,
      onChange: (entry) => notified.add(entry.id),
    });
    const relation = "relation:author/page";
    dispatcher.add({ id: 1 }, { indices: [{ index: relation, key: "u_1" }] });
    dispatcher.add({ id: 2 }, { indices: [{ index: relation, key: "u_2" }] });
    dispatcher.add({ id: 3 }, { components: ["note/title"] });

    // A link write could have removed any edge, so the resolver's "I cannot
    // say" is answered with every entry that declared the index — the breadth
    // #961 gave before the index existed, never fewer.
    journal.publish([change("p_1", ["ebb/link"], 1)]);

    expect([...notified].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("treats a declared index with no resolver as unresolvable", () => {
    const journal = testJournal();
    const notified = new Set<number>();
    const dispatcher = createChangeDispatcher<Sub>({
      journal,
      onChange: (entry) => notified.add(entry.id),
    });
    dispatcher.add({ id: 1 }, { indices: [{ index: "unknown", key: "a" }] });
    dispatcher.add({ id: 2 }, { components: ["note/title"] });

    journal.publish([change("n_1", ["other/title"], 1)]);

    expect([...notified]).toEqual([1]);
  });

  it("notifies in registration order", () => {
    const journal = testJournal();
    const { dispatcher, order } = harness(journal);
    for (const id of [3, 1, 2]) dispatcher.add({ id }, { components: ["note/title"] });

    journal.publish([change("n_1", ["note/title"], 1)]);

    expect(order).toEqual([3, 1, 2]);
  });

  it("stops touching an entry once it is removed", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    const kept: Sub = { id: 1 };
    const gone: Sub = { id: 2 };
    dispatcher.add(kept, { components: ["note/title"] });
    dispatcher.add(gone, { components: ["note/title"] });
    dispatcher.remove(gone);

    journal.publish([change("n_1", ["note/title"], 1)]);

    expect([...notified]).toEqual([1]);
    expect(dispatcher.size()).toBe(1);
  });

  it("reindexes an entry that changes what it reads", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    const entry: Sub = { id: 1 };
    dispatcher.add(entry, { components: ["note/title"] });
    dispatcher.add(entry, { components: ["note/content"] });

    journal.publish([change("n_1", ["note/title"], 1)]);
    expect([...notified]).toEqual([]);

    journal.publish([change("n_1", ["note/content"], 2)]);
    expect([...notified]).toEqual([1]);
  });
});

describe("dependency-indexed dispatch: cost", () => {
  it("touches 3,810 of 5,000 subscriptions with 280 lookups for 100 changes", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    const random = mulberry32(42);
    const fixture: Fixture[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      // Every entry draws a row id, the way the design record's fixture did;
      // only the kinds that watch one index on it.
      const row = `n_${Math.floor(random() * 2_000)}`;
      const kind = i % 4;
      const dependencies: SubscriptionDependencies =
        kind === 0
          ? { models: ["note"] }
          : kind === 1
            ? { components: ["note/title", "note/status"] }
            : kind === 2
              ? { components: ["note/content"], rows: [row] }
              : { rows: [row] };
      fixture.push({ entry: { id: i }, dependencies });
    }
    for (const { entry, dependencies } of fixture) dispatcher.add(entry, dependencies);

    const changes: readonly ReplicaChange[] = Array.from({ length: 100 }, (_, i) =>
      i % 5 === 0 ? membership(`n_${i}`, ["note"], i + 1) : change(`n_${i}`, ["note/title"], i + 1),
    );
    journal.publish(changes);

    // A membership change names no component, so it reaches every reader of
    // the model — 3,750 of them — where only whole-model readers used to be
    // reachable; a content change still costs one lookup per component.
    expect(dispatcher.stats()).toEqual({ touched: 3_810, lookups: 280, scanWork: 500_000 });
    expect(notified.size).toBe(3_810);
    // Not just the count: the same fixture through the scan oracle has to name
    // exactly these subscriptions, which is the acceptance item the issue
    // states on these batches. The 500,000 pairs are worth the second here.
    const scanned = [...scanTouched(fixture, changes, () => ({}))];
    expect([...notified].sort((a, b) => a - b)).toEqual(scanned.sort((a, b) => a - b));
  });

  it("touches 100 of 5,000 subscriptions with 3 lookups for one change", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    for (let i = 0; i < 5_000; i += 1) {
      dispatcher.add(
        { id: i },
        { components: [i % 2 === 0 ? `note/field_${i % 50}` : `other/field_${i % 50}`] },
      );
    }

    journal.publish([change("n_1", ["note/field_0"], 1)]);

    expect(dispatcher.stats()).toEqual({ touched: 100, lookups: 3, scanWork: 5_000 });
    expect(notified.size).toBe(100);
  });

  it("reads the journal once for a batch, however many entries it touches", () => {
    const journal = testJournal();
    const { dispatcher } = harness(journal);
    for (let i = 0; i < 500; i += 1) dispatcher.add({ id: i }, { models: ["note"] });

    journal.publish(Array.from({ length: 20 }, (_, i) => change(`n_${i}`, ["note/title"], i + 1)));

    expect(journal.reads).toBe(1);
    expect(dispatcher.stats().touched).toBe(500);
  });
});

describe("dependency-indexed dispatch: journal gaps", () => {
  it("touches every subscription after a load replaces the journal", () => {
    const journal = testJournal();
    const { dispatcher, notified, order } = harness(journal);
    dispatcher.add({ id: 1 }, { components: ["note/title"] });
    dispatcher.add({ id: 2 }, { models: ["other"] });

    journal.reset(5);

    expect([...notified].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("touches every subscription whose cursor fell below the change floor", () => {
    const journal = testJournal();
    const { dispatcher, notified } = harness(journal);
    dispatcher.add({ id: 1 }, { components: ["note/title"] });

    journal.publish([change("n_1", ["other/title"], 1)]);
    expect([...notified]).toEqual([]);

    // The retained window moves past what the entry has been dispatched
    // through, so a batch can no longer be narrowed for it.
    journal.trim(2);

    expect([...notified]).toEqual([1]);
  });

  it("does no index work when nothing is registered", () => {
    const journal = testJournal();
    const { dispatcher } = harness(journal);
    journal.publish([change("n_1", ["note/title"], 1)]);
    expect(journal.reads).toBe(0);
    expect(dispatcher.stats()).toEqual({ touched: 0, lookups: 0, scanWork: 0 });
  });
});
