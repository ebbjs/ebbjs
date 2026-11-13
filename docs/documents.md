# Documents

A **document** is an entity whose content is an engine-specific log. Ebb stores
an append-only map of opaque entries; it never interprets them. A document
engine (plain text, Yjs) is a package export built on the platform's one
primitive, not a concept the platform knows about.

This is the contract behind #775 and its sub-issues, plus the relationship
model it depends on (#790). It is written before the engine packages exist so
the boundary can be tested rather than argued.

Status: `e.log`, the opener, and the presets are planned in #775. `contained`
and first-class link membership are #790; until that lands, a relationship
keeps the group it was written under (#789).

## The boundary

`@ebbjs/core`, `@ebbjs/schema`, `@ebbjs/write`, `@ebbjs/storage`, and
`@ebbjs/client` contain:

- no import of `@ebbjs/text` or `@ebbjs/yjs`;
- no reference to a document's log or metadata field names;
- no branch on an entry's shape.

If those hold, a document engine is a preset. The merge rule, the storage
adapter, the server, and the client stay engine-agnostic.

## The primitive: an append-only log

```ts
e.log(entrySchema); // a map field whose entries may only be added
```

| Property    | Rule                                                                  |
| ----------- | --------------------------------------------------------------------- |
| Wire shape  | an ordinary map field; no new merge rule                              |
| Entry key   | minted by the writer, opaque to the platform                          |
| Entry value | whatever `entrySchema` declares                                       |
| Write       | may only add keys; a rewrite is refused before queueing               |
| Tombstones  | refused; a log expresses removal as a new entry                       |
| Conflict    | none per position: two writers never mint the same key                |
| Read        | projected as a plain record, like any map field                       |
| Order       | none at the platform level; the engine orders its own entries         |
| Retention   | none; compaction is the app's or a later primitive's job (#123, #665) |

`e.bytes()` will be the honest entry leaf once #664 lands and `cloneValue`
handles typed arrays. Until then a Yjs log stores base64 strings.

## The presets

An engine package exports an `ModelDef` factory and a codec. The app names the
entity and declares the relationship, so it owns the permission string,
cardinality, and group structure.

```ts
import { plainTextDocument } from "@ebbjs/text";

const body = plainTextDocument("note_body"); // ModelDef
const schema = defineSchema({
  models: { note, note_body: body },
  relationships: {
    body: defineRelationship({
      source: note,
      target: body,
      as: "body",
      sourceCardinality: "one",
      contained: true,
    }),
  },
});
```

Preset shape:

```ts
defineModel(
  "note_body",
  {
    engine: e.string().default("ebb.cells.v1"), // written once at create
    version: e.number().default(1), // format version inside the codec
    content: e.log(TextCellSchema), // or updates: e.log(e.string())
  },
  { materialization: "on-demand", conflictScope: "field" },
);
```

## The codec contract

Two engines must fit one interface, or the primitive claim is wrong.

```ts
interface DocumentCodec<State> {
  /** Codec id written once into the row's `engine` leaf. */
  readonly engine: string;

  /** Entries a fresh document starts with. */
  create(initial?: unknown): Record<string, unknown>;

  /** Full log → engine state. */
  load(entries: Record<string, unknown>): State;

  /** Merge newly observed entries. Idempotent. */
  apply(state: State, entries: Record<string, unknown>): { state: State; changed: boolean };

  /** New entries for local changes since the last flush. */
  localChanges(state: State): Record<string, unknown>;

  /** The app-facing view: text, ProseMirror doc, spans. */
  project(state: State): unknown;
}
```

The provider is generic:

```text
get(id) ─► read row.<log> ─► codec.load ─► state
row.subscribe ─► codec.apply(entries) ─► state ─► project
local change ─► codec.localChanges ─► app-declared append(entries) ─► optimistic write
             └─ the echo arrives through the row ─► codec.apply (idempotent)
unloaded / close ─► stop applying; re-open reloads the log
```

Decisions this fixes:

1. **The provider owns the flush boundary: an idle debounce with a maximum
   wait.** Default 250 ms idle and 1 s maximum, configurable; a continuous
   typist still flushes within the maximum. `provider.flush()` is the explicit
   boundary for an editor that wants one, and the outbox's network cadence is
   not the boundary — entries must be durable before delivery matters. Cells
   may coalesce unsubmitted edits into one run; Yjs emits one delta per flush
   (#773). The boundary lives in neither engine package.
2. **The app declares the write.** `defineAction` is the only write path and
   actions are module-scope, so the provider takes `append(entries)` as a
   parameter. Engines ship no runtime submit.
3. **A mismatch fails loudly.** On open, the provider compares `row.engine` to
   `codec.engine`; an unknown or different codec throws (#698). Never project a
   log with the wrong decoder.
4. **Idempotence is the codec's obligation.** Re-applying the local echo is a
   no-op.
5. **Dirty state is the provider's obligation.** Flush before close or unmount.
   Eviction never loses state; destroying a dirty provider does.
6. **Open reads the full log, then deltas.** Snapshots are a later
   optimization, not part of the contract.

### Traces

| Step         | Plain text (`ebb.cells.v1`)         | Yjs (`yjs.update.v1`)                                 |
| ------------ | ----------------------------------- | ----------------------------------------------------- |
| create       | root run + version                  | empty log + version                                   |
| load         | project cells                       | `Y.applyUpdate` per entry                             |
| remote entry | merge cell, re-project              | apply update (idempotent)                             |
| local change | new run / cut cell                  | `Y.Doc` mutation                                      |
| flush        | open run coalesced into one cell    | `Y.encodeStateAsUpdate(doc, stateVector)` → one entry |
| echo         | key already present → no-op         | same update re-applied → no-op                        |
| unloaded     | drop projection, keep the row cache | drop the provider; `Y.Doc` is rebuilt on re-open      |
| mismatch     | `engine !== "ebb.cells.v1"` → throw | `engine !== "yjs.update.v1"` → throw                  |

## Opening a document

There is no document opener. A document is an on-demand entity, and the
ordinary namespace opens it:

```ts
const row = await client.note_body.get(id); // opens and pins the row
row.subscribe((event) => {
  if (event.type === "unloaded") showReloadAffordance();
});
```

Read rule: held types read via `query()`, on-demand types read via `get(id)`.

A subscription reports its own closure. `close()`, the pin TTL, and capacity
eviction all deliver one `unloaded` event; re-open with `get(id)` and replay.
Eviction is recoverable because the log is append-only. The pin capacity
default will be raised well above the current 16; the exact number is a tuning
value, and eviction stays observable either way.

## Conflicts

The only declaration is `conflictScope`, read per component:

| Scope         | Detection                              | Outcome                                  |
| ------------- | -------------------------------------- | ---------------------------------------- |
| `"field"`     | overlapping positions in missed window | merge; surface slots                     |
| `"component"` | any concurrent touch of the component  | hold that component; surface its slot    |
| `"entity"`    | any concurrent touch by another actor  | hold the row's writes; report            |
| `"none"`      | never (a structural component)         | converge last-writer-wins; never surface |

A log field never mints colliding keys, so a field-scope document has no
conflicts. Entity scope is the app's choice, not a document requirement.

The platform holds and reports; the app decides. The report carries the scope,
per-subject before/after rows with a field-path diff, slots, held Actions
verbatim, and remote actor/action/GSN context.

Resolution verbs describe mechanism:

- `sendLocalActions` — clear the hold and flush the held Actions unchanged.
  Correct for append-only logs.
- `clearLocalActions` — drop the held Actions and converge on remote.

There is no `retry`. Re-stamping recursed into map entries and rewrote each
entry's `update_id`/`hlc`, corrupting log provenance. "Make my scalar value
win" is a normal write through `defineAction` with a fresh clock.

## Engine and codec

`engine` is one leaf: a codec id including its format version. It is written
once at create and never rewritten. A format change is a new codec, and an
upgrade is a copy into a new document, not an in-place rewrite. This is what
keeps a version/backup readable after the app's codec moves.

base64 is `yjs.update.v1`; bytes will be `yjs.update.v2` (#664). Old documents
keep decoding as v1 because the row carries its codec. No storage reset.

## Deletion

There is no automatic deletion cascade in v1. A document and its versions are
retained when their parent is deleted: that is the safe default for user
content, and it can be recovered. An app that wants cascade/block/nullify
deletes the related rows in the same Action (`drafts.delete` is a verb), or
waits for the optional lifecycle hook in #156.

## Relationships

A note's body and versions are links. Two separate ideas:

- **Containment** (`contained: true`) means the target is part of the source's
  access scope, so a group change on the source files the target into the same
  groups, in the same Action. It is declarative and one hop: no transitivity.
- **Link membership** is **source-owned**: a relationship is visible wherever
  its source is. It is not intersection-scoped, so a group can see a link to a
  target it cannot read.

Link membership becomes a property of the relationship row itself in #790:
relationships own their `entityGroup` rows like any other entity, and backfill
covers them. Until then a link keeps the group it was written under (#789).
Containment and link membership are separate jobs; #790 changes the second
without changing the first.

## Non-goals

No `noteVersion`/`backup` entity type; no Yjs-aware conflict semantics; no
three-way merge; no forced backup policy; no derived-body expansion; no
document interpretation on the server; no editor binding in core.

## References

#775 (documents epic), #776 (delete derived bodies), #778 (`e.log`), #779
(opener and `unloaded`), #780 (this contract), #781 (conflicts), #783
(`@ebbjs/text`), #785 (`@ebbjs/yjs`), #789 (link-scope bug), #790
(relationships own their membership), #156 (delete lifecycle), #123 (retention),
#664 (bytes), #665 (payload store).
