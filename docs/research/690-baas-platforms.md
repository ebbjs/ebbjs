# Server-authoritative platforms: schema evolution and migration (#690, leg A)

Research leg A of #690. Every claim below comes from the platform's own documentation,
read on **2026-10-30**, with the URL that owns the claim next to it. Hosted doc sites
were read as served that day; there is no pinned doc version unless the page states one
(noted per platform). **"Not documented"** means I read that platform's own pages on the
subject and they do not answer the question — it is never a guess about the
implementation. No secondary source (blog, talk, third-party write-up) is used for any
claim in this file.

Scope is server-authoritative systems only: Supabase, Convex, Firestore, InstantDB,
Hasura, PocketBase, Zero, PowerSync, ElectricSQL. Client-side replicas and the
local-first literature are the other leg (`690-local-first-schema-evolution.md`);
the synthesis is separate. Branch `docs/issue-690-baas-platforms`, off `origin/main`
@ `5e79f05`.

Two questions from the issue are load-bearing enough that they get their own sections
after the platform notes: **derived/dependent rows** and **rebuild vs migrate**.

## Doc sets read

| Platform       | Surface read                                                                | Version notes                                                                     |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Supabase       | CLI reference, database-migrations guide, declarative-schemas guide, Realtime | CLI with both diff engines: legacy `migra` and `pg-delta` (`[experimental.pgdelta]`) |
| Convex         | `docs.convex.dev` (markdown source), `@convex-dev/migrations` README         | docs as of 2026-10-30; migrations component from `get-convex/migrations@main`       |
| Firestore      | Firestore data model, extend-with-functions, offline persistence             | Cloud Firestore; Cloud Functions 1st gen page (2nd gen cross-referenced)           |
| InstantDB      | modeling-data, CLI, patterns; `llms.txt`                                     | docs carry a sunset notice: services until 2027-08-31                              |
| Hasura         | v2 docs: migrations-metadata-seeds, manage-migrations, best practices, event triggers | pages self-identify as "Version: v2.x"                                    |
| PocketBase     | js-migrations, collections, FAQ                                              | docs as of 2026-10-30; `--automigrate` default                                     |
| Zero           | full docs corpus (`llms-full.txt`): schema, when-to-use, debug/replication    | Zero as of 2026-10-30 (`zero-cache`, `zero.schemaVersions`)                        |
| PowerSync      | full docs corpus (`llms-full.txt`): client-architecture, raw-tables, compatibility, compacting-buckets | Service ≥ 1.27.0 defaults/notes cited where relevant        |
| ElectricSQL    | `postgres-sync`, `docs/sync/guides/shapes`                                   | Postgres Sync (formerly "Electric"), 1.x                                          |

---

## 1. Supabase

Postgres, migrations as SQL files, an optional declarative layer, and a CLI that
diffs. The platform's job ends at "apply these statements to that database".

1. **Where the schema lives.** `supabase/migrations/<timestamp>_<name>.sql`, in git;
   applied state in `supabase_migrations.schema_migrations`
   (<https://supabase.com/docs/guides/deployment/database-migrations>). Optionally
   `supabase/schemas/*.sql` as desired state: "Because the schema files are the source of
   truth, make every change by editing them, not through Studio or the SQL editor"
   (<https://supabase.com/docs/guides/local-development/declarative-database-schemas>).
   The Dashboard is legal **locally only**: "Making schema changes directly on your
   remote database (via the SQL editor or Table Editor) bypasses the migration history
   and will cause `db push` to fail with sync errors"
   (<https://supabase.com/docs/guides/deployment/database-migrations>). Two diff engines
   are documented — `pg-delta` and the "legacy `migra` engine" — chosen by
   `[experimental.pgdelta]` in `config.toml`; the declarative commands "require it and
   won't run on the legacy engine"
   (<https://supabase.com/docs/guides/local-development/declarative-database-schemas>).
2. **What is legal without downtime.** No platform-level rule; it is whatever SQL you
   write. The documented discipline is additive-by-convention: "always append new
   columns to the end of the table" to keep generated diffs clean
   (<https://supabase.com/docs/guides/local-development/declarative-database-schemas>),
   and the guide for a heavily used table is to raise `lock_timeout` in the migration
   file (<https://supabase.com/docs/guides/deployment/database-migrations>).
3. **Execution model.** Imperative SQL files, applied "in timestamp order", skipping
   versions already recorded: "Subsequent pushes will skip migrations that have already
   been applied" (<https://supabase.com/docs/reference/cli/supabase-db-push>).
   `--include-all` applies "all migrations not found on remote history table".
   Declarative mode diffs the **files against the migration history, not the live
   database**: "Changes made directly to the database are not picked up", and
   "the diff … reports 'No schema changes found' and silently drops the change"
   (<https://supabase.com/docs/guides/local-development/declarative-database-schemas>).
   Diffing a live database is a different command against a *shadow* database built by
   replaying the migration directory
   (<https://supabase.com/docs/reference/cli/supabase-db-push>, `db diff`).
4. **Derived / dependent rows.** No feature. There is no job, no cursor, no idempotency
   helper — a migration is SQL, so a backfill is `insert … select` you write, and the
   documented limitation of squashing is that "data manipulation statements, such as
   insert, update, or delete, are omitted from the squashed migration"
   (<https://supabase.com/docs/reference/cli/supabase-db-push>). Concurrency is
   documented as a human process, not a mechanism: "Coordinate so only one person runs
   `db push` at a time. Migration files are applied in timestamp order, so concurrent
   pushes from different machines can cause conflicts"
   (<https://supabase.com/docs/guides/deployment/database-migrations>). The only
   built-in dedupe is per-migration-per-database, via the history table.
5. **Stale / offline clients.** Not documented. These pages describe no schema version
   on the wire, no `min_supported_version` gate, and no offline write queue. Realtime is
   documented as Broadcast, Presence and Postgres Changes
   (<https://supabase.com/docs/guides/realtime>) — a change feed, with the word
   "offline" absent from that page.
6. **Rebuild vs migrate.** Migrate, with a local rebuild. `db reset` "Recreates the local
   Postgres container and applies all local migrations … If test data is defined in
   `supabase/seed.sql`, it will be seeded after the migrations are run"
   (<https://supabase.com/docs/reference/cli/supabase-db-push>). Against a linked
   project the same command "is executed to identify and drop all user created entities
   in the remote database". There is no log replay and no client re-sync, because there
   is no client copy. `supabase migration down` "Resets applied migrations on the
   database" — it rewinds *history entries*, not data — and `migration repair`
   "updates the tracking table only — it does not apply or revert any SQL"
   (<https://supabase.com/docs/guides/deployment/database-migrations>).
7. **Documented non-goals.** No down-migration artifact (down = reset history). No
   automatic drift reconciliation: `db push` fails and points at `migration repair`.
   `squash` is explicitly lossy for DML. Declarative sync will not read the live
   database. The platform owns DDL application; everything about compatibility of the
   *data shape* is the application's problem.

---

## 2. Convex

The only platform in this set with a first-party, documented, resumable backfill job —
and the only one whose backfill runs as real mutations on the live write path.

1. **Where the schema lives.** `convex/schema.ts` in code, `defineSchema`/`defineTable`
   with `v` validators (<https://docs.convex.dev/database/schemas>). Schema is optional:
   `schemaValidation: false` disables runtime checking, `strictTableNameTypes: false`
   allows tables outside the schema. Pushed by the CLI — "Schemas are pushed
   automatically in `npx convex dev` and `npx convex deploy`" — so the schema is versioned
   with the code and applied per deployment. The dashboard *reads* it (a "View schema
   file" panel generates a declaration) but is not the source of truth
   (<https://docs.convex.dev/database/schemas>).
2. **What is legal without downtime.** Adding an optional field, and widening a field to
   `v.union(old, new)`. Anything that existing documents violate is refused at push:
   "The first push after a schema is added or modified will validate that all existing
   documents match the schema. If there are documents that fail validation, the push will
   fail." Renames are steered away from: "Create new columns or fields, rather than
   changing their type" (first-party blog by a Convex engineer,
   <https://stack.convex.dev/intro-to-migrations> — labelled secondary use: it is the
   page the component README points at for the online/offline framing; the enforced
   behaviour it describes is stated in the docs above).
3. **Execution model.** Three documented mechanisms:
   - **Staged validators.** `.staged({...})` validates the change in the background
     "without delaying deployment. The current validator remains enforced on writes while
     validation runs. Once validation succeeds, you can promote the change without
     repeating the scan." Progress via `npx convex deploy --dry-run` ("validating,
     validated, or failed"); one staged validator per table; a write that passes the
     enforced validator but fails the staged one "succeeds and marks staged validation as
     failed" (<https://docs.convex.dev/database/schemas>).
   - **The `@convex-dev/migrations` component.** `migrateOne` per document, fetched "in
     batches of 100", cursor persisted, `dryRun`, `reset`, serial `runner([...])`,
     `customRange` over an index to migrate a subset
     (<https://github.com/get-convex/migrations/blob/main/README.md>).
   - **Hand-written mutations**, per the documented five steps: widen the schema → write
     the migration → push → run to completion → tighten the schema, which "will only
     succeed once all the data matches the new schema"
     (<https://github.com/get-convex/migrations/blob/main/README.md>).
4. **Derived / dependent rows.** Explicitly in scope: "Making changes is optional, and
   you can also read and write to other tables from this function"
   (<https://github.com/get-convex/migrations/blob/main/README.md>). Job-level
   concurrency is documented and handled: "If it is already running it will refuse to
   start another duplicate worker"; it resumes from the failed batch unless given
   `cursor`/`reset`; the serial runner skips completed migrations and no-ops on one
   already in progress. Effect-level isolation is **not** handled: with
   `parallelize: true`, "ensure your callback doesn't assume that each call is isolated …
   if each call reads then updates the same counter, then multiple functions in the same
   batch could read the same counter value", which is why "migrations are run serially by
   default". Transactional backing is documented separately: mutations are deterministic
   and serializable, and an OCC conflict is simply re-run — "we can simply re-run the
   transaction; you never need to worry about temporary data races"
   (<https://docs.convex.dev/database/advanced/occ>).
5. **Stale / offline clients.** Not documented as a version handshake. The documented
   compatibility mechanism is shape-tolerance in code: step 1 of the migration recipe is
   "Modify your schema to allow old and new values … update your code to handle both
   versions", and clients reach the same functions by name, so old shapes only break when
   a function or field is removed. No `min_supported_version`-style gate appears on these
   pages.
6. **Rebuild vs migrate.** Migrate, not rebuild. There is no client replica to
   re-materialize; the closest thing is a destructive restore: "restoring is a destructive
   operation that wipes your existing data and replaces it with that from the backup",
   taking "a few seconds to a few hours"
   (<https://docs.convex.dev/database/backup-restore>).
7. **Documented non-goals.** No DDL or SQL to write — "there is no need to write any
   `CREATE TABLE` statements"
   (<https://docs.convex.dev/database/advanced/schema-philosophy>). Migrations are not a
   platform primitive: they are an opt-in component with its own npm package, plus
   hand-rolled mutations. Nothing documents automatic rollback of a partially applied
   migration beyond `reset: true` re-running from the beginning.

---

## 3. Firestore (the schemaless counterexample)

1. **Where the schema lives.** Nowhere. "Cloud Firestore is schemaless, so you have
   complete freedom over what fields you put in each document and what data types you
   store in those fields. Documents within the same collection can all contain different
   fields or store different types of data in those fields."
   (<https://firebase.google.com/docs/firestore/data-model>). Collections and documents
   are implicit: "If either the collection or document does not exist, Cloud Firestore
   creates it."
2. **What is legal without downtime.** Everything, at the storage layer — the same page
   then states the only constraint is a recommendation: "it's a good idea to use the same
   fields and data types across multiple documents, so that you can query the documents
   more easily." Nothing is forbidden and nothing is enforced.
3. **Execution model.** No DDL, no migration artifact, no version. A data transformation
   is application code: Cloud Functions reacting to writes, or a client rewrite. The only
   first-party execution vehicle documented is the event trigger.
4. **Derived / dependent rows.** Cloud Functions Firestore triggers, with the
   at-least-once guarantee stated as a warning rather than a feature: "Ordering is not
   guaranteed. Rapid changes can trigger function invocations in an unexpected order."
   and "Events are delivered at least once, but a single event may result in multiple
   function invocations. Avoid depending on exactly-once mechanics, and write idempotent
   functions."
   (<https://firebase.google.com/docs/firestore/extend-with-functions>). This is the
   clearest documented statement in the whole survey that derived-row correctness is the
   application's obligation.
5. **Stale / offline clients.** There is no schema to be stale against. Offline writes are
   queued and merged LWW: "When the device comes back online, Cloud Firestore
   synchronizes any local changes made by your app to the Cloud Firestore backend. For
   multiple changes to the same document, it's last write wins."
   (<https://firebase.google.com/docs/firestore/manage-data/enable-offline>). No
   min-version gate is documented — there is nothing to gate on.
6. **Rebuild vs migrate.** Neither is named. Clients hold a cache, not a materialized
   projection with a schema, so a "rebuild" is just a re-read. No log-replay or
   schema-versioned snapshot is documented on these pages.
7. **Documented non-goals.** No schema, no migration tooling, no exactly-once delivery,
   no ordering guarantee. The docs state these as properties, not as gaps.

---

## 4. InstantDB

1. **Where the schema lives.** `instant.schema.ts` in code — `i.schema({ entities, links })`
   with typed attributes (`i.string()`, `i.number()`, `i.date()`, `i.json()`, `i.any()`)
   (<https://www.instantdb.com/docs/modeling-data>) — and permissions in
   `instant.perms.ts`. Pushed by `instant-cli push schema`, which "will evaluate your
   schema, compare it with production, and migrate your data model"; `pull` regenerates
   the files from production state (<https://www.instantdb.com/docs/cli>). Local vs
   production is two separate apps, each pushed to explicitly
   (<https://www.instantdb.com/docs/patterns>).
2. **What is legal without downtime.** Creation is unrestricted by default: "new
   `entities` and `attributes` can be created on the fly when you call `transact`. This
   can be useful for development, but you may not want this in production", with the
   documented lockdown `{"attrs": {"allow": {"$default": "false"}}}`
   (<https://www.instantdb.com/docs/patterns>). Attributes are **required by default** and
   "Instant guarantees that every entity of that type will have a value and reports errors
   if you attempt to add an entity without a required attribute"
   (<https://www.instantdb.com/docs/modeling-data>), so tightening a field is blocked until
   data matches (see 4). A rename must be *declared*: "the CLI needs to know whether you
   intend to rename the existing field or delete the old one and create a new one", either
   interactively or with `--rename posts.author:posts.creator`
   (<https://www.instantdb.com/docs/cli>). Attribute **type** changes are not documented —
   no page I read states what `i.string()` → `i.number()` does.
3. **Execution model.** Plan-then-apply at the CLI (it prints "The following changes will
   be applied to your production schema: ADD ENTITY … ADD ATTR …" before applying,
   <https://www.instantdb.com/docs/modeling-data>), plus hand-written admin scripts for
   data. Hard limits shape the design: "Right now we have a hard limit of 5 seconds for
   both queries and transactions"
   (<https://www.instantdb.com/docs/patterns>).
4. **Derived / dependent rows.** The documented pattern is a **manual admin backfill run
   before the push**. Making an optional attribute required fails with
   `INVALID DATA adding required constraint to todos.done` listing offending entity ids;
   "The solution is to run an admin script to backfill the null values before pushing the
   schema change", a script that queries `$isNull`, maps `tx.todos[id].update(...)` and
   calls `db.transact(updates)`; then `npx tsx scripts/backfill-todos.ts && npx
   instant-cli push` (<https://www.instantdb.com/docs/patterns>). Two consequences are
   documented and one is not: the whole update set is one transaction (so it is all-or-
   nothing up to the 5 s limit), and there is no job state, no cursor, no `dryRun`.
   Idempotency and concurrent runners are **not documented**.
5. **Stale / offline clients.** Not documented on these pages: no schema version
   handshake, no minimum-version gate.
6. **Rebuild vs migrate.** Migrate only. No re-materialization path is documented; the
   store is a triple/log store internally but no page exposes replay as a schema tool.
7. **Documented non-goals.** No migration framework, no backfill job, no server-side
   function runtime in the schema model (writes are client `transact` plus the admin SDK —
   the pages read describe no other backfill runtime). And the whole platform is
   time-boxed: "Instant is sunsetting. Services will continue until August 31st, 2027."
   (<https://www.instantdb.com/docs/modeling-data>).

---

## 5. Hasura

Two separately versioned artifacts — SQL migrations and Metadata — plus event triggers as
the documented derived-row vehicle.

1. **Where the schema lives.** `migrations/<database>/<timestamp>_<name>/{up,down}.sql`
   plus `/metadata` (Metadata "represents the configuration state of your project");
   both in git, both applied by the CLI
   (<https://hasura.io/docs/2.0/migrations-metadata-seeds/overview/>). Migrations are
   generated by the Console *served by the CLI*: "Only changes to the database schema made
   using the Console served by the Hasura CLI will be tracked with Migrations. Changes made
   using the Console served by the Hasura Server itself at `/console` will not be tracked."
   (<https://hasura.io/docs/2.0/migrations-metadata-seeds/manage-migrations/>).
2. **What is legal without downtime.** Whatever SQL, but the documented pattern for a
   large table is expand/copy/swap: "instead of adding a column directly to a heavily used
   table with thousands of rows in production, consider creating a new table with the
   required columns, migrating the data in batches, and then swapping the tables", with the
   `CREATE TABLE … AS TABLE … WITH NO DATA` / batched `INSERT … SELECT … LIMIT` /
   `DROP`+`RENAME` snippet
   (<https://hasura.io/docs/2.0/migrations-metadata-seeds/migration-best-practices/>).
3. **Execution model.** `hasura migrate apply` sends each migration "via a `run_sql` API
   request"; the server tracks versions — "Hasura Server keeps track of which Migrations
   have already been applied and will not reapply a migration if it has already been
   applied." Bootstrap from a live Postgres with `migrate create --from-server` (Postgres
   only). Metadata is applied separately: `hasura metadata apply` then
   `hasura metadata reload`
   (<https://hasura.io/docs/2.0/migrations-metadata-seeds/manage-migrations/>). `squash`
   merges versions and then marks the squashed version applied with `--skip-execution`,
   because "all the Migrations included in the squash have already happened on the Server".
4. **Derived / dependent rows.** Event Triggers fire on INSERT/UPDATE/DELETE to a webhook
   (<https://hasura.io/docs/2.0/event-triggers/overview/>). Delivery is explicitly weak:
   "Event webhook notifications will be delivered at least once, and may arrive out of
   order with respect to the underlying event"; retries are off by default
   (`retry_conf.num_retries: 0`, `interval_sec: 10`, `timeout_sec: 60`); and — the most
   directly relevant note in this survey — **multiple server instances on one database are
   undefined**: "Event Triggers store their data in the underlying database and hence
   different instances acting on the same data can cause undefined behavior during
   run-time. This should not be a problem if the Hasura instances have the same metadata."
   (<https://hasura.io/docs/2.0/event-triggers/create-trigger/>). The alternative
   documented route is a batched backfill inside a migration (see 2).
5. **Stale / offline clients.** Not documented as gating. The GraphQL schema is derived
   from Metadata, so a metadata change is a client-visible break; the documented answer is
   deploy/CI ordering and `metadata reload`, not a client version handshake.
6. **Rebuild vs migrate.** Migrate, with best-effort reverse SQL. Every change gets an
   `up.sql`/`down.sql` pair, and rollback is `hasura migrate apply --type down` / `--down N`
   — but the guarantee is one-directional: "While we guarantee that `up.sql` files will be
   syntactically correct, if you need to roll back changes with `down.sql` files it is
   advisable to first check the `down.sql` files", and raw SQL from the SQL tab gets no
   `down.sql` at all
   (<https://hasura.io/docs/2.0/migrations-metadata-seeds/manage-migrations/>). No log
   replay.
7. **Documented non-goals.** Auto-generated down migrations are not guaranteed correct.
   Data migrations are hand-written SQL (the CLI will only capture the insert you wrote).
   Multi-instance event trigger safety is not guaranteed. Metadata and SQL are two
   artifacts that can disagree, and `--skip-execution` / `migration repair`-style flagging
   is the escape hatch.

---

## 6. PocketBase

1. **Where the schema lives.** Collections, backed by generated SQLite tables; managed in
   the Dashboard, the Web API, or migrations in Go/JS
   (<https://pocketbase.io/docs/collections/>). With `--automigrate` (default), "every
   collection configuration change from the Dashboard (or Web API) will generate the
   related migration file automatically"
   (<https://pocketbase.io/docs/js-migrations/>). Applied filenames go in `_migrations`.
2. **What is legal without downtime.** Not documented as a matrix. The tools are snapshot
   import modes: `migrate collections` writes a full snapshot, and "By default the
   collections snapshot is imported in extend mode, meaning that collections and fields
   that don't exist in the snapshot are preserved", with an opt-in to delete
   (<https://pocketbase.io/docs/js-migrations/>). Whether an existing record's value
   survives a field type change is not documented.
3. **Execution model.** Every unapplied file in `pb_migrations` "will be executed
   automatically in a transaction on serve (or on `migrate up`)"; `migrate(upFunc,
   downFunc)` with the down optional; the callbacks get "a transactional app instance";
   raw SQL is a documented migration body
   (`app.db().newQuery("UPDATE articles SET status = 'pending' …").execute()`)
   (<https://pocketbase.io/docs/js-migrations/>). Manual applies require a `serve` restart
   to refresh cached collections.
4. **Derived / dependent rows.** No dedicated primitive; the vehicle is migration code,
   which the docs demonstrate creating records directly (the "Creating initial superuser"
   example builds a `Record` and `app.save(record)`)
   (<https://pocketbase.io/docs/js-migrations/>). "Several server instances running it at
   once" is not documented because the deployment model is one server (see 7).
5. **Stale / offline clients.** Not documented. No schema version advertised, no
   minimum-version gate.
6. **Rebuild vs migrate.** Migrate, forward and backward: `migrate down [number]`, plus
   `migrate history - sync` (printed that way in the docs) to "remove any entry from the
   `_migrations` table that doesn't have a related migration file" — the squash-equivalent
   (<https://pocketbase.io/docs/js-migrations/>). No re-materialization from a log.
7. **Documented non-goals.** Scaling: "Only on a single server, aka. vertical."
   Database: "PocketBase uses embedded SQLite (in WAL mode) and there are no plans for
   supporting other databases"; replication is delegated — Litestream "could be" a
   companion. Data movement: "We don't have builtin data import/export helpers at the
   moment." (<https://pocketbase.io/faq/>)

---

## 7. Zero

The most explicit treatment of schema versioning on the wire of any platform surveyed, and
the only one that documents deploy *ordering* as arithmetic.

1. **Where the schema lives.** Two schemas. The Postgres schema is the source of truth;
   the **Zero schema** in `schema.ts` provides query types and relationships and is
   "usually generated from your backend schema" (drizzle-zero / prisma-zero) or written by
   hand (<https://zero.rocicorp.dev/docs/schema>). `zero-cache` keeps a SQLite replica with
   its own bookkeeping tables, including `zero.schemaVersions` and a per-row `_0_version`
   (<https://zero.rocicorp.dev/docs/debug/replication>).
2. **What is legal without downtime.** Any Postgres DDL, subject to a documented deploy
   order. Expand: "Deploy providers before consumers. DB → API → Client." Contract: "Deploy
   consumers before providers. Client → API → DB." Renames are compound: "Add new +
   Migrate → Remove old", and the migration is a PL/pgSQL trigger that dual-writes old and
   new columns. "**Incorrect deployment order will cause downtime**: If you deploy the API
   server before the schema change has replicated, mutators and/or queries will fail
   because they will refer to non-existent columns."
   (<https://zero.rocicorp.dev/docs/schema>)
3. **Execution model.** DDL on Postgres, then `zero-cache` does the replica-side work
   itself: "Zero backfills existing data to the replica in the background after detecting
   a new column. The new column is not exposed to the client until all data has been
   backfilled, which may take some time depending on the amount of data." Progress is
   observable — Cloud dashboard, or `SELECT * FROM "<app>/cdc"."backfilling" WHERE
   "schema" = 'public'`, or by watching synced rows
   (<https://zero.rocicorp.dev/docs/schema>). No row transformation, no read-time
   projection: the column exists in Postgres or it does not.
4. **Derived / dependent rows.** Not a Zero concept — derived rows are Postgres rows, so
   the documented vehicle is a trigger (the rename recipe's dual-write trigger) or your own
   SQL. Concurrency is not an application concern either: backfill is driven by the
   replication stream inside `zero-cache`, and `zero-cache` "can run horizontally scaled"
   in production (dev caveat noted:
   <https://zero.rocicorp.dev/docs/debug/replication>).
5. **Stale / offline clients.** The only documented wire handshake here: "When a client
   connects to `zero-cache`, it sends the schema it was built against. If that schema is
   incompatible with what `zero-cache` has (for example if server has just contracted), the
   client receives an error and calls `onUpdateNeeded`" — with
   `reason.type === 'SchemaVersionNotSupported'` and a default of `location.reload()`
   (<https://zero.rocicorp.dev/docs/schema>). Development-mode mismatches behave the same
   way: "If the Zero client ever detects that its schema is incompatible with the server,
   it disconnects and fires the `onUpdateNeeded` event."
6. **Rebuild vs migrate.** Rebuild is a designed, repeated operation. "It is always safe
   to wipe the replica. Wiping will have no impact on your upstream database. Downstream
   zero-clients will get re-synced when they connect."
   (<https://zero.rocicorp.dev/docs/debug/replication>). Documented triggers for a full
   re-sync: replication slot invalidated or missing, Postgres timeline change after PITR,
   a changed publication set — "changing the set of publications will result in resyncing
   the replica, which may involve downtime (replication lag) while the new replica is
   initializing" — and an `auto-reset` mode that resets "the replica and all synced
   clients", documented as "a heavy-weight operation [that] can result in user-visible
   slowness or downtime if compute resources are scarce"
   (<https://zero.rocicorp.dev/docs/debug/replication>). Cost is bandwidth on reconnect,
   not a lost outbox, because offline writes are out of scope (see 7).
7. **Documented non-goals.** "Zero is not local-first. It's a client-server system with an
   authoritative server." / "Zero doesn't support offline writes." / TypeScript clients
   only / "We currently recommend Zero for use with datasets less than 100GB" (SQLite
   replica ceiling) (<https://zero.rocicorp.dev/docs/when-to-use>).

---

## 8. PowerSync

The closest architectural analogue to ebb in this set: a client-side schema applied as
views over schemaless JSON, so that "no migrations are required" — and a documented,
explicit list of where that stops working.

1. **Where the schema lives.** Two places, neither of them the server database. The
   client-side schema is declared in code when the SDK instantiates its database
   ("tables, columns and indexes that correspond to your Sync Streams"), and the service
   side is a Sync Config of streams. The client schema is *projection*, not storage: "The
   tables defined in your client-side schema … are created as *SQLite views* based on the
   schemaless JSON data being synced"; `ps_data__<table>` holds JSON "so this table's
   schema does not change when columns are added, removed or changed"
   (<https://docs.powersync.com/architecture/client-architecture>).
2. **What is legal without downtime.** Any column/table change in the normal (view) path:
   "In PowerSync's JSON-based view system the client-side schema is applied to the
   schemaless data, meaning no migrations are required. Raw tables however are excluded
   from this, so it is the developer's responsibility to manage migrations for these
   tables." (<https://docs.powersync.com/client-sdks/advanced/raw-tables>)
3. **Execution model.** Three documented modes:
   - Views (default): adding or removing a column only changes the view definition over
     unchanged JSON — "making the schema a stateless structure".
   - Deferred table adoption: synced tables not in the client schema sit in `ps_untyped`;
     "If the table is added to the schema at a later point, the data is then migrated to
     `ps_data__<table>`" automatically
     (<https://docs.powersync.com/architecture/client-architecture>).
   - Raw tables: real SQLite DDL plus one of three documented remedies — clear and
     re-download (`disconnectAndClear()`, with a `soft` variant that "keeps PowerSync's
     internal copy of the synced data" so it need not be re-downloaded), or
     `ALTER TABLE … ADD COLUMN priority INTEGER DEFAULT 1 NOT NULL; SELECT
     powersync_trigger_resync(TRUE);` with a caveat that "the optimistic default value
     would be overridden on the next completed sync", or the `_extra` column that stores
     "values from the backend database that a client is not yet aware of"
     (<https://docs.powersync.com/client-sdks/advanced/raw-tables>).
4. **Derived / dependent rows.** Not a PowerSync concern — rows are the backend's. What
   PowerSync documents instead is the *client-side migration ledger*: `ps_migration` is
   described as "Table keeping track of Client SDK schema migrations", and raw-table
   migrations run once per client database, i.e. per device, not per user action
   (<https://docs.powersync.com/architecture/client-architecture>,
   <https://docs.powersync.com/client-sdks/advanced/raw-tables>).
5. **Stale / offline clients.** No version gate documented; the failure mode is
   *invisibility*, not error — an old client's views simply do not select columns it does
   not know about, and the `_extra` pattern exists precisely so an old client cannot lose
   data written by a newer backend. Raw tables are where this breaks, and the docs say so.
6. **Rebuild vs migrate.** Both, at two levels, with documented costs. Client:
   `disconnectAndClear()` then re-download — "the next sync must download that data again,
   leaving synced data unavailable until the sync completes". Service: "Without incremental
   reprocessing, deploying Sync Streams recreates all buckets from scratch. This has the
   same effect as defragmenting and compacting every bucket, and clients download all their
   data again." With incremental reprocessing, "a Sync Streams deployment only snapshots
   the streams that were added or changed. Clients continue using the current copy of the
   data until the new one is ready"
   (<https://docs.powersync.com/maintenance-ops/compacting-buckets>). Storage-format
   changes use the same copy-then-switch shape: "Changing the version does not rewrite the
   current data in place. When you next deploy the Sync Config, PowerSync prepares a new
   copy using the selected version. Clients continue using the current copy until the new
   one is ready. This avoids taking the instance offline for a bucket storage migration."
   (<https://docs.powersync.com/sync/advanced/compatibility>)
7. **Documented non-goals.** The view model deliberately has no migration story — which is
   only sound because it is stateless. Raw tables are opt-in and explicitly the developer's
   problem. And the model assumes complete rows: a raw table must store "a full row as
   expected by PowerSync", which is why `_extra` exists.

---

## 9. ElectricSQL

Read-path only, and the cleanest statement of the "invalidate and re-materialize" answer.

1. **Where the schema lives.** In Postgres — "Postgres Sync … uses your existing schema"
   (<https://electric-sql.com/sync/postgres-sync>). Electric holds no schema of its own;
   a Shape is a query parameterised at request time (`table`, `where`, `columns`,
   `queryable_columns`), so there is no deployed schema artifact to version
   (<https://electric-sql.com/docs/sync/guides/shapes>).
2. **What is legal without downtime.** Any DDL, at the price of invalidation: "When the
   schema of a table used by a shape changes — for example, adding, removing, or renaming a
   column — Electric automatically invalidates all shapes on that table. This is because
   the shape log was built against the old schema and may be missing data for new columns
   or contain references to removed ones." Detection is two-layered: relation messages on
   the replication stream, plus "a background process checks every 60 seconds whether
   cached table metadata still matches the actual database schema, catching changes that
   may not trigger a relation message (such as adding a default value to an existing
   column)" (<https://electric-sql.com/docs/sync/guides/shapes>).
3. **Execution model.** DDL + automatic invalidation + client re-sync. No backfill job, no
   read-time projection, no expand/contract sequencing: the log is rebuilt against the new
   schema.
4. **Derived / dependent rows.** Out of scope by construction — "Postgres Sync handles the
   read path. Writes go through your existing backend"
   (<https://electric-sql.com/sync/postgres-sync>). Invalidation is server-side, so there
   is no application job to run concurrently.
5. **Stale / offline clients.** No schema-version negotiation; the client is told to throw
   its copy away. "When a shape handle is deleted, clients receive a `409 Conflict`
   response or a `must-refetch` control message. This tells the client to discard its local
   data and re-sync the shape from scratch" — "handled transparently by the TypeScript
   client … No manual intervention is required — but the re-sync may take time for large
   shapes" (<https://electric-sql.com/docs/sync/guides/shapes>).
6. **Rebuild vs migrate.** Rebuild, and it is the only answer offered. Documented rebuild
   triggers: any schema change on a shaped table; replication slot invalidated, created
   fresh after a restart, or a Postgres timeline change (all shapes purged); explicit
   `DELETE /v1/shape` to force a re-sync; `ELECTRIC_MAX_SHAPES` LRU eviction
   (<https://electric-sql.com/docs/sync/guides/shapes>). Dropping a table needs a manual
   step because Electric cannot see it: "Electric does not yet automatically delete shapes
   when tables are dropped because Postgres does not stream DDL statements (such as `DROP
   TABLE`) on the logical replication stream", and recreating a table "only works if you
   first delete the shape" or the shape "will contain stale data from the old table".
7. **Documented non-goals.** No write path, no DDL propagation, no schema compatibility
   layer, no migration tooling. The documented position is that a schema change is an
   incompatibility, not a thing to be negotiated.

---

## Cross-cutting: derived / dependent rows

Who creates the child rows a new field implies, and what happens when more than one writer
tries at once.

| Platform  | Documented vehicle                                       | Job-level dedupe                                            | Effect-level idempotency                                     | Multi-instance            |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| Convex    | `migrateOne` may write other tables; or hand mutations    | Yes: refuses a second worker, cursor resume, serial runner   | No: `parallelize` warns calls are not isolated; transactions re-run on OCC | Single deployment; job is counter-based |
| Hasura    | Event trigger → your webhook (or batched SQL in migration) | No                                                          | Explicitly yours: "at least once", "may arrive out of order", `num_retries: 0` by default | **Documented undefined behavior** for two instances on one DB |
| Firestore | Cloud Functions trigger on write                          | No                                                          | Explicitly yours: "write idempotent functions", no ordering  | Not documented; at-least-once implies duplicates |
| InstantDB | Admin script before `push`                                | No                                                          | Not documented; the whole update set is one ≤5 s transaction | Not documented            |
| Supabase  | SQL (`insert … select`) in a migration                    | Only per-migration-per-database history                     | Not documented; `ON CONFLICT`/`NOT EXISTS` is your SQL       | Documented as a human coordination rule ("one person runs `db push`") |
| PocketBase| Migration code (`Record`/`save`, raw SQL)                  | Per-file `_migrations` ledger, run in one transaction       | Not documented                                              | Not applicable: single server by design |
| Zero      | Postgres trigger (dual-write on rename)                   | Backfill is `zero-cache`'s, cursor-free                     | Trigger semantics, not a job                                 | `zero-cache` runs horizontally scaled |
| PowerSync | Backend database                                          | —                                                           | —                                                            | Service-side reprocessing |
| Electric  | Backend database                                          | —                                                           | —                                                            | Server-side invalidation  |

Three documented facts matter more than the rows:

- **Nobody dedupes the backfill *effect* except Convex, and even Convex only dedupes the
  *job*.** The only platforms that state an effect-level obligation are Firestore and
  Hasura, and they state it as a warning about at-least-once delivery rather than as a
  helper.
- **Two writers at once is a documented hazard, not a documented solved problem.** Hasura
  is the only platform that names the multi-instance case, and it calls the result
  "undefined behavior".
- **Enumeration is always an index or a scan table, never a query-language feature.**
  Convex `customRange` over an index; Instant `$isNull` filter; Zero's ChangeDB
  `backfilling` table; PowerSync's `ps_untyped`; Supabase plain SQL. "Find the rows whose
  child is missing" is expressed as a range scan over a maintained structure in every one
  of them.

## Cross-cutting: rebuild vs migrate

| Platform  | Answer                | Unit re-materialized            | Documented cost / limit                                                            |
| --------- | --------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Electric  | **Rebuild**           | every shape on the changed table | full re-sync of that shape per client; "may take time for large shapes"              |
| Zero      | **Rebuild** (and wipe) | `zero-cache` replica + all clients | replication lag / downtime; `auto-reset` is "heavy-weight"; bandwidth on reconnect |
| PowerSync | **Rebuild** for service, migrate for client views | buckets; or clear-and-re-download per client | "clients download all their data again"; incremental reprocessing avoids it |
| Supabase  | Migrate; rebuild locally | whole database (`db reset`)     | replay every migration + seed; remote reset drops all user-created entities         |
| Convex    | Migrate; restore = destructive replace | whole deployment    | "wipes your existing data"; seconds to hours                                        |
| Hasura    | Migrate (+ best-effort down) | per-migration            | down.sql correctness not guaranteed                                                 |
| PocketBase| Migrate (+ down)      | per-migration                   | single-server, so cost is a serve restart to refresh cached collections             |
| InstantDB | Migrate               | none                            | 5 s transaction ceiling caps a single backfill                                      |
| Firestore | Neither (schemaless)  | client cache                    | no guarantee to rebuild, because there is nothing to rebuild against                 |

The single sentence that generalises Electric, Zero and PowerSync: they rebuild the
**derived copy**, and the thing that makes a rebuild safe is that the source of truth is a
log or a snapshot that was never transformed. What makes it *expensive* is that the copy is
per-client, so the cost is multiplied by the number of clients and is paid on reconnect.
None of the three rebuilds the *application's* rows; they rebuild a projection of rows that
already exist upstream.

## Question 7 roll-up: the documented refusals

| Platform  | Refuses to                                                                                   |
| --------- | -------------------------------------------------------------------------------------------- |
| Supabase  | provide down migrations; reconcile drift; keep DML through `squash`; read the live DB as declarative truth |
| Convex    | accept a push whose data violates the schema; make migrations a platform primitive; offer non-destructive restore |
| Firestore | define a schema at all; guarantee ordering; guarantee exactly-once                             |
| InstantDB | run a backfill job; state what a type change does; outlive 2027-08-31 for hosted service       |
| Hasura    | guarantee `down.sql` correctness; guarantee event safety across instances; retry triggers by default |
| PocketBase| scale horizontally; use another database; provide import/export helpers                        |
| Zero      | be local-first; support offline writes; support non-TypeScript clients; hold >~100 GB          |
| PowerSync | migrate the normal (JSON-view) path — there is nothing to migrate; make raw tables free        |
| Electric  | sync writes; replicate DDL; delete shapes for dropped tables; keep a shape across a schema change |

---

## What this implies for ebb

Observations only. No API design and no decision.

- **ebb's read-side model has a documented analogue, including its limits.** PowerSync's
  "client-side schema applied to schemaless data, so no migrations are required" is #124's
  read-time projection in someone else's words. PowerSync is equally explicit about where
  it stops: the projection is sound only because it is *stateless over complete rows*
  ("making the schema a stateless structure"), and the escape hatch for anything stateful
  is a raw table with real migrations. `e.collaborativeText()` is stateful — an entity that
  must exist — so it sits on PowerSync's raw-table side of that line, which is the same
  place #124 stops.

- **A projection cannot create existence, and no surveyed platform tries.** Electric,
  Zero and PowerSync each rebuild a projection of rows that already exist upstream. None
  of them can answer "the field implies rows that were never written", which is why
  Electric's answer to a schema change is to discard and re-stream, and why nothing in the
  survey has an equivalent of a lazily synthesized derived entity. That is consistent with
  #124's conclusion and narrows the search: the backfill has to be writes.

- **Two documented shapes exist for "the backfill is writes", and they differ in where
  dedupe lives.** Convex: a job with a cursor, a single worker, and per-batch transactions,
  where the *effect* is safe because a batch that fails leaves nothing behind. Firestore and
  Hasura: at-least-once delivery with idempotency pushed onto the handler. ebb already has
  an append-only log, so a Convex-style "the batch either lands or does not" guarantee is
  unavailable at the log level; the closest analogue to idempotency there is whatever the
  merge function does with a *repeat* of the same Action — a per-field LWW merge makes a
  repeated identical backfill Action a no-op only if the backfill writes the same HLC and
  value, which is a property of the Action, not of the runner.

- **Multi-instance execution is the gap, and it is documented as unsolved elsewhere.**
  Hasura's "undefined behavior" for two instances on one DB, Firestore's "write idempotent
  functions", and Convex's single-worker lock are three different admissions of the same
  thing. Convex is the only one that solves it, by making the migration's progress and its
  effects the same transaction.

- **Enumeration, not construction, is the missing primitive.** Every platform expresses
  "rows whose child is absent" with an index, a `$isNull` filter, or a scan table, and
  never with a query operator. ebb's query engine cannot express it today, and the surveyed
  systems suggest that a maintained enumeration structure (an index or a scan cursor) is
  the ordinary solution rather than an operator.

- **Zero is the only precedent for ebb's `min_supported_version` wire behaviour.** A client
  sending the schema it was built against, an explicit `SchemaVersionNotSupported` reason,
  and a default action of reload — that is #124's "update required" gate, published. Every
  other server-authoritative platform either rebuilds the client's copy (Electric's
  `must-refetch`, PowerSync's clear-and-re-download) or has no client-side schema to gate
  (Supabase, Hasura, PocketBase, Instant, Firestore).

- **Two approaches in the survey are *ruled out* for ebb by their own documentation, not by
  preference.** Electric's "invalidate every shape on the table and re-sync" is
  incompatible with an append-only log that clients must not have to replay from zero, and
  incompatible with offline outboxes (Electric has no write path at all). Firestore's
  schemaless-everything is the documented cause of exactly the #124 gap: with no declared
  field there is no moment at which a derived row is "implied", so no platform-side answer
  exists. Everything else is compatible in principle with a schema-agnostic server,
  because the schema lives in code and the server only ever sees rows.

- **Explicitly compatible with ebb's constraints, as documented:**
  - *Append-only Action log*: Convex's migrations write through the normal mutation path,
    so a backfill is observable by live subscribers — the closest published precedent for
    "the backfill submits Actions" (#124).
  - *Per-field LWW merge*: Firestore's offline path documents the same merge rule ("for
    multiple changes to the same document, it's last write wins") and treats it as the
    reason no client-side migration is needed.
  - *Schema-agnostic server*: PowerSync's JSON views show a projection schema can live
    entirely in the client, and Instant's "new entities and attributes can be created on
    the fly" plus its `attrs` lockdown shows the staged transition from agnostic to
    declared that ebb's `defineSchema` performs in code.
