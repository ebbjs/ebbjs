# Slice 2: Permission-Checked Write

## Goal

A client can bootstrap a Group (create Group + GroupMember + Relationship in one Action), then write a user entity into that Group, and have the server enforce that only Group members with the correct permissions can write to entities in that Group.

## Components Involved

| Component | Interface Subset Used |
|-----------|----------------------|
| [RocksDB Store](../components/rocksdb-store.md) | All interfaces from Slice 1 |
| [SQLite Store](../components/sqlite-store.md) | All interfaces from Slice 1 |
| [System Cache](../components/system-cache.md) | All from Slice 1 + `put_group_member/1`, `put_relationship/1`, `get_actor_groups/1`, `get_permissions/2`, `get_entity_group/1` |
| [Writer](../components/writer.md) | All from Slice 1 + system entity cache update logic (step 6 in flush) |
| [Entity Store](../components/entity-store.md) | `get/2`, `query/3` |
| [Permission Checker](../components/permission-checker.md) | `validate_and_authorize/2`, all individual checks |
| [HTTP API](../components/http-api.md) | `POST /sync/actions` (with auth), `POST /sync/handshake`, `GET /entities/:id`, `POST /entities/query` |

## Flow

### Flow A: Group Bootstrap

1. **Client sends handshake.** `POST /sync/handshake` with auth headers. Server calls the auth URL, gets `actor_id: "a_user1"`. Returns `{"actor_id": "a_user1", "groups": []}` (no Groups yet).

2. **Client sends bootstrap Action.** `POST /sync/actions` with one Action containing 3 Updates:
   - PUT `group_abc` (type: `group`)
   - PUT `gm_def` (type: `groupMember`, data: `{actor_id: "a_user1", group_id: "group_abc", permissions: ["todo.*"]}`)
   - PUT `rel_ghi` (type: `relationship`, data: `{source_id: "group_abc", target_id: "group_abc", type: "group", field: "self"}`)

3. **Permission Checker validates.** Detects the Group bootstrap pattern:
   - Action creates a Group, a GroupMember for the authenticated actor, and a Relationship
   - This is unpermissioned -- allowed without further checks
   - Validates structure, actor identity, HLC drift
   - Returns all 3 Updates as accepted

4. **Writer processes.** Commits to RocksDB, then:
   - Marks `group_abc`, `gm_def`, `rel_ghi` dirty
   - **Updates system entity caches inline:**
     - `SystemCache.put_group_member(%{id: "gm_def", actor_id: "a_user1", group_id: "group_abc", permissions: ["todo.*"]})`
     - `SystemCache.put_relationship(%{id: "rel_ghi", source_id: "group_abc", target_id: "group_abc", ...})`
   - Replies `{:ok, {1, 1}}`

5. **ETS caches are now populated.** `a_user1` is a member of `group_abc` with `["todo.*"]` permissions. Subsequent permission checks will find this.

### Flow B: Authorized User Entity Write

6. **Client sends entity Action.** `POST /sync/actions` with one Action containing:
   - PUT `todo_xyz` (type: `todo`, data: `{title: "Buy milk", completed: false}`)
   - PUT `rel_jkl` (type: `relationship`, data: `{source_id: "todo_xyz", target_id: "group_abc", type: "todo", field: "list"}`)

7. **Permission Checker validates.** 
   - Builds intra-Action context: finds Relationship `rel_jkl` linking `todo_xyz` → `group_abc`
   - Checks `todo_xyz` authorization: entity's Group is `group_abc` (from intra-Action context), actor `a_user1` has `["todo.*"]` in `group_abc` → authorized
   - Checks `rel_jkl` authorization: Relationship creation to `group_abc`, actor is a member → authorized

8. **Writer processes.** Commits, updates system entity cache with the new Relationship, replies.

### Flow C: Unauthorized Write (Rejected)

9. **Different actor sends Action.** `POST /sync/actions` (authenticated as `a_user2`) with:
   - PATCH `todo_xyz` (type: `todo`, data: `{completed: true}`)

10. **Permission Checker rejects.** 
    - Looks up `todo_xyz`'s Group via `SystemCache.get_entity_group("todo_xyz")` → `group_abc`
    - Checks `SystemCache.get_permissions("a_user2", "group_abc")` → `nil` (not a member)
    - Returns rejection: `{action_id: "...", reason: "not_authorized", details: "actor not a member of entity's group"}`

11. **HTTP handler responds.** `200 {"rejected": [{"action_id": "...", "reason": "not_authorized", ...}]}`

### Flow D: Entity Query with Permissions

12. **Client queries entities.** `POST /entities/query {"type": "todo", "filter": {}, "actor_id": "a_user1"}`

13. **Entity Store materializes and queries.** Materializes any dirty `todo` entities, then queries SQLite with permission JOINs scoped to `a_user1`. Returns `[todo_xyz]`.

14. **Unauthorized actor queries.** Same query with `actor_id: "a_user2"`. Permission JOINs find no matching GroupMember. Returns `[]`.

## Acceptance Criteria

- [ ] Group bootstrap Action (Group + GroupMember + Relationship) is accepted without prior permissions
- [ ] After bootstrap, ETS caches contain the GroupMember and Relationship
- [ ] User entity write to a Group the actor belongs to is accepted
- [ ] User entity write to a Group the actor does NOT belong to is rejected with `not_authorized`
- [ ] Intra-Action resolution works: new entity + Relationship in the same Action is authorized
- [ ] Permission-scoped `ctx.query()` returns only entities the actor can see
- [ ] HLC drift validation rejects Actions with HLC > now + 120s
- [ ] Actor identity validation rejects Actions where `action.actor_id != authenticated actor`
- [ ] Structure validation rejects Actions with missing required fields
- [ ] Auth integration: handshake calls the configured auth URL and returns actor_id

## Build Order

1. **Build Permission Checker.** `EbbServer.Storage.PermissionChecker` module -- implement `validate_structure/1`, `validate_actor/2`, `validate_hlc/1`, `authorize_updates/2`, and the Group bootstrap detection. Write unit tests for each check in isolation, using manually populated ETS tables.

2. **Extend System Cache with permission APIs.** Add `put_group_member/1`, `delete_group_member/1`, `put_relationship/1`, `delete_relationship/1`, `get_actor_groups/1`, `get_permissions/2`, `get_entity_group/1`, `get_group_entities/1`. Write unit tests.

3. **Extend Writer with system entity cache updates.** After each batch commit, scan for system entity Updates and call the appropriate SystemCache functions. Write unit tests: write a GroupMember Action, verify ETS is updated.

4. **Add auth integration.** `EbbServer.Sync.AuthPlug` -- forward auth headers to configured URL, extract actor_id. For testing, use a mock auth server or a configurable bypass.

5. **Wire Permission Checker into HTTP API.** The `POST /sync/actions` handler now calls `PermissionChecker.validate_and_authorize/2` before passing accepted Actions to the Writer.

6. **Add handshake endpoint.** `POST /sync/handshake` -- authenticate, look up actor's Groups from SystemCache, validate cursors (stub cursor validation for now).

7. **Extend Entity Store with `query/3`.** Implement batch materialization of dirty entities by type, then delegate to `SQLite.query_entities/1` with permission JOINs.

8. **Add entity query endpoint.** `POST /entities/query` in the HTTP router.

9. **Integration test the full permission flow.** Test all 4 flows (A-D) end-to-end via HTTP.
