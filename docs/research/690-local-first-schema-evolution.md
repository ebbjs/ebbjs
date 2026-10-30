# Local-first replicas and schema evolution (#690, leg B)

Research note for [issue #690](https://github.com/ebbjs/ebbjs/issues/690), a spike under
[#124](https://github.com/ebbjs/ebbjs/issues/124). The sibling leg carries the server-authoritative
systems; this leg covers products that keep a **local replica**, and the local-first literature.
Base: `origin/main` @ `5e79f05`. No code, no API decisions.

The seven questions are #690's. Every row below is answered from the vendor's own documentation or
the paper itself. Where the documentation does not answer a question I have written **not
documented** — searched, not inferred. One negative claim ("the docs never mention schema") is only
made where the docs publish a complete index (`llms.txt`) that I grepped, or where the whole page
set was read; the method is stated in each case.

**Retrieval date: 2026-10-30** (all sources). Versions are in the [source table](#sources-and-versions).

## Headline

- **Two documented strategies exist, and no product documents carrying application schema along
  in both.** Either the client translates _patches and rows_ between schema versions on read
  (Cambria, Jazz, ebb's #124 read-side), or the client throws its local copy away and re-downloads
  (Realm's client reset, Couchbase Lite's prebuilt database, Triplit's `onDatabaseInit` clear).
  The literature is emphatic that the first is the only option that keeps a local-first client's
  data, and the vendor docs are equally emphatic about what the second costs when the outbox is
  non-empty.
- **No source — product or paper — treats "a field implies a second row" as a migration problem.**
  Cambria names it twice as _unsolved_: `augmenting data` needs values the lens cannot compute, and
  `working across documents` (splitting one document into many) is an open question. Every other
  system's migration surface is columns/properties on one row. ebb is alone in making the derived
  row the unit of the field declaration.
- **Realm documents the exact failure mode ebb's #442 hits, at the system level.** A _breaking_
  schema change is answered by a client reset, and the docs say plainly: "Do not expect to recover
  all unsynced data after a breaking schema change. The best way to preserve user data is to never
  make a breaking schema change at all."

## Sources and versions

| What                                            | Version / state                                            | URL                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Ink & Switch, _Cambria_ (essay)                 | October 2020, authors Litt / van Hardenberg / Henry        | https://www.inkandswitch.com/cambria/                                                         |
| `cambria-project` README                        | last push 2024-06-14, "still immature software"            | https://github.com/inkandswitch/cambria-project                                               |
| Ink & Switch, _Local-first software_            | essay, 2019 (site moved to `/essay/local-first/`)          | https://www.inkandswitch.com/essay/local-first/                                               |
| Hofmann, Pierce, Wagner, _Edit Lenses_          | POPL 2012, DOI 10.1145/2103656.2103715                     | https://doi.org/10.1145/2103656.2103715                                                       |
| MongoDB, Atlas Device SDKs deprecation          | live page, EOL date 2025-09-30                             | https://www.mongodb.com/docs/atlas/device-sdks/deprecation/                                   |
| MongoDB, Device Sync deprecation + alternatives | live page                                                  | https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation/                 |
| Realm SDK docs (source of the pages)            | repo **archived**, last push 2025-12-04                    | https://github.com/mongodb/docs-realm (`source/sdk/node/**`)                                  |
| Couchbase Lite docs                             | 4.1 (`current`)                                            | https://docs.couchbase.com/couchbase-lite/current/android/upgrade.html                        |
| CouchDB docs                                    | 3.5 (`stable`)                                             | https://docs.couchdb.org/en/stable/ddocs/views/intro.html                                     |
| `pouchdb-migrate`                               | community plugin, not PouchDB core                         | https://github.com/eHealthAfrica/pouchdb-migrate                                              |
| Triplit docs (site source)                      | repo `main`, last push 2026-01-19                          | https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/updating.mdx |
| Jazz docs                                       | live, CLI shown at `jazz-tools@alpha`                      | https://jazz.tools/docs/schemas/migrations                                                    |
| Automerge docs                                  | live, v3 era (`Migrating from Automerge 2 to Automerge 3`) | https://automerge.org/docs/reference/documents/ and index https://automerge.org/llms.txt      |
| Yjs docs                                        | live                                                       | https://docs.yjs.dev/api/shared-types.md and https://docs.yjs.dev/api/faq.md                  |

Two notes on source access, since it affects what "not documented" means here:

- `mongodb.com/docs/realm/sdk/node/**` now **redirects to the deprecation page** (verified: HTTP 302
  to `/docs/atlas/device-sdks/deprecation/`). The pages quoted below are the source text of those
  pages in `mongodb/docs-realm`, which MongoDB archived. They are still the pages that owned the
  claims; they are no longer reachable as rendered docs.
- `triplit.dev` did not complete TLS from this host (`SSL_ERROR_SYSCALL` on every attempt), so the
  Triplit material is the markdown source of the docs site in the Triplit repo — the same files the
  site renders.

---

# Part 1 — Products with a local replica

## 1.1 Realm + Atlas Device Sync

**Status first, because it changes how to read everything else.** Atlas Device SDKs were deprecated
"as of September 2024" and "will reach end-of-life and be removed on **September 30, 2025**"
([deprecation page](https://www.mongodb.com/docs/atlas/device-sdks/deprecation/)). That page splits
the product: "The Atlas Device SDKs are made up of two parts: the on-device database and Atlas
Device Sync. The on-device database will continue to exist as an open source project." The SDKs have
`community` branches that "remove Device Sync code from their codebases" (the list includes
`realm/realm-js/tree/community`). Device Sync itself "is deprecated... apps built using Sync need to
move to an alternative solution or remove Sync".

**What replaced it, per MongoDB.** Not a MongoDB product: the Device Sync deprecation page names
third-party providers with migration guides — **Ditto**, **PowerSync**, **ObjectBox**,
**AWS AppSync**, **HiveMQ**, **Ably**, **Parse (open source)**, **Cedalo** — plus "Custom Solution"
with consulting partners ([Device Sync deprecation](https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation/)).
So the Realm _schema-version + migration_ model below is a **retired** answer, and there is no
first-party successor that inherits it. PowerSync (leg A) and Ditto are the named homes.

**Q1 — where the schema lives.** In client code, in the config handed to `Realm.open`:
`schema` array plus a `schemaVersion` integer. Both sides are real: "You must always pass a schema
when using a Synced realm" ([open-and-close-a-realm](https://github.com/mongodb/docs-realm/blob/master/source/sdk/node/realm-files/open-and-close-a-realm.txt)),
and a breaking change also requires a server-side App Schema update (see Q5). Versions are
"ascending integers... If a client application does not specify a version number when it opens a
realm then the realm defaults to version `0`."

**Q2 — what is legal.** Local realms: anything the migration function can express. Synced realms:
_additive only_. Quoting the same page:

> "Synced realms only support non-breaking - also called additive - changes to ensure that older
> clients can sync with newer clients. Because full renames require you to delete the old property,
> you cannot rename a synchronized property without requiring a client reset. Instead, consider
> adding the renamed property without deleting the old property. Alternately, use `mapTo` to store
> data using the existing internal name, but let your code use a different name."

and, for types: "synchronized realms do not support modifying the type of a property of a schema."
The escape hatch is documented and is a _naming_ trick (`mapTo`), not a migration.

**Q3 — execution model.** Client-side, at open, in place. "Whenever you open an existing realm with a
schema version greater than the realm's current version, Realm runs a migration function that you
define. The function has access to the realm's version number and incrementally updates objects in
the realm to conform to the new schema." Automatic part: "Realm automatically migrates certain
changes, such as new and deleted properties, but does not automatically set values for new
properties unless the updated object schema specifies a default value." A rename is _not_ an
operation: "Migrations do not allow you to directly rename a property. Instead you can create a new
property with the updated name, copy the value from the old property, and then delete the old
property." Development-only escape: `deleteRealmIfMigrationNeeded`, with the doc's own warning —
"Never release an app to production with this flag set to `true`." There is **no** server-side
backfill job and no read-time projection: the stored rows are rewritten.

**Q4 — derived / dependent rows.** **Not documented.** The migration examples on the Node SDK's schema-change page
([`LocalMigration.js`](https://github.com/mongodb/docs-realm/blob/master/source/examples/Migrations/LocalMigration/LocalMigration.js))
set properties on existing objects; no example creates a _different_ object type, and none of the
schema-change or client-reset pages read for this note discusses a field that implies a second row.

**Q5 — stale / offline clients.** Hard local gate, enforced by the schema itself: "Realm will throw
an error if a client application opens a realm with a schema version that is lower than the realm's
current version or if the specified schema version is the same as the realm's current version but
includes different object schemas." That is `min_supported_version` at the storage layer. For synced
realms there is a second gate at the protocol level: "After a breaking schema change: All clients
must perform a client reset. You must update client models affected by the breaking schema change."
([destructive-schema-change-app-update.rst](https://github.com/mongodb/docs-realm/blob/master/source/includes/destructive-schema-change-app-update.rst)).

**What happens to a stale client's _unsynced writes_ — the most directly useful material in this
leg.** A client reset is documented as four modes
([handle-sync-errors](https://github.com/mongodb/docs-realm/blob/master/source/sdk/node/sync/handle-sync-errors.txt)):
recover unsynced changes; recover-or-discard; discard unsynced changes ("Restores the realm to a
syncable state by discarding changes made since the last sync"); manual recovery. Client Recovery
"can recover unsynced changes when there are no schema changes, or non-breaking schema changes" —
i.e. the recovery path is explicitly closed for exactly the case #690 is about. Manual recovery is
the only route, and its own page is a warning label:

> "Manual recovery requires significant amounts of code, schema concessions, and custom conflict
> resolution logic. You should only perform a manual recovery of unsynced realm data if you cannot
> lose unsynced data..."
> "**Avoid Making Breaking Schema Changes in Production.** Do not expect to recover all unsynced
> data after a breaking schema change. The best way to preserve user data is to never make a
> breaking schema change at all."

The "schema concession" is concrete: "you add a 'Last Updated Time' to each object model to track
when each object last changed", and the recovery then "overwrites the entire object in the new realm
if any field was updated after the last successful sync of the backup realm. This could overwrite
fields updated by other clients with old data from this client" — with the fix being per-field
timestamps instead
([client-reset-data-recovery](https://github.com/mongodb/docs-realm/blob/master/source/sdk/node/sync/client-reset-data-recovery.txt)).

**Q6 — rebuild vs migrate.** Both, on a documented boundary. Non-breaking: migrate in place at open.
Breaking: _rebuild_ — the client reset discards local state and re-downloads; recovery of the
outbox is app code over a backup file. Cost, quoted above: a timestamp column in every model, custom
merge, and possible clobbering of concurrent fields.

**Q7 — refusals.** No property rename in a migration (copy + delete only); no type change on synced
data; no rename on synced data without a reset; no server-run migration.

## 1.2 Couchbase Lite

**Q1 — where the schema lives.** Nowhere: the store is schemaless JSON documents in
scopes/collections. The only "schema" in the docs is a namespacing table — relational "Schema" maps
to Couchbase "Scope", "Table" to "Collection"
([database](https://docs.couchbase.com/couchbase-lite/current/android/database.html)). Persistence
and query shape are application conventions; the data-model example carries a `type: "hotel"`
property as a discriminator ([document](https://docs.couchbase.com/couchbase-lite/current/android/document.html)).

**Q2 — what is legal.** Any document change, because nothing validates a document shape. The real
constraint is _binary_, not schema: Couchbase Lite 4.0 "requires Sync Gateway 4.x or later"; syncing
with an older gateway "results in replication errors", and "CBL 4.0 can only perform peer-to-peer
synchronization with other CBL 4.x instances" — "Sync attempts with CBL 3.x peers fail with
appropriate error messages" ([upgrade](https://docs.couchbase.com/couchbase-lite/current/android/upgrade.html)).
That is a compatibility matrix ([compatibility](https://docs.couchbase.com/couchbase-lite/current/android/compatibility.html)),
not a schema version.

**Q3 — execution model.** Two documented migrations, both _the vendor's own format_, not the app's
data model:

- "On upgrading from a 2.x release, all Couchbase Lite databases automatically re-index on initial
  database open. This can result in a delay before the database is usable."
- 4.0's move from revision trees to version vectors is lazy and per document: "When opening a 3.1 or
  3.2 database with CBL 4.0, documents are automatically upgraded to use version vectors when
  they're updated and saved."

Application-level data migration is **not documented** — there is no migration hook or page. (Method: the Couchbase Lite docs index was searched via `docs.couchbase.com/llms-couchbase-lite.txt`; the only page containing "migration" is `maintenance/index`, whose "Migration Guide" is the 1.x->2.x server clustering upgrade, not app-schema migration.)

**Q4 — derived / dependent rows.** **Not documented.** Nothing in the document, database, conflict,
upgrade, prebuilt-database or compatibility pages read for this note describes a document that
exists because another document's field implies it.

**Q5 — stale / offline clients.** No schema gate; the documented gates are the binary/sync-version
matrix (Q2) and conflict resolution. Since 4.0 the default conflict strategy "changes from most
active wins to last write wins based on hybrid logical timestamps". A local save is "last write
wins, unless one change is a delete"; replication conflicts are resolved either automatically or by
a `conflictResolver` you register on the replicator
([conflict](https://docs.couchbase.com/couchbase-lite/current/android/conflict.html)). Local writes
are never discarded by a schema event because there is no schema event.

**Q6 — rebuild vs migrate.** Rebuild is the documented posture, and it is _per app version_: the
pre-built database workflow says to "Create a fresh Couchbase Lite database (every time)" and
"Always start with a fresh database for each app version as this ensures there are no checkpoint
issues", then `Database.copy()` into place (which "ensures that a UUID is generated for each copy"),
then start a pull replication ([prebuilt-database](https://docs.couchbase.com/couchbase-lite/current/android/prebuilt-database.html)).
What that costs: the copied database replaces local state wholesale; the copy must go through the API
or "each copy of the app invalidates the other apps' checkpoints"; and downgrades between major
versions are unsupported ("attempting to downgrade to a previous major version creates
incompatibility issues").

**Q7 — refusals.** No schema layer, no migration API, no downgrade across majors. It also refuses to
hide the upgrade cost: a re-index on first open is documented as a visible delay.

## 1.3 PouchDB / CouchDB

**Q1 — where the schema lives.** In the application. Documents are JSON; the only first-class
declarative artifact is the **design document**, and what it declares is _derived data_ (map/reduce
views), not document shape.

**Q2 — what is legal.** Any document change is legal, and the interesting consequence is on the
_derived_ side: "Views that change often, and are in the same design document as other views, will
invalidate those other views' indexes when the design document is written, forcing them all to
rebuild from scratch. Obviously you will want to avoid this in production!"
([CouchDB views](https://docs.couchdb.org/en/stable/ddocs/views/intro.html)).

**Q3 — execution model.** There is no migration mechanism in CouchDB or PouchDB core. (Method: CouchDB's
docs publish a `searchindex.js`; grepping it returns "migration" only on server-upgrade and release-note
pages — the `maintenance/index` "Migration Guide" is the 1.x→2.x clustering upgrade, not app-schema
migration. PouchDB's own docs have no migration API.) Migration is an app-level batch rewrite of
documents; the documented tooling is a community plugin, [`pouchdb-migrate`](https://github.com/eHealthAfrica/pouchdb-migrate)
(not part of PouchDB), whose whole contract is a function run over every doc:

```js
var migration = function (doc) {
  if ("foo" in doc) return;
  doc.foo = "bar";
  return [doc];
};
db.migrate(migration);
```

with the two hazards left to the caller in the plugin's own comments: "Return falsy value to skip
the doc" and "Make sure to prevent from loops".

**Q4 — derived / dependent rows.** CouchDB's views are the only first-class derived data in this
comparison, and they are **rebuilt, never migrated**: rewriting a design document invalidates the
index and the index is recomputed from the documents. But a view is derived from documents by a
function the reader controls; it is not a second _document_ that a field implies, and it is not
writable. (Also documented: only the winner of a conflict is "fed into your map function" — see Q5.)

**Q5 — stale / offline clients.** This is the multi-master model, so an offline client's writes are
never "unsynced" in the outbox sense — they are local revisions that replicate later. The documented
outcome is conflict, not loss: "CouchDB picks one arbitrary revision as the 'winner', using a
deterministic algorithm so that the same choice will be made on all peers... It could look as if the
changes she made there have been lost - but of course they have not, they have just been hidden away
as a conflicting revision" ([replication and conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html)).
Note the interaction with Q4: derived views see only the winner, so a schema _migration_ that
rewrites documents races with those hidden revisions — **not documented** by CouchDB, since CouchDB
does not document migrations.

**Q6 — rebuild vs migrate.** Rebuild is available and cheap _for derived data_ (invalidate the
design doc; the index rebuilds from the log) and expensive for documents (a rewrite creates new
revisions on every doc). Nothing in the docs frames that as a schema decision.

**Q7 — refusals.** No schema, no migration API, no server-side policy on which revision wins beyond
the deterministic algorithm. It refuses to merge for you: "Any sensible business-card application
will, at minimum, have to present the conflicting versions to Alice".

## 1.4 Triplit

**Q1 — where the schema lives.** In code, at `triplit/schema.ts`, and _also_ on the server, pushed
live: "This command will look at the schema defined at `./triplit/schema.ts` and attempt to apply it
to the server while it's still running." Access-control rules live in the schema too, so schemaless
mode has no permissions ([schemas](https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/index.mdx)).

**Q2 — what is legal.** Explicitly two categories, and the list is short
([updating](https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/updating.mdx)):

> "Backwards compatible changes... Adding optional attributes. Adding new collections."
> "Backwards incompatible changes... removing an attribute, adding a required attribute, changing the
> type of an attribute."

"In production, it is recommended that you do not make backwards incompatible changes if your client
applications have a durable cache, e.g. one using IndexedDB. You can ensure that all backwards
incompatible changes are rejected by the server by setting the `triplit schema push
--enforceBackwardsCompatibility` flag."

**Q3 — execution model.** Split between server and client. Server: `triplit schema push` diffs the
schema against live data and refuses changes that would invalidate existing entities ("added an
attribute where optional is not set. Fix: make 'tagIds' optional or delete all entities in 'todos'
to allow this edit"). Client: an `onDatabaseInit` hook that "runs after your client-side database has
initialized and before any client operations are run and syncing begins". Backfill is application
code, described step by step: "add the attribute as optional, backfill it for existing entities with
calls to `client.update`... Only when you're confident that all clients have been updated... should
you proceed with a backwards incompatible change." That is expand/contract with the developer
driving every step.

**Q4 — derived / dependent rows.** **Not documented**, and structurally excluded: "relations in
Triplit are just views on data in other collections", so a relation is a query, not a row.

**Q5 — stale / offline clients.** A hard client-side gate at connect: "When a client connects to a
Triplit server, it compares the schema it has stored locally with the schema on the server. If the
schemas are incompatible, the client will refuse to connect to the server. This is a safety feature
to prevent data corruption." Removal of a relation does not corrupt data but "an out-of-date client
continues to issues queries with clauses that reference that relation... the server will reject those
queries", with the documented remedy being to "deprecate clients that are still using the old
relation and force them to update the app with the new schema bundled in".

**Q5/Q6 — what happens to unsynced writes on the local fallback.** The docs give three client
options for a cached database that no longer matches: loosen client assumptions, "run a script on app
load that migrates database to match the new schema", or "clear the local cache on app load" — "None
of these are ideal solutions". The hook's own example implements the last one: on
`EXISTING_DATA_MISMATCH` it calls `db.clear()`, then `overrideSchema`, then retries. The docs do not
say what `clear()` does to pending local mutations — **not documented**.

**Q7 — refusals.** Refuses to widen the legal-change set ("None of these are ideal solutions" for the
rest, and incompatible pushes are rejected). Refuses to version _rows_: every entity in a collection
must satisfy the current schema, so a change is legal only once the data already agrees with it.

## 1.5 Jazz

Jazz is the one shipping product whose migration story is a **direct implementation of the Cambria
model**, and it says so in the doc title: "Change your schema while keeping older clients working"
([migrations](https://jazz.tools/docs/schemas/migrations), retrieved 2026-10-30, CLI at
`jazz-tools@alpha`).

**Q1 — where the schema lives.** In code (`schema.ts`), content-addressed: "Every unique version of
your schema.ts has a hash which can be used to refer to it." Published by `deploy <appId>`, which
"Loads and validates the schema and permissions, then checks the migration path from the currently
deployed schema. Missing required migrations fail before publication" and stores "any missing
schemas and migrations" on the server. So: code is authoritative, the server keeps the history.

**Q2 — what is legal.** Anything you write a lens for, with one documented exception class: when the
diff is ambiguous, the generated lens is a draft that fails closed. "If the diff contains ambiguities
(e.g. a column was removed and a same-typed column was added, which could be a rename), the generated
lens is marked as a draft. Draft lenses will fail at startup if they are in the path to a live
schema. You need to review the draft lens and resolve the ambiguity before publishing."

**Q3 — execution model.** Read/write-time translation; **nothing is rewritten**:

> "Most migration systems are one-way: rewrite every row to the new shape, then cut over. That assumes
> you can stop the world long enough to upgrade — which doesn't hold when your clients are local-first,
> frequently offline, and updating their app on their own schedule. Jazz keeps every schema version
> usable and translates rows between them on read and write. Clients on different versions stay
> interoperable, and nothing on disk is rewritten when you ship a new schema."

Migrations are declared as _reversible operations_, and that is the cost: "The generated stub
describes the diff as declarative operations which carry enough information to run in either
direction. That is how older clients can still read data written under a newer schema: the same
operations replay in reverse." Dropping a column needs an explicit backward value: "When a newer
schema drops a column that older clients still expect, define a backwards default so the lens can
supply a value for those clients" (`s.drop.int({ backwardsDefault: 0 })`).

**Q4 — derived / dependent rows.** **Not documented.** Tables and columns only; a relation is
declared on an existing column — "To add a relationship using an existing ownerId UUID column,
declare `owner: s.rel("users", "ownerId")`... Existing UUID values stay unchanged."

**Q5 — stale / offline clients.** No version gate at all; the lens chain is the compatibility
mechanism — "Fetching all intermediate lenses allows clients with any published schema version to
read data created with any other published schema version." The documented failure state is a
disconnected schema, and it is a _read_ failure, not data loss: "If your database already contains
rows under a historical schema that is disconnected from other schema versions, those rows remain
stored but cannot be read through a schema with no migration path to them."

**Q6 — rebuild vs migrate.** Jazz refuses rebuild as a strategy ("nothing on disk is rewritten"). Its
stated price is the lens chain itself: `deploy` refuses to publish without a complete path, and
ambiguous diffs need human review before they can be published.

**Q7 — refusals.** Refuses to rewrite rows; refuses to infer an ambiguous rename; refuses to publish
a schema whose migration path is incomplete. It does not gate old clients — an old client is
_expected_ to keep working, which is the opposite of Realm/Triplit/Couchbase Lite.

## 1.6 Automerge

**Q1 — where the schema lives.** Nowhere in Automerge. "Automerge documents are quite similar to JSON
objects. A document always consists of a root map which is a map from strings to other Automerge
values, which can themselves be composite types"
([documents](https://automerge.org/docs/reference/documents/)).

**Q2–Q7 — all not documented.** The published docs index
([`llms.txt`](https://automerge.org/llms.txt), retrieved 2026-10-30) lists no schema page and no
migration page for application data. The one page with "migrating" in the title is
`Migrating from Automerge 2 to Automerge 3` — a _library_ upgrade, not a change to the data model.
There is a `Rich Text Schema` reference page, but it documents "the (extremely minimal) schema we use
in the automerge-prosemirror bindings", described on its own page as "a work in progress" — a mark
vocabulary for rich text, not an app-facing document schema
([rich text schema](https://automerge.org/docs/reference/under-the-hood/rich-text-schema/)).

The one documented schema-evolution design _for Automerge_ is Cambria-Automerge, and it is the
research prototype in §2.1 — its own essay calls it a prototype and its README says "still immature
software, and isn't yet ready for production use". Automerge's documented answer to a stale client is
conflict resolution per property, not versioning.

## 1.7 Yjs

**Q1 — where the schema lives.** Nowhere: named shared types (`Y.Map`, `Y.Array`, `Y.Text`,
`Y.XmlFragment`) and `doc.getMap(name)` / `getArray(name)` type constructors
([shared types](https://docs.yjs.dev/api/shared-types.md), [Y.Doc](https://docs.yjs.dev/api/y.doc.md)).

**Q2–Q7 — all not documented**, with one structural constraint that matters for schema design and
_is_ documented, in the FAQ:

> "**Consider using a single top-level YMap:** Top-level shared types cannot be deleted, so you may
> want to structure all your data in a single top-level YMap, eg. `yDoc.getMap('data').get('page-1')`."
> ([FAQ](https://docs.yjs.dev/api/faq.md))

So the one legal-change rule Yjs states is a _refusal_: a top-level type cannot be removed, which
makes the top level of a Yjs document effectively append-only. (Negative claim method: the Yjs docs
publish `llms.txt`; I read the shared-types, Y.Doc and FAQ pages in full and grepped them — no
occurrence of "schema" or "migration".)

## 1.8 Cross-product matrix

|                       | Realm (retired)                                                             | Couchbase Lite                                  | PouchDB/CouchDB                 | Triplit                                       | Jazz                               | Automerge | Yjs                                       |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- | --------------------------------------------- | ---------------------------------- | --------- | ----------------------------------------- |
| Q1 schema location    | client code + server App Schema                                             | none (scopes/collections)                       | none (design docs = views)      | code, pushed live to server                   | code, hashed, history on server    | none      | none                                      |
| Q2 legal change       | anything local; **additive only** synced                                    | any                                             | any                             | add optional attr / add collection            | anything with a reversible lens    | n/a       | any, but top-level types can't be deleted |
| Q3 execution          | client, at open, in place (rewrite)                                         | SDK at open (re-index, lazy version vectors)    | app batch rewrite; view rebuild | server diff on push + client `onDatabaseInit` | read/write-time lens, no rewrite   | n/a       | n/a                                       |
| Q4 derived rows       | **not documented**                                                          | **not documented**                              | derived = views, rebuilt        | **not documented** (relations are views)      | **not documented**                 | n/a       | n/a                                       |
| Q5 stale client gate  | schema version throws at open; breaking change ⇒ client reset               | binary/gateway matrix                           | none (conflicts)                | client refuses to connect                     | none — lenses carry it             | none      | none                                      |
| Q6 rebuild vs migrate | migrate if additive, **rebuild if breaking**                                | rebuild via prebuilt DB per app version         | rebuild derived, rewrite docs   | clear cache option documented                 | refuses rebuild                    | n/a       | n/a                                       |
| Q7 documented refusal | no rename in a migration; no synced rename/type change; no server migration | no schema, no migration API, no major downgrade | no migration API                | rejects incompatible pushes                   | rejects ambiguous/unpathed deploys | no schema | no top-level delete                       |

---

# Part 2 — The literature

## 2.1 Cambria (Ink & Switch, 2020)

**The model.** A graph of schemas connected by **bidirectional lenses**; data is translated along
the shortest path at read time. The unit of translation is not the document but the **patch**:
"Under the hood, Cambria actually works with patches that represent modifications to a JSON document,
evolving those patches between formats" — explicitly built on Hofmann/Pierce/Wagner's _Edit Lenses_.
Applied to Automerge, every write is **schema-tagged** and lenses travel with the document:

> "When a client makes a change, the new operation in the log is tagged with the writer schema... When
> a client applies the log of changes to read a document, each change is first evolved into the
> desired schema before it is applied."
> "A final extension is that lenses are stored in the document itself. When a client is writing to a
> document in a new schema that hasn't been used before in that document, it writes a special change
> to the log that contains the lens source as a JSON document."
> — https://www.inkandswitch.com/cambria/ (Appendix II)

And the design rule that answers #690's question 6 for ebb, stated as a finding:

> "**Data translations in decentralized systems should be performed on read, not on write.** Some of
> our early prototypes... performed data translations at write time... We eventually realized this was
> a flawed strategy. It struggled to handle new schemas getting added later on, after the write had
> already happened... So we switched to a simpler strategy: store a log of raw writes in the form of
> the writer schema, and translate between versions at read time."

**The cost.** Two commitments, both stated by the source:

1. **Bidirectionality is the price of read-time translation.** "Lenses require well-defined
   transformations... Imagine a lens that combines a firstName and lastName fields into a single
   fullName. This lens works reliably in one direction... there are many names which could not be
   reliably converted back." The essay accepts that one operator (`convert`) already "can't guarantee
   a useful consistency relation" and argues for allowing it anyway, "even if it does weaken the
   guarantees". So the source says what the brief suspected: bidirectional lenses are a real
   commitment, and even the reference implementation ships a documented hole in the guarantee.
2. **Patch transformation needs the writer-schema state.** "to perform this resolution process for a
   patch produced by some writer schema, we need to read the current state of the document in the
   writer schema at the time of the patch. As a result, reading a document in one schema can
   actually require reading it in many different schemas if writes were made from many schemas. This
   could be a source of performance problems." Plus: "We have not yet measured Cambria's performance
   in any formal way."

**Which of the seven it answers.**

- Q1 _where the schema lives_ — answered: lenses, versioned as positions in a lens graph, stored
  in the document (and the essay's "lens repositories" section notes per-document storage is
  wasteful).
- Q2 _legal change_ — answered with a boundary: whatever is expressible as a lens; the essay's
  self-critique is that this is narrower than it looks (see the name-splitting example).
- Q3 _execution model_ — answered fully and in the direction ebb already chose (read-time).
- Q4 _derived rows_ — **not answered, and named as unsolved twice.** Under "Augmenting data": "a
  change to a schema may require new data... Cambria has support for providing default data in the
  case of added or removed fields, but **it does not provide a mechanism to look up missing data, and
  so cannot support this kind of change today**." Under "Working across documents": "Moving data
  between documents poses challenges. Splitting one document into many, or migrating data from one
  document to another, are obvious use cases here." Both are the exact shape of ebb's backing
  entity.
- Q5 _stale clients_ — answered for compatibility, unanswered for gating: older clients keep working
  because they can fetch newer lenses from the document. There is no `min_supported_version`
  mechanism; the essay only says "Cambria doesn't force users to collaborate across versions with
  imperfect compatibility, but it provides the option of doing so."
- Q6 _rebuild vs migrate_ — answered by refusal: translation on read, no re-materialization, no
  rewrite. That is the position Jazz has now shipped.
- Q7 _refusals_ — the clearest part of the essay: no data lookup/backfill, no cross-document moves,
  no one-directional lenses in v1, and "we do not pretend to have delivered a fully formed,
  production-quality solution".

**Status.** `cambria-project` README: "⚠ Cambria is still immature software, and isn't yet ready for
production use" (last push 2024-06-14). The pattern's industrial continuation is Jazz (§1.5), not
Cambria.

## 2.2 _Local-first software_ (Ink & Switch, 2019)

**The model.** No model — it is the problem statement, and it is worth citing only because it puts
schema evolution on the "unsolved" list in exactly ebb's terms:

> "We see further interesting problems around types, schema migrations, and compatibility. Different
> collaborators may be using different versions of an application, potentially with different
> features. **As there is no central database server, there is no authoritative "current" schema for
> the data.** How can we write software so that varying application versions can safely interoperate,
> even as data formats evolve? This question has analogues in cloud-based API design, but a
> local-first setting provides additional challenges."
> — https://www.inkandswitch.com/essay/local-first/

It also lists the developer-experience question that #124 answers by fiat: "Do we need schemas and
type checking?"

**What it costs / which questions it answers.** None of the seven. It contributes the constraint that
makes Q5 and Q6 hard (no authoritative schema) and names the problem a year before Cambria. Treat it
as motivation, not pattern.

## 2.3 _Edit Lenses_ (Hofmann, Pierce, Wagner, POPL 2012)

The formal basis Cambria builds on: lenses that operate on _edits_ rather than whole structures, with
the two properties Cambria quotes — a valid edit converts into a valid edit, and a consistency
relation survives edits from both sides. This is where "transform the patch, not only the data" comes
from; the brief's framing is the paper's thesis. It answers Q3's _foundations_ (what makes
patch-level translation well-defined) and nothing about Q1, Q2, Q4, Q5, Q6, or Q7 — it is not a
system. Cambria's appendix is the honest accounting of where the theory does not reach practice
(the `convert` operator, the ID-vs-path problem in Automerge).

## 2.4 What the CRDT literature does not contain

Stated as a finding, with its limits, because it changes what ebb can copy: **there is no CRDT
schema-evolution literature to match the size of the Cambria material.** Method and limits: general
search engines were unreachable from this host during the search, so this
negative is bounded to (a) the primary-source doc indexes already used above, and (b) a Crossref bibliography query for
"CRDT schema evolution" plus variants (the nearest hits were general DBMS-schema-evolution papers —
e.g. Meurice & Cleve, "Supporting schema evolution in schema-less NoSQL data stores", SANER 2017,
DOI `10.1109/saner.2017.7884653`, whose scope is SQL/no-SQL schema diffing, not replicated clients).
Within that envelope: the two CRDT libraries in this leg ship no schema layer at all and their
documentation indexes contain no schema-evolution page (§1.6, §1.7); the one published design that
targets a CRDT is Cambria-Automerge, by the CRDT's own co-author, and it is a research prototype
that names its own gaps. The only CRDT-specific schema-evolution material beyond Cambria that I
could verify at the primary source is the pair of open questions in the Cambria essay (Q4 above:
augmenting data; cross-document splits) and the corresponding paragraph in _Local-first software_.
Everything else in this space is either a product doc (Jazz being the farthest along) or a re-telling.

---

# What this implies for ebb

Observations only; no API proposals. Two things the sources say that matter more than the rest.

## 1. Because the log is append-only, is "migrate" ever needed — or is "re-materialize under a new projection" the documented answer?

**The documented answer is both, and the split is exactly at "does the change alter the shape of the
row that the log already holds".**

- **Re-materialization from the log is a documented strategy, and it is a _derived-data_ strategy.**
  CouchDB is the clearest case: changing a design document "will invalidate those other views'
  indexes when the design document is written, forcing them all to rebuild from scratch" — the
  source of truth (documents) is untouched; the projection is rebuilt. Couchbase Lite's prebuilt
  database is the same move at the replica level ("Create a fresh Couchbase Lite database (every
  time)", `Database.copy()`), and its cost is stated (re-index delay, checkpoint/UUID hazards).
  Nobody documents re-materialization as a way to change the _schema of the stored rows_ — CouchDB
  does not document schema migrations at all, and Couchbase Lite has no schema to migrate.
- **The systems that do have to change stored shape do not use re-materialization for it; they use
  it to _escape_ a change they cannot migrate.** Realm is the case study. Non-breaking change:
  in-place migration at open. Breaking change: client reset, i.e. discard local state and re-download
  the server's. So "re-materialize" in Realm is the _failure_ path, and the docs put the price in
  plain text for exactly the case in the brief — **outbox non-empty, network off**: "Do not expect to
  recover all unsynced data after a breaking schema change", recovery needs a `lastUpdated` property
  added to _every object model_ (a schema concession made for the migration's benefit), and recovery
  can overwrite fields other clients wrote.
- **The one system that refuses both — migrate and re-materialize — is the one closest to ebb.**
  Jazz: "nothing on disk is rewritten when you ship a new schema", because every schema version stays
  readable through a lens chain, at the cost of a complete and reversible migration path per deploy
  (`deploy` "Missing required migrations fail before publication"; ambiguous diffs are drafts that
  "fail at startup"). Cambria states the same rule as a finding ("translate on read, not on write")
  and adds the reason it matters for a log: "It struggled to handle new schemas getting added later
  on, after the write had already happened" — an append-only log can _never_ go back and re-tag old
  writes, which is precisely the property ebb's log has.
- **What ebb already documents is closer to re-materialization than to migration, and it is the
  cheaper half of Realm's answer.** #476 §6.3 specifies a full local sync reset that discards the
  log, replica and cursors and **keeps the outbox**, then "Seed first, then re-apply every live
  outbox entry (`pending`/`acknowledged`/`error`/`conflicted`)" — with the reason: a base put must
  land before the optimistic row, because `applyUpdate`'s PUT is a full replacement. The sources above
  do not have an equivalent move: Realm's reset does not re-apply an intent log, it tries to merge
  state, which is why its recovery needs timestamps on every model. The structural reason ebb can do
  this is the one thing in ebb's favour here — its unsynced unit is an Action (intent), not a row
  (state).

**Honest limit of that reading:** re-materializing a replica under a new projection does not touch the
_contents_ of the outbox. A pending Action written against the old field names still names the old
fields when it is re-applied, and no source in this leg describes replaying an intent log across a
schema change — Cambria transforms _patches_ from an old schema, which is the closest documented
analogue, and it warns that doing so requires reading the document in the writer's schema at the time
of the patch, and that it has never been measured. Whether an ebb outbox entry _is_ a patch in
Cambria's sense is the question I could not answer from the sources.

## 2. Does any source treat a _derived/backing entity_ as a first-class migration problem?

**No. Not one.** Every system in this leg assumes the change lands on the row that already exists:

- Realm: the migration function sets properties on `oldRealm.objects(...)`; renames are copy + delete
  on the same object; nothing in the docs creates an object of _another_ type from a migration.
- Triplit: the fix for every incompatible change is "backfill it for existing entities with calls to
  `client.update`" — a field write. Relations are "just views on data in other collections", so a
  relation can never require a row.
- Jazz: relations are declared on an existing UUID column and "Existing UUID values stay unchanged";
  the migration vocabulary is add/drop/rename of _columns_ (`s.add.string`, `s.drop.int`).
- Couchbase Lite, PouchDB/CouchDB, Automerge, Yjs: no schema to derive from.
- Cambria: names the problem and declines it. "it does not provide a mechanism to look up missing
  data, and so cannot support this kind of change today" (_Augmenting data_), and "Splitting one
  document into many... [is an] obvious use case" left as an open question (_Working across
  documents_). Its lens vocabulary (`rename`, `convert`, `wrap`, `head`, `hoist`, `add`, `remove`)
  has no operator that creates a second document.

So **ebb is alone** in making a derived row the unit of the field declaration, and the literature's
nearest vocabulary for it is a _cost_ it explicitly will not pay. The consequence worth recording for
#124: for every other system, "migration" is a function over a row that exists; for ebb the body case
is "a row that does not exist yet must be created, and created exactly once, by one of an unknown
number of offline actors" — which is a write-path problem (idempotency, enumeration, convergence in
#690's wording), not a projection problem. Nothing in this leg documents that problem being solved.

## What I would check next (against sources, not against intuition)

1. **PowerSync and Ditto** — the two named Device Sync successors — to see whether either documents an
   outbox-preserving rebuild, since that is the closest analogue to #476 §6.3 and the only place a
   resolved answer might exist. (Leg A / follow-up.)
2. **Whether an ebb outbox entry is a Cambria patch**: if an Action is a patch over named fields, then
   Cambria's patch-transformation (and its documented cost) is directly applicable to #690's stale
   outbox; if it is a whole-row assertion (`applyUpdate`'s PUT is a "full replacement", #476), it is
   not, and the read-time migration in #124 is the only documented fit.
3. **Jazz's `s.rel` + lens interaction** as the nearest documented answer to "a field that is a
   reference" — it shows the shape ebb would need if the backing body were expressed as a relation
   rather than a generated entity, and it has no backfill story either.
