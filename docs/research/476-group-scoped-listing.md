# Group-scoped entity listing for cold bootstrap (#476)

Design-research note for [issue #476](https://github.com/ebbjs/ebbjs/issues/476), slice of
[epic #472](https://github.com/ebbjs/ebbjs/issues/472). It answers the questions the proposal leaves
open; it does not restate it.

**Sources read.** #476, #475 (body **and** the shipped client code), #473, #474, #472, #441, #461,
#462; `ebb_server/lib/ebb_server/sync/{router,catch_up,sse_handler,fan_out_router}.ex`;
`ebb_server/lib/ebb_server/storage/{sqlite,entity_store,watermark_tracker,commit_pipeline,writer,gsn_counter,system_cache,group_cache,entity_group_cache,dirty_tracker,entity_index,action_scope,action_log,permission_checker,permission_helper,rocks_db}.ex`;
`ebb_server/bench/RESULTS.md`; `ebb_server/test/ebb_server/{sync/{handshake,catch_up,entity_query}_test.exs,storage/entity_store_query_test.exs}`;
`packages/storage/src/{replica/replica.ts,replica/types.ts,internal/{materialize,reverse-index}.ts,indexeddb/{action-log,cursor-store,schema}.ts,types/{action-log,cursor-store}.ts}`;
`packages/client/src/sync/{client,backfill,entity-group,scope-eviction,operations,types}.ts`; house
style `docs/research/{503,485}-*.md`. `file:line` is the working tree at `e155062`.

Labels: **[from source]** (`path:line` or issue), **[measured]** (reproduced here), **[derived]**
(reasoning over sourced facts), **[unknown]** (not established; what would settle it is named).

---

## TL;DR

- **The SQLite read model materializes user types lazily, not at boot.** System types are rebuilt
  from RocksDB at boot except `group` (`system_cache.ex:147-160`, `420-490`, `497-512`; `group` is in
  `permission_helper.ex:34` but not among the populators), and a user-type row is materialized only
  when that entity is read (`entity_store.ex:93-110`, `681-696`). So an entity nobody has read has no
  row, and the listing's per-entity cost is O(that entity's own history) — paid once per entity per
  data dir, not once per client **[from source]**.
- **The listing must force materialization per row, not consult `dirty?/2`.** The SQLite file
  (`<data_dir>/ebb.db`, `sqlite.ex:235-239`) outlives the process, but dirty marks live in ETS
  (`dirty_tracker.ex:46-53`) and boot re-materializes system types only. A user row that was dirty at
  shutdown therefore returns as clean-but-stale, and `get/3` keeps serving it; a row never materialized
  before the restart is `:not_found` instead **[measured]** (restart test: a committed patch read back
  at `last_gsn 1` with the old field, durable log at 2). Seeding such a row at W makes it permanent for
  the client, because the tail starts above it. Filed as #564.
- **`MAX(last_gsn)` over the group's rows is not the watermark.** A row's `last_gsn` _does_ cover
  deletes and membership rows, but a row-derived W is only sound when every contributing row was
  materialized **and** the MAX is taken **before** page 1. The cheap correct definition is the
  **resolution frontier read once, before any row is returned** **[derived]** (§2).
- **The read model is not a snapshot at any GSN** — per-entity states at differing log positions,
  mutated by the read path itself; per-statement consistency is all you get (one GenServer connection,
  WAL, implicit per-statement transaction) **[from source]** (`sqlite.ex:58-64`, `234-260`;
  `entity_store.ex:202-246`).
- **No index serves group → entities**, and the row set is wider than `entityGroup`: `group` and
  `groupMember` rows carry no membership row **[from source]** (`sqlite.ex:90-94`,
  `sync/operations.ts:308-311`, `sync/scope-eviction.ts:52-68`). §4 lists the two indices needed.
- **A new endpoint is the only shape that fits** (§5): `POST /entities/query` returns a bare array (no
  room for W), requires a `type`, and authorizes per entity rather than per group **[from source]**
  (`router.ex:132-163`, `sqlite.ex:406-421`).
- **#475 does not hand #476 its contract** (§6.2): no cursor write, no bulk seed, no transaction across
  log + cursor, and it only ever fetches `entityGroup`-referenced ids **[from source]**. Cursor
  validity is meanwhile unexercised — the SDK sends `cursors: {}` (`client.ts:588-590`) and
  `reason: "behind_watermark"` fires when the cursor is _ahead_, the opposite of the client's doc
  **[from source]** (`router.ex:193-208`, `sync/types.ts:47-56`).

---

## 1. Current model

One table, discriminated by `type`; no separate membership tables. Deletes are tombstones: `apply_delete`
sets `deleted_hlc`/`deleted_by` and leaves `data` intact **[from source]** (`entity_store.ex:524-532`), so
the generated `entity_id`/`group_id` columns stay populated on a deleted membership row. Nothing GCs
rows or the action log (`action_validator.ex:51-52`) **[from source]**.

DDL (`ebb_server/lib/ebb_server/storage/sqlite.ex:68-95`) **[from source]**:

```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT,
  created_hlc INTEGER NOT NULL, updated_hlc INTEGER NOT NULL,
  deleted_hlc INTEGER, deleted_by TEXT, last_gsn INTEGER NOT NULL,
  entity_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.entity_id.value')) STORED,
  group_id  TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.group_id.value'))  STORED,
  … );                       -- 8 generated columns total (sqlite.ex:78-85)
CREATE INDEX idx_entities_type            ON entities(type) WHERE deleted_hlc IS NULL;
CREATE INDEX idx_entities_type_gsn        ON entities(type, last_gsn);
CREATE INDEX idx_entities_source_id       ON entities(source_id) WHERE type='relationship' AND deleted_hlc IS NULL;
CREATE INDEX idx_entities_group_member    ON entities(group_id, actor_id) WHERE type='groupMember' AND deleted_hlc IS NULL;
CREATE INDEX idx_entities_entity_group    ON entities(entity_id, group_id) WHERE type='entityGroup' AND deleted_hlc IS NULL;
```

Resolution rules (`entity_index.ex:96-129`) **[from source]**: `group` → its own id; `groupMember` and
`entityGroup` → their `group_id`; `relationship` → its **source's** membership, never its target;
user types → their live `entityGroup` rows.

**Materialization is exact but lazy.** The scan is keyed on `entity_id` over `cf_entity_actions`,
replays in GSN order and writes back monotonically (`WHERE excluded.last_gsn >= entities.last_gsn`,
`sqlite.ex:107`) **[from source]** (`entity_store.ex:273-291`). For a **materialized** row,
`last_gsn = max{gsn(A) : A durable and touches this row}` — an exact per-row log position; for a
**dirty** row it is a stale lower bound. That distinction is the whole of §2. `EntityStore.get/3`
guarantees only "no clean-but-stale read" (provisional dirty marks, `writer.ex:1175-1183`,
`entity_store.ex:1-40`); it never promises two reads agree. The group→entity ETS indices
(`EntityGroupCache.group_entities/2`, `GroupCache.group_member_ids/1`) are rebuilt from the type index
at boot and then mutated by the Writer (`system_cache.ex:420-429`, `444-461`, `497-512`);
`group_entities/2` has no production caller and both hold ids only, never row content — they are an
enumeration option (§4.4), not a read model.

**What survives a restart [from source].** The SQLite file at `<data_dir>/ebb.db` (`sqlite.ex:235-239`)
persists, and boot re-materializes the system types in `populate_type` — `groupMember`, `entityGroup`,
`relationship` (`system_cache.ex:420-490`) — so a restarted server does **not** have a cold read model
for memberships. `group` and the user types are lazily materialized, and their dirty marks do not
survive: `DirtyTracker` owns an ETS table and nothing re-marks them at boot (`dirty_tracker.ex:46-53`;
`populate_entity_types` walks `cf_type_entities` for the type cache only). A row dirty at shutdown is
clean-but-stale afterwards, and `EntityStore.get/3` will not repair it because `DirtyTracker.dirty?/2`
is false **— [measured]**: a committed patch never read before the restart came back as `last_gsn 1`
with the pre-patch field, while the durable log held GSN 2; a forced `materialize/2` returned the
patched row. A second entity committed and never read came back `:not_found`. The throwaway test
stopped Writer, SQLite and RocksDB, restarted them on the same dirs with an empty dirty set, and ran
`SystemCache.populate_system_caches/1`; no boot path repairs lazy rows (`populate_type` covers three
system types, `populate_entity_types` fills the type cache only, and SQLite's `last_gsn` is never
compared to `RocksDB.get_max_gsn()`). This contradicts the documented "no eventual consistency window"
read guarantee (`ebb_server/README.md:632-634`) and is tracked as #564. For #476 it is a correctness
constraint, not a performance one: the listing must **materialize every page row unconditionally**, or
a seeded row can be stale at a W the tail will never revisit. Only a fresh data dir (new deployment,
lost volume, never-read entity) is actually cold.

---

## 2. What W can be

The client needs one sentence: **every effect with `gsn <= W` that the group's view can observe is in
the seed; every durable Action with `gsn > W` arrives by tail.** Two facts drive every candidate:
(a) the server's row is the entity's **global** state, not a group-scoped projection — content written
at GSN 5 in group A and filed into G at GSN 200 is seeded _with that content_ **[from source]**
(`entity_store.ex:273-291`: keyed by `entity_id`, not by group), which is why this can be complete at
all; (b) a dirty row's `last_gsn` is a stale lower bound, so a row-derived watermark only says
something about _materialized_ rows **[derived]**.

`last_gsn` **does cover deletes and membership rows**: a tombstone keeps its `data` and generated
columns, and its `last_gsn` is the delete's GSN (`entity_store.ex:373-380`, `524-532`) **[from source]**.
What a row-derived W cannot see is a row that has not been materialized yet, or a commit that lands
between two page reads — both are timing problems, not coverage problems.

| #   | candidate                                                                                                 | means                                                          | durable across restart                                                             | covers deletes / membership rows                                 | GSN holes                              | cost                                                          | verdict                                                                                |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A   | `MAX(last_gsn)` accumulated over the pages' rows, as they are read                                        | newest folded action seen                                      | yes                                                                                | per row yes; **timing** no — a commit between pages is invisible | unaffected                             | O(group)                                                      | **broken** (the natural implementation)                                                |
| A′  | `MAX(last_gsn)` over the group's rows at one instant, after a whole-group materialize pass, before page 1 | certified per-row position                                     | yes                                                                                | yes                                                              | unaffected                             | O(group) + full materialize barrier                           | correct, but a barrier B does not need, and a smaller W                                |
| B   | `WatermarkTracker.committed_watermark()` read **once, before the first row**                              | resolution frontier: every GSN ≤ W is committed _or_ abandoned | no (reseeded from `RocksDB.get_max_gsn()` at boot, `watermark_tracker.ex:198-216`) | yes                                                              | absorbs them (a hole is not an Action) | O(1) `:atomics.get`                                           | **recommended**; correct given (i) rows are materialized as read, (ii) W is read first |
| C   | `MAX(gsn)` in `cf_group_actions` for G                                                                    | newest Action _delivered_ to G                                 | yes                                                                                | yes                                                              | absorbs them                           | O(log n) via `seek_for_prev` (pattern: `rocks_db.ex:250-258`) | correct under B's discipline; needs a new RocksDB helper                               |
| D   | B + "no pending dirty marks in G"                                                                         | barrier                                                        | —                                                                                  | —                                                                | —                                      | O(group)                                                      | unnecessary (below)                                                                    |

```elixir
# watermark_tracker.ex:12-18 — a resolution frontier, not a commit watermark
A watermark step therefore does not imply a durable Action at every GSN.
Deliberately abandoned ranges leave permanent **holes** in the Action log.
```

**Why B works [derived].** GSNs are claimed before the commit attempt and never reused
(`gsn_counter.ex:53-57`), and `mark_committed/3` advances the frontier over exactly the claimed range
(`writer.ex:1341-1343`). If `W = frontier@T0`, every GSN `≤ W` is already resolved at T0: durable
(so any row materialized at or after T0 folds it) or an abandoned hole (no Action to miss). A commit
after T0 has `gsn > frontier@T0`, so it cannot be `≤ W` and the tail owns it. That also closes the
provisional-mark window, which is why D is unnecessary.

**Why A is broken and A′ is not [derived].** The tempting implementation is to accumulate the MAX while
paging: E is read on page 1 at `L=100`; an Action at 120 touches E and F; F is read on page 3 at
`L=120`; `W=120`; the tail starts at 121 and E never sees 120. Two rows of one batch also land at
different positions (`§3`), which has the same effect. A′ repairs it by materializing the whole group
and taking the MAX at one instant before page 1 — correct, but it is a barrier B does not need, and
because `MAX(last_gsn) ≤ frontier` it always resumes from further back than B.

**[unknown]** Whether the frontier is materially ahead of the group's own position in practice; that
is exactly the case #476 wants to win. Settle with a two-group bench reporting
`frontier - max(cf_group_actions[G])`.

---

## 3. Snapshot consistency

**Setup [from source]:** one `Exqlite` connection owned by one GenServer, all reads and writes through
`GenServer.call` (`sqlite.ex:1-35`, `234-260`); WAL, `synchronous=NORMAL`, 64 MB cache, 5 s busy
timeout (`sqlite.ex:58-64`); the query statement is prepared and released per call
(`sqlite.ex:401-435`); no `BEGIN`/`COMMIT` anywhere — every statement is its own implicit transaction.

| question                                          | answer                                                                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| consistent snapshot for the whole listing?        | **no**. One page = one statement = one SQLite snapshot; pages are separate statements with materialization writes between them                                                                                        |
| can a page see a partially committed batch?       | **yes**. A batch is atomic in RocksDB but SQLite learns of it one entity at a time on read (`entity_store.ex:688-698`), so two rows of one batch can be at different GSNs in one page **[derived]**                   |
| what breaks if W is taken after the pages?        | an Action landing between page 1 and the last page is folded into no page-1 row and skipped by the tail ⇒ **permanent gap**                                                                                           |
| what breaks with OFFSET under concurrent inserts? | a row inserted behind the cursor is never returned by any page — covered by the tail (its Actions are `> W`), but it is why the contract must read "listing **+ tail** = full replay", not "the listing is the group" |

So the correct design is **W first, then pages**, with rows materialized as they are read; late
actions are then `> W` and the tail re-delivers already-folded ones, which is idempotent
(`applyUpdate` put/patch/delete, and a delete of an absent row is a no-op,
`internal/materialize.ts:102-148`).

**The materialization pass #476 must add** (no such primitive exists): (1) materialize the group's
system rows — `dirty_entity_ids_for_types(["entityGroup", "groupMember", "group",
"relationship"])` (`permission_helper.ex:34`, `dirty_tracker.ex:283`) then
`EntityStore.materialize/2`, or a membership `put` that is not yet materialized stays invisible to the
page query; (2) page over membership rows and call `EntityStore.materialize/2` on **every** row of the
page, not only the ones `DirtyTracker.dirty?/2` reports (§1: dirty marks do not survive a restart, so
"clean" is not a promise that the row is current). Materializing a clean entity is one empty
`cf_entity_actions` prefix scan plus a compare-and-clear, not a full replay — the same call
`SystemCache` makes for every system entity at boot. This is also what `EntityStore.query/4`'s
per-type filter cannot do, and why the listing should not be built on it unchanged. W is read before
both.

**Cost.** Cold p50 **2.67 ms** for a 20 KB document, dirty materialize p50 **~1 ms** (N=100–500 keys,
~85% blob JSON) **[measured]** (`bench/RESULTS.md:104-116`); at 10k never-materialized user entities a
cold listing is **seconds** **[derived]** — but that is once per entity per data dir, and a restarted
server keeps both the rows and the boot-materialized system rows (§1). Warm = one `SELECT` plus a
fixed **~1 ms** permission join
**[measured]** (`bench/RESULTS.md:142-145`). The dirty set is unbounded — **20,004** entries after 30 s
with 10k preloaded entities (`bench/RESULTS.md:359`) **[from source]**.

---

## 4. Query and index design

### 4.1 Row set

Union of three disjoint shapes **[derived]** from `entity_index.ex:96-129`, confirmed by the client's
own group attribution (`scope-eviction.ts:52-68`):

```sql
-- (1) the group row itself            (2) its member rows (no entityGroup row exists)
SELECT * FROM entities WHERE id = :g AND type = 'group';
SELECT * FROM entities WHERE type = 'groupMember' AND group_id = :g AND deleted_hlc IS NULL;
-- (3) every entity with a live membership row in G, INCLUDING those membership rows
SELECT e.* FROM entities e JOIN entities m
  ON m.type = 'entityGroup' AND m.group_id = :g AND m.deleted_hlc IS NULL
 AND (m.entity_id = e.id OR m.id = e.id)
WHERE e.deleted_hlc IS NULL;
```

`entityGroup` rows **must** ship: the client's membership index is built from that type alone
(`internal/reverse-index.ts:50-51`, `replica.memberships()`), and #475's visible set is literally "the
`entity_id`s referenced by the membership rows it holds" **[from source]** (`sync/backfill.ts:117-135`).
Relationships and derived documents come free because `createEntity` files one `entityGroup` row each
(`sync/operations.ts:213-232`).

### 4.2 Pagination

Today: `ORDER BY e.created_hlc, e.id` with `LIMIT ? OFFSET ?` (`sqlite.ex:408-431`) **[from source]**.
`OFFSET` is O(offset) and, with the `DISTINCT` membership join, re-does the dedupe per page →
O(n²/limit) **[derived]**; `created_hlc` is immutable (`sqlite.ex:96-108`) but no index orders a group
by it, so each page would sort the whole group; and inserts shifting across page boundaries make a
page's accounting non-deterministic (bad for a resume token and for tests).

**Keyset on the membership row id** — immutable, unique, index-ordered:

```sql
SELECT m.id, m.entity_id FROM entities m
WHERE m.type='entityGroup' AND m.group_id=? AND m.deleted_hlc IS NULL
  AND m.id > ?                                  -- omitted on page 1
ORDER BY m.id LIMIT ?;
-- then one PK lookup for the page's ids (membership rows + referenced entities)
SELECT * FROM entities WHERE id IN (?,?,…) AND deleted_hlc IS NULL;
```

Token `(phase, last_key, w)`: phase 0 = the bounded prefix (`group` row, then `groupMember` rows keyed
on `actor_id`, which `idx_entities_group_member` already orders); phase 1 = membership rows keyed on
`m.id`. Two live membership rows may name the same entity; the client store is id-keyed, so a repeat is
idempotent — do **not** add `GROUP BY e.id`, it turns every page into a full-group b-tree.

### 4.3 Indices

| need                   | index                                                             | status                  |
| ---------------------- | ----------------------------------------------------------------- | ----------------------- |
| membership page keyset | `(group_id, id) WHERE type='entityGroup' AND deleted_hlc IS NULL` | **missing**             |
| groupMember prefix     | `idx_entities_group_member (group_id, actor_id)`                  | exists (`sqlite.ex:93`) |
| page fetch by id       | `entities.id` PK                                                  | exists                  |

A′ additionally wants `(group_id, last_gsn) WHERE type='entityGroup'` for a cheap MAX; B needs no
extra index beyond the page keyset.

Do not page from `entities` ordered by `(created_hlc, id)` with an `EXISTS` membership filter (scans
every live entity per page), and do not reuse `idx_entities_entity_group` (`group_id` is its second
column, so SQLite scans the whole partial index and filters) **[derived]**.

### 4.4 Enumerating from the membership cache

`EntityGroupCache.group_entities(group_id)` already holds the group's live entity ids, boot-populated
and Writer-maintained (§1), and nothing production reads it today. A listing could snapshot that sorted
id list at T0, keyset over the list, and fetch rows by `(entity_id, group_id)` through the existing
`idx_entities_entity_group` — no new index. The costs are real: the cache stores `entity_id` but not the
`entityGroup` **row** id, so membership rows need a second lookup per entity; a listing must copy the
id set (O(group) memory) because it cannot page an ETS set the way it pages SQL; and any divergence
between the cache and SQLite becomes a listing bug rather than a slow query. Viable for a small first
slice; the index + keyset path is one query and no extra state, so prefer it **[derived]**.

---

## 5. API surface

| option                                                                  | fits conventions?                                                                                                                                                                    | W / token                        | auth                                                      | verdict                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| **`GET /sync/groups/:group_id/entities?cursor=&limit=`**                | mirrors its sibling `GET /sync/groups/:group_id` (`router.ex:266-287`): group-scoped, paginated, 403                                                                                 | body envelope                    | `PermissionChecker.member_of_group?/3` → 403 `not_member` | **recommended**                                                      |
| **same endpoint, membership ids only** + per-entity `GET /entities/:id` | reuses the shipped per-entity read/auth path, but splits enumeration and content across endpoints                                                                                    | body envelope, ids only          | group check on the listing, per-entity on each GET        | viable fallback; loses on round trips (below)                        |
| extend `POST /entities/query` with `group_id`                           | breaks three conventions: bare-array response (`router.ex:146-155`), `type` required (`router.ex:137`), auth is an entity×membership JOIN (`sqlite.ex:406-421`) not group membership | needs a header or a shape change | subtly different                                          | **rejected**                                                         |
| handshake response change                                               | handshake is the right _trigger_ (it already returns the per-group cursor) but not a transport for O(group) rows; loses pagination                                                   | —                                | reuses group list                                         | **rejected** as transport; only its request `cursors` changes (§6.3) |

Envelope (JSON body, snake_case, `{"error": …}` errors — the router's style):

```json
{ "group_id": "g_1", "watermark": 12345, "cursor": "eyJwaGFzZSI6MX0", "has_more": true,
  "entities": [ {"id":"…","type":"…","data":{"fields":{…}},
                 "created_hlc":…,"updated_hlc":…,"deleted_hlc":null,"last_gsn":…} ] }
```

**Why content in the page, not ids only.** The enumeration half is identical either way (§4.1), so the
real choice is whether page rows carry content. Ids-only reuses the shipped path unchanged —
`GET /entities/:id` returns the same row shape, and #475's `fetchEntity` + `snapshotAction` already
consume it (`backfill.ts:47-56`, `184-215`) — at the cost of one request per entity. #475's loop is
**sequential** (`backfill.ts:200-215`), so a 10k-entity cold bootstrap is 10k round trips before the
client can tail, each paying its own permission check, against 50 bulk pages at a 200 limit. Ids-only
is the right fallback if the envelope's bytes (not its request count) turn out to be the binding
constraint; it is not the default. Either way the client must page until `has_more` is false, then set
`cursor(G) = W`.

- `watermark` is **the** W: on page 1, echoed identically later so a client can assert it did not
  change. A token whose `w` disagrees with the current frontier is still honoured — W is a claim about
  the past, not a lease.
- `cursor` is base64 of `{v, group_id, w, key}`. A token whose `group_id` is not the path's group is
  `400 bad_cursor`; the server validates the shape, not the freshness.
- Catch-up puts pagination in headers (`router.ex:276-277`) only because its body is a bare array;
  here the body already needs an envelope, so `cursor` + `has_more` live in it. `cursor` is opaque,
  `null` when `has_more` is false.
- Entity objects are **shape-identical** to `GET /entities/:id` (`router.ex:91-107`) so
  `toRuntimeEntity` (`sync/backfill.ts:100-112`) applies unchanged.
- `limit`: default 200 (matching `catch_up.ex:22`), max 1000, 400 above. `POST /entities/query` has
  **no cap at all** today (`router.ex:140-141`) — do not copy that.
- Auth: **403 `not_member`** for both "not a member" and "no such group", matching catch-up and
  leaking no existence. Do not copy `GET /entities/:id`'s 404: that exists because entity ids are
  unguessable, while group ids are handed out by handshake.
- Register in `Mix.Tasks.Openapi.Gen.Spec.routes/0` (`lib/mix/tasks/openapi.gen.spec.ex:85-94`), add
  an `openapi_operation(:list_group_entities)`, regenerate `openapi.yaml`.

---

## 6. Client contract

### 6.1 What the listing must hand over

Per row, exactly the `EntityResponse`: `id`, `type`, `data.fields` in canonical wire envelopes (leaf
`{value, update_id, hlc}`, map `{map: …}`, `field_merge.ex:1-45`), `created_hlc`, `updated_hlc`,
`deleted_hlc` (always `null`), `last_gsn` **[from source]** (`router.ex:91-107`). `last_gsn` is
load-bearing: #475's `snapshotAction` stamps the synthetic `put` with it so the base sits at its true
causal position, and the per-leaf `update_id`/`hlc` make later patches merge over the base by HLC
rather than regressing it **[from source]** (`sync/backfill.ts:47-56`). Plus W, the token, and — phase
0 — the `group`/`groupMember` rows, which #475 will _never_ fetch (`backfill.ts:124-134`).

### 6.2 What #475's shipped implementation does not provide

| gap                                 | evidence                                                                                                                                                                                                                          | consequence                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no cursor write anywhere            | `createBackfill` appends and re-reads; it never touches `storage.cursors` (`backfill.ts:195-220`); the only writer is `_applyAction` for `gsn > 0` (`client.ts:1625-1631`)                                                        | the listing must write `cursor(G) = W` itself                                                                                                                |
| no bulk seed                        | one synthetic Action + one `actions.append` + one `replica.ingest` **per entity** (`backfill.ts:208-215`); `Replica` has only per-Action `ingest` and a whole-record `load` that clears everything (`replica/replica.ts:478-518`) | 10k entities = 10k IDB writes and journal bumps, vs 150–180 ms for one `load` pass at 10k rows **[measured]** (`docs/research/503-replica-read-model.md:27`) |
| no transaction across log + cursor  | `actions` and `cursors` are separate object stores in separate IDB transactions (`indexeddb/action-log.indexeddb.ts:47-73`, `indexeddb/cursor-store.indexeddb.ts:12-20`)                                                          | replace atomicity with **ordering**: base first, cursor second. Crash between ⇒ cursor behind base ⇒ re-delivery (safe); the reverse is a permanent gap      |
| in-memory cursor cache              | `computeResumeCursor` prefers `this.groupCursors` (`client.ts:1488-1499`), which `handshake()` clears and refills from a response built with `cursors: {}` (`client.ts:588-590`, `613-618`)                                       | the bootstrap must set `storage.cursors[G]` **and** `groupCursors[G]`, or the next SSE resume opens at 0 and re-drains the history                           |
| candidate set is `entityGroup`-only | `backfill.ts:124-134`                                                                                                                                                                                                             | phase-0 rows must come from the listing                                                                                                                      |

### 6.3 The seed (settled)

**Batched synthetic snapshot Actions, pinned to W.** One IDB transaction per page (default 200 rows),
`ActionLog.append` per entity, ids deterministic per `(group, entity)` so a redo merges by id instead of
duplicating (`action-log.indexeddb.ts:47-73`). W is pinned before page 1: the first page's transaction
appends its Actions **and** writes the seed marker `{group_id, w, token}`; the final page appends,
writes `cursor(G) = W`, and clears the marker.

- **Crash mid-seed.** The marker says "resume this listing at W": redo from its token (or page 1) at
  the same W. Re-listing at the same W cannot resurrect an entity deleted after W — that delete is
  `> W` and arrives by tail. Re-listing at a _new_ W would (a delete `≤` the new W is never
  delivered), which is why W is pinned rather than recomputed per attempt.
- **State.** Marker and cursor are one per-group resume record in the extended `CursorStore`
  (`{cursor?, seed?}`, plus `clear()`), so the trigger is a single read: no cursor, or a seed present.
- **Local writes.** Seed first, then re-apply every live outbox entry (`pending`/`acknowledged`/
  `error`/`conflicted`): `applyUpdate`'s PUT is a full replacement (`internal/materialize.ts:102-120`),
  so a base put landing last would wipe an optimistic row. The group's catch-up and the echo then
  converge. Run the bootstrap **before** releasing the flush gate: `appliedBaseGsn()` stamps buffered
  writes from `groupCursors` (`client.ts:1392-1405`). The seam is where #475's `void this.backfill()`
  already runs (`client.ts:1297-1301`).
- **Meaning.** `cursor(G) = W` now means "G's view is complete as of W", from the log or the seeded
  base. Scope eviction restores from the persisted record plus the log tail (`client.ts:1075-1100`), so
  log-backed seeds keep the invariant without a new marker.
- **Tail guard.** The tail re-delivers Actions in `(W, materialization]` that the listing already
  folded; skip any delivered Action with `gsn <=` the target row's `last_gsn` (log replay is exempt).
  Otherwise a re-delivered `put` can transiently regress a row seeded ahead of W.
- **Invalidation.** `cursor_valid: false` means the server lost state (fresh data dir or restore), so
  every group's base is suspect: full local sync reset (`ActionLog.clear()`, replica reset,
  `CursorStore.clear()`, keep the outbox), then bootstrap each group on subscribe. `handshake()` must
  default its request `cursors` to the persisted ones (`client.ts:588-590` currently sends `{}`), or the
  server can never report `false`.

---

## 7. Edge cases

| case                                         | outcome                                                                                                                                                                                                                                                                           | who covers it                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| entity in several groups                     | one membership row per (entity, group) in G's stream; repeats across pages are id-keyed no-ops                                                                                                                                                                                    | listing                                                                                                                                                                                                                                                                        |
| entity deleted mid-pagination                | its own row tombstones, so later pages omit it; an earlier page may have seeded it live                                                                                                                                                                                           | the delete Action is `> W` ⇒ tail, or was durable before T0 ⇒ never seeded. `applyUpdate`'s delete of an absent row is a no-op (`internal/materialize.ts:137-148`), so #473 filtering cannot break the drain                                                                   |
| membership removed mid-pagination            | same on the `entityGroup` row                                                                                                                                                                                                                                                     | tail deletes the row; the entity stays in the client replica, visibility is decided by the client's own membership index                                                                                                                                                       |
| membership added mid-fetch                   | appears on a later page, or is skipped (ordered behind the cursor)                                                                                                                                                                                                                | the `entityGroup` put is `> W` ⇒ tail. Its **content** may predate the membership and not be in G's history ⇒ exactly #475's backfill, already wired (`client.ts:1297-1301`)                                                                                                   |
| entity created after W, before the last page | not in the listing                                                                                                                                                                                                                                                                | create Action `> W` ⇒ tail                                                                                                                                                                                                                                                     |
| empty group                                  | `watermark` = the frontier (non-zero if other groups are busy), `entities: []`, `has_more: false`                                                                                                                                                                                 | client sets `cursor(G) = W` and skips the history — the win                                                                                                                                                                                                                    |
| group larger than one page                   | phase 1 pages over `m.id`                                                                                                                                                                                                                                                         | new index (§4.3)                                                                                                                                                                                                                                                               |
| client presents W the server cannot honour   | only when the cursor is **ahead** of the frontier — e.g. the server's data dir was reset (`watermark_tracker.ex:198-216` seeds from `RocksDB.get_max_gsn()`), so handshake answers `cursor_valid: false`, `reason: "behind_watermark"`, `cursor: watermark` (`router.ex:193-208`) | **full local sync reset**, then re-seed (§6.3). Today the client lowers `groupCursors` (`client.ts:613-618`) but keeps rows seeded at the old W. Note the reason string is inverted vs its own doc (`sync/types.ts:47-56`: `false` = "server pruned past the client's cursor") |

---

## 8. Plan

**PR 1 — server (blocks the client).**

1. `EbbServer.Sync.GroupListing`: read the frontier; materialize the group's dirty system rows
   (`entityGroup`, `groupMember`, `group`) so the membership join sees them; page membership rows by
   `m.id`; materialize **every** page row; return the §5 envelope.
2. One partial index `(group_id, id) WHERE type='entityGroup' AND deleted_hlc IS NULL` (§4.3). The
   membership-cache alternative (§4.4) loses because the membership rows still need materializing.
3. `GET /sync/groups/:group_id/entities`: `limit` 200 default / 1000 max, 403 `not_member`, opaque
   `{v, group_id, w, key}` token (400 on group mismatch), `watermark` echoed; register in
   `Mix.Tasks.Openapi.Gen.Spec.routes/0` and regenerate `openapi.yaml`.
4. Tests: envelope, 403, limit 400, token round-trip; a page taken while a write lands; a user row made
   stale by a restart comes back current (the unconditional materialize).

**PR 2 — client.**

1. Extend `CursorStore` to `{cursor?, seed?}` + `clear()`; IDB schema bump and memory-adapter parity.
2. `bootstrapGroupListing(G)`: trigger on no cursor / seed marker / handshake invalid; pin `{w, token}`
   with page 1; batched deterministic snapshot Actions; the final page writes the cursor and clears the
   marker; seed-then-reapply outbox; called before catch-up and before the flush gate releases.
3. `handshake()` defaults `cursors` to the persisted ones.
4. Full local reset on an invalid cursor.
5. Monotonic-gsn guard at the tail seam.
6. Tests: `listing + tail === replay` for (a) content predating membership, (b) a delete mid-pagination,
   (c) a cross-group Action (#473), (d) a multi-group entity; crash after page 1 then redo at W (no
   resurrection); invalid cursor resets and re-seeds; pending/acknowledged optimistic writes survive;
   no seeded row regresses.

**Separate issue (not blocking).** Stale-clean and missing lazy rows across restart: [measured] repro,
#564; fix by re-marking lazy entities on the existing `cf_type_entities` boot walk
(`system_cache.ex:528-556`), with the restart test as the regression guard.

**Related.** #320 (server failover) can reuse this listing for its full resync; this design is not
failover detection. #123 bounds the seeded log growth. #421 owns the boot walk the #564 fix piggybacks
on.

## Decisions (settled)

| decision             | answer                                                                             | why                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W definition         | **resolution frontier**, read once before page 1, every page row materialized      | §2: O(1); unconditional materialization folds every GSN ≤ W and repairs rows left stale by a restart                                                          |
| page payload         | **entity content in the page**, not ids-only                                       | enumeration is identical either way; #475's fetch loop is sequential, so ids-only is 10k requests for a 10k group (§5)                                        |
| row set              | `group` + `groupMember` + `entityGroup` + member entities                          | the client reads `groupMember` locally (`permission.ts:508-521`, `membership.ts`, `scope-eviction.ts`) and `entityGroup` rows are #475's candidate set (§4.1) |
| W vs A′ vs group-max | **B, the frontier**                                                                | A′ needs a whole-group materialize barrier and resumes from further back; C needs a new RocksDB helper (§2)                                                   |
| slice boundary       | **two PRs, one design**: server endpoint first, client bootstrap second            | the server contract is testable alone; the client seed is where the risk is (§8)                                                                              |
| trigger              | no cursor, seed marker present, or handshake `cursor_valid: false`                 | one per-group resume read; `cursor < W` with a valid base is the tail's job (§6.3)                                                                            |
| cold first page      | **accepted**, bench it                                                             | one-time per entity per data dir; warm-up only if the bench shows seconds (§8)                                                                                |
| restart staleness    | **separate bug** #564, boot re-mark fix, not a blocker                             | [measured] §1; #476's listing materializes every page row regardless                                                                                          |
| cursor meaning       | **overload** `cursor(G) = W`; document "complete as of W"                          | every consumer already reads it as a global GSN (§6.3)                                                                                                        |
| seed mechanism       | **batched snapshot Actions**, per page, deterministic ids                          | reuses the merge path; ~200× fewer IDB commits than #475's per-entity loop; redo merges by id (§6.3)                                                          |
| crash mid-seed       | **pin W with page 1**, redo at the same W                                          | re-listing at a new W would skip deletes in between and resurrect (§6.3)                                                                                      |
| invalidation         | **full local reset** (log, replica, cursors; keep outbox), then re-seed all groups | a server data-dir loss invalidates every base, and the append-only log cannot forget one group's seeded puts (§6.3)                                           |
| optimistic writes    | **seed, then re-apply live outbox entries**                                        | PUT is full replacement, so the base must land first; echo/catch-up converges (§6.3)                                                                          |
| tail re-delivery     | **monotonic-gsn guard** at the delivery seam                                       | Actions in `(W, materialization]` are already folded into seeded rows (§6.3)                                                                                  |
| handshake cursors    | **default to persisted cursors**                                                   | today it sends `{}`, so `cursor_valid: false` is unreachable (§6.3)                                                                                           |
| seed state           | **extend `CursorStore`** with `{cursor?, seed?}` + `clear()`                       | seed and cursor are one resume concept; one read for the trigger                                                                                              |
| wire                 | rows 200 default / 1000 max, token `{v, group_id, w, key}`, **403** `not_member`   | mirrors catch-up; no existence oracle; heavy-row byte cap deferred to measurement (§5)                                                                        |

## Open questions

1. **Cold first-page latency.** Accepted, not yet measured. Bench a 10k-entity group with heavy
   `page_content` rows on a fresh `data_dir` in PR 1; add a boot or background warm-up only if the first
   page runs into seconds.
2. **[unknown]** JSON integer precision on `created_hlc`/`updated_hlc` (`sync/types.ts:29-33`) once a
   listing round-trips 10k rows. Per-leaf `hlc` drives the merge, so row-level truncation only affects
   ordering metadata, and it is inherited from #475. Settled by a round-trip test of a high-bit HLC
   through `GET /entities/:id` and the listing.
3. **Naming cleanup.** `reason: "behind_watermark"` fires when the cursor is _ahead_ of the frontier,
   the opposite of what `sync/types.ts:47-56` documents. Fix the doc or the string while touching cursor
   validity in PR 2.
