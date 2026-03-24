# Core Write Path (C1 → C2 → C3 → C4 → C5 → C6 → C7)

> **Deprecated:** This task breakdown was written for the SQLite-only MVP architecture. The storage architecture has been redesigned — see `docs/storage-architecture-v2.md` (RocksDB + SQLite + on-demand materialization). A new task breakdown should be written against the v2 architecture. Key differences: the Writer writes to RocksDB (not SQLite), there is no ActionReader module (RocksDB iterators replace SQL queries), the EntityStore handles on-demand materialization, and Bun reads via Elixir HTTP (not direct SQLite).

**Goal:** Actions flow end-to-end — write via HTTP, persist to SQLite, permission-checked, durable.

**References:** `docs/storage-architecture-proposal.md` (Storage Engine, Writer GenServer, Write Flow, OTP Supervision Tree sections)

**Approach:** TDD. Each task group defines the tests first, then implements the code to make them pass. Tests serve as the specification — if the tests are wrong, fix the tests before writing implementation.

---

## T1: Elixir Project Scaffold (C1)

Set up the Elixir/OTP project inside the monorepo. This is the one task group that doesn't lead with tests — there's nothing to test until the project exists.

### Tasks

- [ ] **T1.1** Create a new Mix project at `sync_server/` (root of the monorepo — it's a different language, not a JS package). Use `mix new ebb_server --sup` to get an OTP application with a supervision tree.
- [ ] **T1.2** Add dependencies to `mix.exs`:
  - `plug_cowboy` — HTTP server (lightweight, no Phoenix needed initially)
  - `exqlite` — raw SQLite3 NIF bindings (no Ecto — the Writer builds SQL manually and needs precise control over transactions and pragmas)
  - `jason` — JSON encoding/decoding
  - `nanoid` — ID generation (or inline implementation)
- [ ] **T1.3** Set up the top-level OTP supervision tree skeleton:
  ```
  Application Supervisor (one_for_one)
  ├── Storage Supervisor (rest_for_one)  — placeholder, Writer goes here
  └── Sync Supervisor (one_for_one)      — placeholder, Fan-out goes here later
  ```
- [ ] **T1.4** Configure the application: `data_dir` for SQLite database path, port for HTTP server.
- [ ] **T1.5** Verify the project compiles, starts, and the supervision tree is running (`mix test` passes with zero tests, `mix run --no-halt` starts cleanly).

---

## T2: SQLite Schema (C2)

Create the database and all tables needed for the MVP.

### Tests (write first)

- [ ] **T2.1** Test: calling `Schema.initialize(db)` on a fresh in-memory SQLite database creates all expected tables. Verify by querying `sqlite_master` for table names: `actions`, `updates`, `entities`, `snapshots`, `actors`, `function_versions`, `cold_action_index`.
- [ ] **T2.2** Test: calling `Schema.initialize(db)` is idempotent — calling it twice on the same database does not error.
- [ ] **T2.3** Test: WAL mode is enabled after initialization (`PRAGMA journal_mode` returns `wal`).
- [ ] **T2.4** Test: insert a sample Action + Update row, read it back, verify all columns.
- [ ] **T2.5** Test: insert an entity row with Relationship data, verify the generated columns (`source_id`, `target_id`, `rel_type`, `rel_field`) are automatically populated from the `data` JSON blob.
- [ ] **T2.6** Test: insert an entity row with GroupMember data, verify the generated columns (`actor_id`, `group_id`, `permissions`) are automatically populated.
- [ ] **T2.7** Test: foreign key constraint works — inserting an Update with a non-existent `action_id` fails.

### Implementation (make tests pass)

- [ ] **T2.8** Write `EbbServer.Storage.Schema.initialize(db)` that creates all MVP tables idempotently (using `CREATE TABLE IF NOT EXISTS`).
- [ ] **T2.9** Enable WAL mode (`PRAGMA journal_mode=WAL`) and set recommended pragmas: `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000`, `PRAGMA synchronous = NORMAL`.
- [ ] **T2.10** Create all tables and indexes as specified in the architecture doc (actions, updates, entities with generated columns, snapshots, actors, function_versions, cold_action_index).

### Notes

- Schema initialization runs before the Writer GenServer starts (enforced by supervision tree ordering under `rest_for_one`). The schema module should be a simple function called during the Storage Supervisor's init, not a separate GenServer.
- The `entities` table is created now but won't be populated until the Bun Materializer (C9) is built. The generated columns and indexes exist so the schema is stable from day one.
- Tests should use in-memory SQLite databases (`:memory:`) for speed and isolation.

---

## T3: Writer GenServer (C3)

The single process that serializes all writes to the Action log.

### Tests (write first)

- [ ] **T3.1** Test: append a single Action with one Update, verify it's in SQLite with the correct GSN (starting from 1).
- [ ] **T3.2** Test: append three Actions sequentially, verify GSNs are 1, 2, 3 (monotonically increasing, gap-free).
- [ ] **T3.3** Test: `append/1` returns `{:ok, gsn}` with the assigned GSN.
- [ ] **T3.4** Test: after appending, the Action's Updates are in the `updates` table with correct `action_id` foreign keys.
- [ ] **T3.5** Test: stop and restart the Writer GenServer, append another Action, verify its GSN continues from where the previous session left off (not 1).
- [ ] **T3.6** Test: subscribe a process via `ActionWriter.subscribe/1`, append an Action, verify the subscriber receives `{:batch_flushed, from_gsn, to_gsn}`.
- [ ] **T3.7** Test: append an Action containing system entity Updates (e.g., a GroupMember PUT), verify the system entity cache (ETS) is updated before `append/1` returns.

### Implementation (make tests pass)

- [ ] **T3.8** Implement `EbbServer.Storage.ActionWriter` as a GenServer under the Storage Supervisor.
  - State: `%{db: conn, next_gsn: integer, subscribers: [pid]}`
  - On init: open SQLite connection, query `SELECT MAX(gsn) FROM actions` to determine `next_gsn`
- [ ] **T3.9** Implement `handle_call({:append, action}, from, state)`:
  - Assign GSN from `next_gsn`, increment
  - Insert into `actions` and `updates` tables within a SQLite transaction
  - Commit
  - Extract and apply system entity updates to ETS cache (T5)
  - Send `{:batch_flushed, gsn, gsn}` to subscribers
  - Reply `{:ok, gsn}`
- [ ] **T3.10** Implement the public API: `ActionWriter.append(action)`, `ActionWriter.subscribe(pid)`.

### Design notes

- **No batching in the MVP.** The architecture doc describes batched fsync with 10ms windows for the custom storage engine (C17). The SQLite-backed Writer writes each Action in a single SQLite transaction and commits immediately. WAL mode provides adequate durability semantics. Batching is a C17 optimization.
- **GSN assignment.** The Writer assigns GSN from its in-memory counter (`next_gsn`), not from SQLite autoincrement. This keeps the interface identical to the future custom storage engine where GSN is assigned in application code.
- **`handle_call` vs `handle_cast`.** The architecture doc uses `handle_cast` with explicit `{:durable, gsn}` message passing to the caller. For the MVP, `handle_call` is simpler — the caller blocks until the write is complete, and the reply is the GSN. The cast + message approach becomes necessary when batching is introduced (C17), because the caller needs to wait for the batch flush, not just the cast acknowledgment.

---

## T4: ActionReader (C4)

Read-path module for querying Actions from SQLite. Any process can call these functions — they don't go through the Writer.

### Tests (write first)

Set up: each test inserts a known set of Actions via the Writer before reading.

- [ ] **T4.1** Test: `get_actions_since(0, 100)` on a database with 3 Actions returns all 3, ordered by GSN, each with their Updates nested.
- [ ] **T4.2** Test: `get_actions_since(2, 100)` returns only the Action with GSN 3 (cursor is exclusive).
- [ ] **T4.3** Test: `get_actions_since(0, 2)` returns only the first 2 Actions (limit works).
- [ ] **T4.4** Test: `get_actions_for_entities_since(["entity_a"], 0, 100)` returns only Actions that contain Updates targeting `entity_a`, not other entities.
- [ ] **T4.5** Test: an Action with Updates targeting both `entity_a` and `entity_b` is returned when filtering for either entity, and the returned Action includes ALL its Updates (not just the matching ones).
- [ ] **T4.6** Test: `get_action_at_gsn(2)` returns the Action with GSN 2 and all its Updates. Returns `nil` for a non-existent GSN.
- [ ] **T4.7** Test: `get_current_gsn()` returns the highest GSN written. Returns 0 (or nil) on an empty database.
- [ ] **T4.8** Test: `get_low_water_mark()` returns 0 in the MVP (no compaction, all history available).

### Implementation (make tests pass)

- [ ] **T4.9** Implement `EbbServer.Storage.ActionReader` module with a shared read-only SQLite connection.
- [ ] **T4.10** Implement `get_actions_since/2`, `get_actions_for_entities_since/3`, `get_action_at_gsn/1`, `get_current_gsn/0`, `get_low_water_mark/0`.
- [ ] **T4.11** Implement Action assembly: group flat SQL rows into `%Action{id, actor_id, hlc, gsn, updates: [%Update{}, ...]}` structs.

### Design notes

- **Connection management.** The Reader needs its own SQLite connection(s), separate from the Writer's. WAL mode allows concurrent reads while the Writer is writing. A single read connection is sufficient for the MVP; a pool can be added later if read contention becomes measurable.
- **Action assembly.** SQLite returns flat rows (one per Update). The Reader must group these into Action structs. This is the canonical in-memory representation used throughout the system.
- **Full Action delivery.** When filtering by entity, the query finds Actions that touch the requested entities, but returns ALL Updates within those Actions (not just the matching Updates). An Action is an atomic unit — it's always delivered whole.

---

## T5: System Entity Cache (C5)

Permanent in-memory ETS cache of all system entities (Groups, GroupMembers, Relationships). The authoritative source for permission checks and fan-out routing.

### Tests (write first)

- [ ] **T5.1** Test: on a fresh cache, all read functions return empty results (`get_group/1` returns nil, `get_memberships_for_actor/1` returns `[]`, etc.).
- [ ] **T5.2** Test: apply a Group PUT Update to the cache, then `get_group(group_id)` returns the Group with correct data.
- [ ] **T5.3** Test: apply a GroupMember PUT Update, then `is_member?(actor_id, group_id)` returns true and `get_permissions(actor_id, group_id)` returns the permissions from the data blob.
- [ ] **T5.4** Test: apply a Relationship PUT Update, then `get_relationships_for_target(target_id)` includes the new Relationship with correct `source_id`, `target_id`, `type`, `field`.
- [ ] **T5.5** Test: apply a DELETE Update for a GroupMember, then `is_member?(actor_id, group_id)` returns false (tombstoned).
- [ ] **T5.6** Test: apply a PATCH Update for a GroupMember (e.g., changing permissions), then `get_permissions(actor_id, group_id)` returns the updated value.
- [ ] **T5.7** Test: startup replay — insert Actions containing system entity mutations directly into SQLite (bypassing the Writer), call `SystemCache.load_from_db(db)`, verify the cache state matches what was inserted.
- [ ] **T5.8** Test: startup replay applies Updates in HLC order — if two PUTs exist for the same entity with different HLCs, the one with the higher HLC wins.
- [ ] **T5.9** Test: `get_relationships_for_source(source_id)` returns all Relationships where the given entity is the source.
- [ ] **T5.10** Test: non-system entity Updates (e.g., `subject_type: "todo"`) are ignored by the cache — applying them has no effect.

### Implementation (make tests pass)

- [ ] **T5.11** Create the ETS tables on application startup (owned by a dedicated `SystemCache` GenServer or the Storage Supervisor):
  - `:ebb_groups` — `%{group_id => %Group{}}`
  - `:ebb_group_members` — keyed for `is_member?` and `get_memberships_for_actor` lookups
  - `:ebb_relationships` — keyed for `get_relationships_for_target` and `get_relationships_for_source` lookups
- [ ] **T5.12** Implement `SystemCache.apply_update(update, hlc)` — applies a single Update to the appropriate ETS table. Handles PUT (create/overwrite), PATCH (merge), DELETE (tombstone). Ignores non-system entity types.
- [ ] **T5.13** Implement `SystemCache.load_from_db(db)` — startup replay from `actions`/`updates` tables, calling `apply_update` for each system entity Update in HLC order.
- [ ] **T5.14** Implement read functions: `get_group/1`, `get_memberships_for_actor/1`, `get_relationships_for_target/1`, `get_relationships_for_source/1`, `is_member?/2`, `get_permissions/2`.
- [ ] **T5.15** Wire into the Writer GenServer: after each write, call `SystemCache.apply_update` for any system entity Updates in the Action before replying `{:ok, gsn}`.

### Design notes

- **ETS table ownership.** The ETS tables should be owned by a process that outlives the Writer — likely the Storage Supervisor itself or a dedicated `SystemCache` GenServer. If the Writer crashes and restarts, the ETS tables still exist.
- **Tombstones matter.** Deleted system entities must be tracked (not just removed from ETS) because a DELETE for a GroupMember means "revoke access." The cache must know the entity was deleted so permission checks deny access. Tombstones can be cleaned up eventually, but that's a future concern.
- **Secondary indexes.** The primary lookup patterns are: "what groups is this actor in?" (permission checks), "what entities belong to this group?" (fan-out, catch-up). These need to be fast. Either use separate ETS tables for each lookup pattern or use `ets:match`/`ets:select` with appropriate table types (`:bag` or `:ordered_set`).

---

## T6: Permission Checks (C6)

Validate that an actor is allowed to perform the Actions they're submitting.

### Tests (write first)

Set up: each test populates the system entity cache with known Groups, GroupMembers, and Relationships before running checks.

- [ ] **T6.1** Test: Action with valid envelope (all required fields, valid method types) passes structural validation.
- [ ] **T6.2** Test: Action missing `id` fails structural validation with a clear error.
- [ ] **T6.3** Test: Action with no Updates fails structural validation.
- [ ] **T6.4** Test: Update with invalid method (e.g., `"GET"`) fails structural validation.
- [ ] **T6.5** Test: PUT Update with missing `data` fails structural validation. DELETE Update with `data` present passes (data is ignored, not rejected).
- [ ] **T6.6** Test: Action with HLC within drift tolerance passes. Action with HLC 120 seconds in the future is rejected.
- [ ] **T6.7** Test: Action targeting an entity in a Group the actor belongs to passes permission check.
- [ ] **T6.8** Test: Action targeting an entity in a Group the actor does NOT belong to is rejected with `"not_authorized"`.
- [ ] **T6.9** Test: Action targeting an entity with no Relationship (orphan entity) is rejected.
- [ ] **T6.10** Test: Bootstrap Action — Group PUT + GroupMember PUT + Relationship PUT in one Action from any authenticated actor passes. (Group creation is unpermissioned.)
- [ ] **T6.11** Test: New entity creation — entity PUT + Relationship PUT in the same Action, where the Relationship places the entity in a Group the actor belongs to: passes.
- [ ] **T6.12** Test: Action targeting an entity whose GroupMember has been DELETEd (tombstone in cache) is rejected.
- [ ] **T6.13** Test: Action with `actor_id` that doesn't match the authenticated actor is rejected.

### Implementation (make tests pass)

- [ ] **T6.14** Implement `EbbServer.Sync.Permissions.validate_structure(action)` — returns `{:ok, action}` or `{:error, reason}`.
- [ ] **T6.15** Implement `EbbServer.Sync.Permissions.check_hlc_drift(action, server_hlc, max_drift)` — returns `:ok` or `{:error, :hlc_drift}`.
- [ ] **T6.16** Implement `EbbServer.Sync.Permissions.check_authorization(action, actor_id)` — reads system entity cache, handles intra-Action resolution for new entities and Group bootstrap. Returns `:ok` or `{:error, reason}`.
- [ ] **T6.17** Implement `EbbServer.Sync.Permissions.validate(action, actor_id, server_hlc)` — runs all checks in sequence, returns `{:ok, action}` or `{:error, reason}`.

### Design notes

- **Permission checks never hit SQLite.** All lookups go through the system entity cache (ETS). This is a hard invariant.
- **Reject early, reject clearly.** Return specific rejection reasons per Action so the client knows what went wrong.
- **Intra-Action resolution.** The tricky case: an Action creates a new entity AND its Relationship in the same Action. The permission check must look inside the Action itself to find the Relationship Update before deciding. This is the only case where the check reads from the Action payload rather than ETS.

---

## T7: Action Write Endpoint (C7)

The HTTP endpoint that ties everything together: validates, permission-checks, writes, and confirms durability.

### Tests (write first)

These are integration tests — full stack from HTTP request through to SQLite and back.

- [ ] **T7.1** Test: POST a valid bootstrap Action (Group + GroupMember + Relationship), receive 200 with `{"rejected": []}`, verify Action is in SQLite with a GSN.
- [ ] **T7.2** Test: after bootstrap, POST an Action creating an entity in that Group, receive 200 with `{"rejected": []}`.
- [ ] **T7.3** Test: POST an Action with an invalid envelope (missing Update `id`), receive 200 with the Action in the rejected list and reason `"invalid_structure"`.
- [ ] **T7.4** Test: POST a mix of valid and invalid Actions, verify valid ones are written and invalid ones are in the rejected list.
- [ ] **T7.5** Test: POST an Action targeting a Group the actor is NOT a member of, verify it's rejected with reason `"not_authorized"`.
- [ ] **T7.6** Test: POST with no authentication (no `X-Actor-Id` header or equivalent), receive 401.
- [ ] **T7.7** Test: POST an Action where `actor_id` in the payload doesn't match the authenticated actor, verify rejection.
- [ ] **T7.8** Test: POST a bootstrap Action, then POST a GroupMember PUT adding a second actor, then POST an Action from the second actor — accepted (permissions updated in cache before response).
- [ ] **T7.9** Test: POST a GroupMember DELETE (revoke access), then POST an Action from the revoked actor — rejected.
- [ ] **T7.10** Test: response includes correct Content-Type (`application/json`).

### Implementation (make tests pass)

- [ ] **T7.11** Set up the Plug router and mount under Cowboy on the configured port.
- [ ] **T7.12** Implement `POST /sync/actions` handler:
  - Parse JSON request body (array of Actions)
  - Authenticate: extract `actor_id` from `X-Actor-Id` header (dev placeholder until C10)
  - Verify `actor_id` in each Action matches the authenticated actor
  - For each Action: run `Permissions.validate(action, actor_id, server_hlc)`
  - Separate valid and rejected Actions
  - If any valid: send to Writer GenServer, wait for `{:ok, gsn}` (with timeout)
  - Respond with `{"rejected": [...]}` (200) or `{"error": "unauthorized"}` (401)
- [ ] **T7.13** Implement timeout handling: if the Writer doesn't respond within 5 seconds, respond with 503.
- [ ] **T7.14** Define request and response JSON formats:
  ```json
  // Request:
  {
    "actions": [
      {
        "id": "act_abc123",
        "actor_id": "a_user456",
        "hlc": 1711036800000,
        "updates": [
          {
            "id": "upd_def789",
            "subject_id": "todo_ghi012",
            "subject_type": "todo",
            "method": "PUT",
            "data": {"title": "Buy milk", "done": false}
          }
        ]
      }
    ]
  }

  // Response (200 — all accepted):
  { "rejected": [] }

  // Response (200 — partial):
  {
    "rejected": [
      { "action_id": "act_abc123", "reason": "not_authorized", "details": "..." }
    ]
  }

  // Response (401):
  { "error": "unauthorized" }
  ```

### Design notes

- **Partial acceptance.** A single HTTP request can contain multiple Actions. Some may be valid and some invalid. Valid Actions are written; invalid ones are rejected. The client can retry rejected Actions after fixing the issue.
- **Auth placeholder.** Until Auth Integration (C10) is built, the write endpoint trusts an `X-Actor-Id` header. This is development-only and gets replaced by the real auth flow later.
- **Actor ID verification.** The `actor_id` in the Action payload must match the authenticated actor. The server verifies this — a client can't submit Actions on behalf of another actor.

---

## Verification milestone

After all tests pass (T1–T7), you should also be able to manually verify:

1. Start the Elixir server (`mix run --no-halt`)
2. POST an Action that creates a Group, a GroupMember, and a Relationship (bootstrap)
3. POST a subsequent Action that creates an entity in that Group
4. Query the database and see both Actions with correct GSNs
5. POST an Action from a different actor for the same Group — rejected (not a member)
6. Add that actor as a GroupMember via another Action, then retry — accepted
7. Restart the server, verify the system entity cache repopulates from the Actions table, and repeat steps 3-6 successfully

This proves the core write path works: durability, permissions, and the system entity cache are all functional.
