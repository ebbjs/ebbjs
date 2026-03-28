# Phase 9: Integration Tests

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 8 — Wiring](08-wiring.md)
> **Produces:** End-to-end HTTP integration tests covering all Slice 1 acceptance criteria

---

## Task 22. Full HTTP flow integration tests

**Files:** `ebb_server/test/ebb_server/integration_test.exs` (create)

These tests exercise the complete end-to-end flow via HTTP. Use `Plug.Test` (not an actual HTTP client) for speed and isolation.

**Test setup:**

- Create a tmp_dir for this test run
- Override application config: `Application.put_env(:ebb_server, :data_dir, tmp_dir)`
- Start the storage supervisor manually (or use the full application)
- Build a test connection helper using `Plug.Test.conn/3`

**Test cases:**

1. **POST action, GET entity back:**
   - Build a MessagePack body with one action containing one PUT update for entity "todo_xyz789" with fields `title: "Buy milk"`, `completed: false`
   - POST to `/sync/actions` with the MessagePack body and `content-type: application/msgpack`
   - Assert response status 200, body is `{"rejected": []}`
   - GET `/entities/todo_xyz789?actor_id=a_test`
   - Assert response status 200
   - Parse JSON body, verify `id` is "todo_xyz789", `type` is "todo"
   - Verify `data.fields.title.value` is "Buy milk"
   - Verify `data.fields.completed.value` is false

2. **Second GET returns same data (cache hit):**
   - After test 1, GET the same entity again
   - Verify same response

3. **GET nonexistent entity returns 404:**
   - GET `/entities/nonexistent?actor_id=a_test`
   - Assert response status 404

4. **GSN is assigned as 1:**
   - After writing the first action, GET the entity
   - Verify `last_gsn` is 1

5. **Action is durable (survives process restart):**
   - POST an action
   - Stop the storage supervisor
   - Restart the storage supervisor (with same data_dir)
   - GET the entity → still returns correct data
   - (The entity won't be in SQLite cache after restart, so it will re-materialize from RocksDB)

6. **Dirty bit lifecycle:**
   - POST an action for entity "todo_abc"
   - Verify `SystemCache.is_dirty?("todo_abc")` is true
   - GET the entity (triggers materialization)
   - Verify `SystemCache.is_dirty?("todo_abc")` is false
   - GET again → still works (reads from SQLite)

7. **Multiple actions, sequential GSNs:**
   - POST action 1, POST action 2
   - Verify both entities are readable
   - Verify GSNs are 1 and 2

8. **POST with invalid body returns error:**
   - POST with non-MessagePack body → 422 or 400
   - POST with missing "actions" key → 422

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/integration_test.exs
```

All 8 test cases pass. The complete write → read path works end-to-end via HTTP.

Also run the full test suite to make sure nothing is broken:

```bash
cd ebb_server && mix test
```
