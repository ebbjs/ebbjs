# Replica access for non-writers (#970)

Design note for [issue #970](https://github.com/ebbjs/ebbjs/issues/970), a slice of the
[leaner client replica epic #965](https://github.com/ebbjs/ebbjs/issues/965). It answers the
issue's comparison — call the writer for reads, or keep a local index and follow the writer's
change journal — and writes the interface [issue #986](https://github.com/ebbjs/ebbjs/issues/986)
builds against. The decision itself is recorded in
[ADR 0004](../adr/0004-non-writers-read-a-mirrored-row-index.md). Labels: **[measured]** (from
#966), **[from source]** (read off the code), **[decision]**.

**Sources read.** #965 (the "In memory" list and the rules), #968/ADR 0002, #969/ADR 0003, and
#971, #972, #973, #975, #976, #977, #978, #979, #980, #982, #985, #986, #987. Code:
`packages/storage/src/replica/{types,replica,content-changed}.ts`,
`packages/storage/src/internal/{materialize,component-index,reverse-index}.ts`,
`packages/client/src/sync/{query-execute,query-plan,query-cache,subscriptions,dependency-index,query-builder,namespace,client,scope-eviction,status}.ts`,
`packages/storage/src/types/{entity-store,replica-store}.ts`. Numbers: #966.

## TL;DR

- **[decision] A reader mirrors the row index and follows the writer's change batches.** Reads and
  filters stay synchronous and local in every instance (ADR 0002), and no read waits on the writer
  tab being scheduled. Calling the writer for reads was rejected on exactly that dependency.
- **[from source] The read path is already index-shaped, so a mirror is not a second engine.** `PlanExecutor`
  is five reads (`scan`, `get`, `relationships`, `memberships`, `components`), and the result cache,
  the subscription registry and the dispatcher use only `Replica`'s read half
  (`revision`, `changeFloor`, `changesSince`, `subscribe`, `get`, `iterate`,
  `isComponentResident`, `residentComponents`, `acquire`, `relationships`, `memberships`,
  `components`, `componentVersion`, `membershipLinks`). The two that do not fit are writer-side or
  already condemned: `stats()` belongs to scope eviction and the writer, and `fullyResident` is what
  #981 deletes. One new step beside `ingest` — `mirror(entries, changes)` — is the whole seam.
- **[decision] One unit crosses the boundary:** the row index entry — #971's `RowEntry`, which is
  also the element of #977's row-list snapshot. A batch carries the writer's own `ReplicaChange`s
  plus the entries of the rows whose index moved. The reader classifies nothing and folds nothing;
  it runs the writer's own `index.set` over the entry.
- **[decision] Values the index does not hold come from the durable store** (#980), read-only for a
  reader. Nothing about a value crosses the boundary.
- **The price is one row index per tab.** **[measured]** 3.8 MB of JSON and 13.6 MB of V8 heap at
  20,001 rows, and on #966's title-and-link fixture that is the whole base — the mirror saves
  nothing there, because every value in it is index-resident. The epic's motivating shape is the
  opposite: a 64 KiB body is a keyed `updates` log, so it is not in the index and not mirrored.
  #989 and #975 now buy per-tab memory, not just the writer's.
- **[from source] Handover needs no replay**, because the promoted instance's mirror is already the
  row index: it adopts it as its base and resumes from the last published log position.

## What a reader needs, and who owns it

| what                             | owner                                          | how a reader gets it                    |
| -------------------------------- | ---------------------------------------------- | --------------------------------------- |
| stream, fold, materialization    | writer                                         | —                                       |
| row index                        | each instance, mirrored                        | baseline, then batches                  |
| change journal                   | each instance (its own retained window)        | the writer's `ReplicaChange`s, verbatim |
| a value the index does not hold  | the durable store (#980)                       | a component read, `readComponent` today |
| unconfirmed writes               | each instance, durably in its outbox partition | its own overlay; the writer drains      |
| session (actor, groups, cursors) | writer                                         | the baseline's session fields (#986)    |

## The comparison

### A — call the writer for reads

The reader keeps projected results and sends each query to the writer, which runs it and sends the
rows back.

This is the smallest per-tab memory: **[measured]** a released 10,000-row result is 0.7 MB of JSON,
and the index exists once instead of once per tab. It also has one implementation of query
semantics, so two tabs cannot disagree about a filter.

It fails on three things:

1. **Reads depend on another tab's scheduler.** Browsers throttle hidden tabs and can freeze them;
   the writer is the tab the browser is most entitled to freeze. A foreground tab would be unable to
   answer a filter it could answer itself. Whatever mechanism #985 elects with, a reader cannot rely
   on the writer being scheduled.
2. **One thread runs every tab's queries**, and that thread is also applying the stream. A write
   batch that invalidates four live results in each of three tabs is twelve re-runs on the writer's
   main thread; each is a 1.5–2.8 ms resident scan plus its sort **[measured]**.
3. **A round trip per re-run**, plus a protocol for patch/invalidate per result surface — the same
   protocol work as the feed, with worse latency.

### B — mirror the index and follow the change journal

The reader keeps the row index, applies the writer's batches to it, and runs the existing engine.

Per-tab cost is the index: **[measured]** 3.8 MB of JSON, 13.6 MB of heap at 20,001 rows, of which
the version stamps and the repeated id and component strings are the parts #989 attacks. That cost
is the price ADR 0002 already accepted for a synchronous filter, paid per instance instead of once.

### Why B

Reads are the thing a tab must be able to do by itself. A mirror keeps that true while the writer is
frozen, backgrounded, or being replaced, and it keeps each tab's work on its own thread. The memory
option A saves is the index, and on a scalar-and-link model the index _is_ most of the base, so the
saving is smaller than it looks while the coupling is absolute.

The measured cost, by shape:

| shape                                | writer                            | reader under B                                      | reader under A               |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- | ---------------------------- |
| #966 fixture, 20,001 rows, no bodies | 11.7 MB of JSON / 31.9 MB of heap | 11.7 MB of JSON (nothing leaves)                    | 0.7 MB per 10,000-row result |
| epic's 500 × 64 KiB bodies           | index only; bodies leave          | rows + index + atomic values; bodies never mirrored | results only                 |

**Read the first row honestly: this pick buys nothing on a scalar-only model.** Every value there is
index-resident, either because a filter may read it or because it feeds edges (`ebb/link`, 2.3 MB of
the fixture's 5.7 MB of values) **[measured]**. The win is the keyed component — a body, a log, an
archive — which is the epic's measured 42.4 MiB. #989 (intern ids, numeric edge keys) is what
shrinks the part B adds; #992's budget is what bounds values once this lands.

## The design

### One replica, two index sources

The same module, with the fold replaced by a mirror:

```
writer: ingest(action, delta, position)  →  materialize  →  entryOf(row) → index.set → journal
reader: mirror(batch)                    →                 index.set(entry)            → journal
```

The derivation is #971's, not a second one: `entryOf(row)` turns a materialized row into the entry,
and `index.set(entry)` diffs it against the previous entry and moves the derived model, component,
edge and membership maps. The writer already has that shape as `reconcileIndex`/`publish` in
`packages/storage/src/replica/replica.ts`; #971 extracts it. Both sides run the same `set`, which is
what makes a reader's index the writer's index by construction rather than by agreement. A mirror replica is the same
structure with the index fed by entries instead of the fold, plus #973's carried set separate from
values and #972's residency rule for the copies it holds.

A reader still applies **its own** unconfirmed Updates optimistically (`optimistic`/`discard`,
unchanged) over its mirror. That is a local write, not the stream: no create, placeholder, LWW or
backfill logic runs in a reader.

### The feed

The writer publishes:

- **a baseline** for a joining reader — `{ seq, position, revision, entries }`, taken in one
  synchronous turn so nothing can land in the middle;
- **a batch** — `{ seq, position, revision, changes, entries }` — covering one or more published
  revisions, where `changes` is the writer's own classification (`content` naming the components it
  touched, or `membership` naming the models the row entered or left) and `entries` holds the final
  state of every row whose index moved in that batch.

Three properties fall out:

- **The revision means the same thing on both sides.** The reader keeps each change's own `revision`
  and adopts the batch's `revision` as its current one, so `run.at === replica.revision`,
  `changesSince`, `changeFloor` and every subscription cursor carry over unchanged.
- **A gap is measured by `seq`, not by revisions**, because a batch coalesces several revisions. A
  reader that sees `seq > last + 1` re-joins from its revision.
- **A diff's answers are current state, not history.** A reader that joins at revision R0 while the
  writer is at R5 gets the entries _as they now stand_ for every id changed since R0, plus all the
  changes. Intermediate states are skipped by construction, which is correct because an entry
  replaces the reader's, and a change list is a union.

`join(from)` can be answered from a diff while `from >= changeFloor` — the replica's existing
journal, no new retention knob — and from a baseline below it. That is #987's "stale change
journal" case, and it is the existing `load` gap: the index is replaced, the journal resets, and
every subscription re-runs.

### Values

A reader reads the components its index does not hold from the durable store, through the seam
`ReplicaOptions.readComponent` already is. That keeps the cold path working with no writer at all,
and it means the store — not the writer's memory — is the shared source of truth for values.

It also imposes the one ordering rule the writer must keep: **a revision is published only after the
values it names are durable**. Then a reader at revision R can serve R's values, and a writer can die
at any point without a reader waiting on it. #980's per-component write is where that lands.

### Unconfirmed writes and the outbox

ADR 0003 leaves the outbox to the instance that made the write, and that is what keeps offline writes
working: a reader appends its Action to its own outbox partition durably, applies its own overlay,
and the writer drains every partition in a stable order. A confirmation or a rejection comes back on
the feed as a status for that Action id, and the instance drops its overlay then — the same
`discard` path `reMaterializeFromLog` uses today.

Peers do not see a pending write. From another tab it is indistinguishable from the same write
arriving over the stream one round trip later, and it keeps the overlay from becoming broadcast
state. The submitting instance sees its own write immediately, which is the case that matters.

### Handover

A promoted reader keeps doing what it was doing and starts writing: its mirror becomes its base, it
resumes the stream from the last published `position`, and it drains the partitions it can see. Other
readers re-join it with `{ revision }` — a diff if they are above its floor, a baseline if not. No log
replay, no reload.

A reader that is reloaded is a new reader and takes a baseline. A writer that is reloaded recovers
through `loadReplica` exactly as today, and its revision continues from the persisted record, so a
reader's revision stays comparable across the restart.

## The interface

The types the feed carries, the seam a reader implements, and the split of `Replica`. Names are
provisional except where #990 owns them; "replica access" is that issue's term for this interface.

```ts
/**
 * The feed's unit is #971's `RowEntry` — the object the row index stores and the element #977
 * persists. It crosses an instance boundary, so it stays plain data: no `Map`, no class, no
 * function, and no derived field that `index.set` rebuilds.
 */

type FeedMessage =
  | {
      readonly kind: "baseline";
      readonly seq: number;
      readonly position: number;
      readonly revision: Revision;
      readonly session: SessionFacts;
      readonly entries: readonly RowEntry[];
    }
  | {
      readonly kind: "batch";
      readonly seq: number;
      readonly position: number;
      readonly revision: Revision;
      readonly changes: readonly ReplicaChange[];
      /** Final state per id; a change that moved no index entry carries none. */
      readonly entries: readonly RowEntry[];
    }
  | {
      readonly kind: "action";
      readonly actionId: string;
      readonly status: "committed" | "rejected";
      readonly gsn: number | null;
    };

/** Writer → reader. An absent `from` asks for a baseline. */
interface IndexFeed {
  join(from?: { readonly revision: Revision }): void;
  leave(): void;
  subscribe(listener: (message: FeedMessage) => void): () => void;
}

/** Reader → writer. The Action is already in the instance's own outbox partition. */
interface ActionSink {
  submit(action: Action): void;
}
```

On the replica, one new step, and the split the seams already imply:

```ts
/** What the engine, the registry and the result cache read. Unchanged. */
interface ReplicaRead {
  readonly revision: Revision;
  readonly changeFloor: Revision;
  get(id: string): Entity | undefined;
  iterate(model: string): readonly Entity[];
  isComponentResident(id: string, component: string): boolean;
  residentComponents(id: string): readonly string[];
  componentVersion(id: string, component: string): number | undefined;
  read(id: string, components: readonly string[]): Promise<Entity | null>;
  acquire(id: string, components: readonly string[]): Promise<Release>;
  changesSince(revision: Revision): readonly ReplicaChange[];
  relationships(query: RelationshipQuery): readonly string[];
  memberships(query: MembershipQuery): readonly string[];
  components(component: string): readonly string[];
  subscribe(listener: () => void): () => void;
}

/** Writer only: the fold, the overlay, persistence. */
interface ReplicaOwner extends ReplicaRead {
  ingest(action: Action, delta: readonly Update[], position: number): Revision;
  optimistic(action: Action): Revision;
  discard(actionId: string): Revision;
  load(record: ReplicaRecord): Revision;
  toRecord(): ReplicaRecord;
  evict(ids: readonly string[]): Revision;
  stats(): ReplicaStats;
  bytes(): ReplicaBytes;
}

/** The seam a reader implements, beside `ingest`. */
interface ReplicaMirror {
  mirror(batch: Extract<FeedMessage, { kind: "batch" }>): Revision;
}

const createMirrorReplica: (options: {
  readonly readComponent: (id: string, component: string) => Promise<Entity | null>;
  readonly versions?: ComponentVersionPolicy;
}) => ReplicaRead & ReplicaMirror;
```

A host with one instance implements `IndexFeed` as a constant: the reader _is_ the owner, `join` is a
no-op, and `mirror` never runs. That is #985's single-peer default applied to reads, and it is what
keeps mobile and one-tab web on exactly today's path.

## Invariants

1. **Durable before announced.** A revision is published only after the values it names are durable,
   so a reader at that revision can serve them and a writer can die at any point.
2. **The feed carries the index, not the fold.** Entries plus the writer's own changes, never
   Actions. A reader classifies nothing and materializes nothing; its only derivation is the
   `index.set` both sides run.
3. **Revisions are the writer's.** A change keeps the revision it was journalled at; a batch reports
   its newest. Subscription revisions compare across instances.
4. **A baseline is atomic.** One synchronous turn in the writer produces `seq`, `position`,
   `revision` and the entries, so a joining reader cannot race a batch.
5. **Sequence numbers, not revisions, detect a gap,** because a batch coalesces revisions.
6. **Below the floor is a `load`,** not a diff: index replaced, journal reset, every subscription
   re-runs.
7. **The entry is the set of values a query may read.** A component outside it is projection-only,
   and its absence fails loudly (#974).
8. **Residency and claims are per instance.** A claim never crosses the boundary, so a reader's
   leases cannot keep or drop the writer's values.
9. **The overlay is instance-local.** A peer sees a write when it is confirmed, never before.
10. **One writer writes the store** (ADR 0003). A reader reads it and writes nothing but its own
    outbox partition.

## Failure cases (#987)

| case                            | what happens                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader below the writer's floor | baseline; index replaced; every subscription re-runs. The same path as a journal gap today.                                                                                                         |
| writer killed                   | reads continue from the mirror; results stay usable at the last batch. #985 elects a new writer; readers re-join with `{ revision }`.                                                               |
| handover                        | the promoted reader adopts its mirror as its base, resumes the stream from the last `position`, drains every outbox partition; peers diff or take a baseline.                                       |
| page restore                    | a restored reader is a new reader: baseline, then batches. A restored writer uses `loadReplica` and keeps its revision, so peers' revisions stay comparable.                                        |
| writer frozen but alive         | reads continue from the mirror; a reader's writes land durably in its own partition and show immediately; confirmations, conflicts and new values wait. The feed's health is what `status` reports. |
| reader offline                  | reads are the mirror's; writes queue in its own partition. A cold value read fails loudly (#974) rather than projecting a partial row.                                                              |

One wart worth stating: a mirror's `revision` is a lower bound on the writer's, so a result can be
`current` at an instance that has missed every batch since its last one. The existing
`ClientStatus`/`ConnectionState` surface is where that truth belongs — the feed's health is the
connection, and the replica's revision is not a promise about the writer's.

## What #986 builds, and what a reader does not do

Builds: the split above, `createMirrorReplica`, the single-instance `IndexFeed`, the web transport
(#985's coordination is the same seam), and the reader's client wiring — no stream, no fold, no
`loadReplica`, no `persistReplica`, no scope eviction, no backfill, no seed, no group listing. Those
stay writer-only, and the writer's effects reach a reader as entries and changes like any other.

Two durable-store reads stay available to a reader because they read only the store: `history()` and
`replay()` (the Action log, today at `packages/client/src/sync/history.ts`).

## Open questions

- **Baseline over the channel, or from the durable row-list snapshot?** v1 is the channel: always
  correct, no new coupling. A reload is then a full baseline transfer — 9.1 MB in the fixture
  **[measured]**, though the entry count, not the bytes, is what matters. #977 writes exactly this
  snapshot to the store, so a later version can load it locally and join with `{ revision }`. Worth
  doing only if a join is measured to be visible.
- **Who owns the session?** The writer runs `handshake`, so actor id, groups, scope and cursors are
  its. The baseline should carry them so a reader's `client.handshake()` can answer from it. #986
  decides the surface; the writer is the only correct source.
- **Holding a value across its own confirmation.** When a reader's unconfirmed write to a keyed
  component is confirmed, the entry stops carrying the value and the overlay stops supplying it, so
  the value would leave until the next claim. Leasing it for one grace period on confirmation keeps
  a visible row from flashing empty. #986 detail.
- **Cross-partition drain order.** The writer drains every instance's outbox partition; a stable
  order (instance, then entry sequence) makes two tabs' concurrent writes reproducible in tests and
  ties on HLC resolve the rest. #986 detail.
- **The mirror's scope.** Unscoped in v1: a reader mirrors every row the writer has. If a tab's index
  is measured to be the cost, the feed grows a model filter and a reader fetches an unseen entry on
  demand — a small extension of the protocol, and the reason the entry is the unit rather than a
  whole-store payload.
- **Naming.** `ReplicaAccess` is taken by the namespace binding
  (`packages/client/src/sync/namespace.ts:513`), which is really an entity-read binding. #990 owns
  moving the name to this interface.

## References

- [ADR 0002 — rows exist without their values in memory](../adr/0002-rows-exist-without-values-in-memory.md)
- [ADR 0003 — one writer per local store](../adr/0003-one-writer-per-local-store.md)
- [ADR 0004 — a non-writer reads through a mirrored row index](../adr/0004-non-writers-read-a-mirrored-row-index.md)
- [966 — per-tab memory by category](966-memory-by-category.md)
