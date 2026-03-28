# Phase 9: Integration Tests

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** All previous phases (1-8)
> **Produces:** End-to-end HTTP integration tests covering all Slice 2 acceptance criteria

---

## Task 25. Full permission flow integration tests

**Files:** `ebb_server/test/ebb_server/slice2_integration_test.exs` (create)

These tests exercise the complete end-to-end permission-checked write flow via HTTP. Use `Plug.Test` for speed and isolation. All tests use bypass auth mode (configured in `config/test.exs`).

**Test setup:**

```elixir
defmodule EbbServer.Slice2IntegrationTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import EbbServer.TestHelpers
  alias EbbServer.Sync.Router
  alias EbbServer.Storage.SystemCache

  setup do
    if pid = Process.whereis(EbbServer.Storage.Supervisor) do
      GenServer.stop(pid)
      :timer.sleep(200)
    end

    tmp_dir = tmp_dir(%{module: __MODULE__, test: "slice2_#{:erlang.unique_integer([:positive])}"})
    Application.put_env(:ebb_server, :data_dir, tmp_dir)

    case EbbServer.Storage.Supervisor.start_link([]) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end

    on_exit(fn ->
      try do
        if pid = Process.whereis(EbbServer.Storage.Supervisor) do
          :ok = GenServer.stop(pid, :normal, 5000)
        end
      catch
        _, _ -> :ok
      end
      Application.delete_env(:ebb_server, :data_dir)
    end)

    %{tmp_dir: tmp_dir}
  end
```

**Helper functions:**

```elixir
defp post_actions(body, actor_id \\ "a_test") do
  # Build conn with MessagePack body, content-type, and x-ebb-actor-id header
  # Same pattern as existing integration_test.exs but with auth header added
end

defp get_entity(id, actor_id \\ "a_test") do
  conn(:get, "/entities/#{id}?actor_id=#{actor_id}")
  |> put_req_header("x-ebb-actor-id", actor_id)
  |> Router.call([])
end

defp post_query(body, actor_id \\ "a_test") do
  conn(:post, "/entities/query", Jason.encode!(body))
  |> put_req_header("content-type", "application/json")
  |> put_req_header("x-ebb-actor-id", actor_id)
  |> Router.call([])
end

defp post_handshake(body, actor_id \\ "a_test") do
  conn(:post, "/sync/handshake", Jason.encode!(body))
  |> put_req_header("content-type", "application/json")
  |> put_req_header("x-ebb-actor-id", actor_id)
  |> Router.call([])
end

defp msgpack_encode!(data) do
  data |> Msgpax.pack!() |> IO.iodata_to_binary()
end

defp bootstrap_group(actor_id, group_id) do
  hlc = generate_hlc()
  gm_id = "gm_" <> Nanoid.generate()
  rel_id = "rel_" <> Nanoid.generate()

  action = %{
    "id" => "act_bootstrap_" <> Nanoid.generate(),
    "actor_id" => actor_id,
    "hlc" => hlc,
    "updates" => [
      %{
        "id" => "upd_group_" <> Nanoid.generate(),
        "subject_id" => group_id,
        "subject_type" => "group",
        "method" => "put",
        "data" => %{
          "fields" => %{
            "name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}
          }
        }
      },
      %{
        "id" => "upd_gm_" <> Nanoid.generate(),
        "subject_id" => gm_id,
        "subject_type" => "groupMember",
        "method" => "put",
        "data" => %{
          "fields" => %{
            "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
            "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
            "permissions" => %{"type" => "lww", "value" => ["todo.*", "post.*"], "hlc" => hlc}
          }
        }
      },
      %{
        "id" => "upd_rel_bootstrap_" <> Nanoid.generate(),
        "subject_id" => rel_id,
        "subject_type" => "relationship",
        "method" => "put",
        "data" => %{
          "source_id" => group_id,
          "target_id" => group_id,
          "type" => "group",
          "field" => "self"
        }
      }
    ]
  }

  conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  assert conn.status == 200
  %{group_id: group_id, gm_id: gm_id, rel_id: rel_id}
end

defp write_entity_in_group(actor_id, entity_id, entity_type, group_id, fields) do
  hlc = generate_hlc()
  rel_id = "rel_" <> Nanoid.generate()

  action = %{
    "id" => "act_write_" <> Nanoid.generate(),
    "actor_id" => actor_id,
    "hlc" => hlc,
    "updates" => [
      %{
        "id" => "upd_entity_" <> Nanoid.generate(),
        "subject_id" => entity_id,
        "subject_type" => entity_type,
        "method" => "put",
        "data" => %{"fields" => fields}
      },
      %{
        "id" => "upd_rel_" <> Nanoid.generate(),
        "subject_id" => rel_id,
        "subject_type" => "relationship",
        "method" => "put",
        "data" => %{
          "source_id" => entity_id,
          "target_id" => group_id,
          "type" => entity_type,
          "field" => "group"
        }
      }
    ]
  }

  post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
end
```

**Test cases:**

### Flow A: Group Bootstrap

1. **Group bootstrap Action is accepted without prior permissions:**
   - Call `bootstrap_group("actor_1", "group_1")`
   - Assert the POST returns 200 with `{"rejected": []}`
   - Verify ETS caches contain the GroupMember: `SystemCache.get_actor_groups("actor_1")` returns the group
   - Verify ETS caches contain the Relationship: `SystemCache.get_entity_group("group_1")` returns `"group_1"`

2. **Handshake returns the bootstrapped group:**
   - After bootstrap, POST handshake as "actor_1"
   - Assert response includes `"group_1"` in the groups list

### Flow B: Authorized Write

3. **User entity write to a Group the actor belongs to is accepted:**
   - Bootstrap group for "actor_1"
   - Write a "todo" entity in that group with a Relationship linking it
   - Assert 200 with `{"rejected": []}`
   - GET the entity back → verify data is correct

4. **Intra-Action resolution: new entity + Relationship in the same Action is authorized:**
   - Bootstrap group for "actor_1"
   - Write an action that creates a new entity AND its Relationship in the same action
   - Assert 200 with `{"rejected": []}`
   - The entity didn't exist in ETS before the action, but the Relationship in the same action provides the group context

### Flow C: Unauthorized Write Rejected

5. **User entity write to a Group the actor does NOT belong to is rejected:**
   - Bootstrap group "g_1" for "actor_1"
   - Write a todo entity in "g_1" as "actor_2" (who is NOT a member)
   - Assert the action is rejected with reason `"not_authorized"`
   - The response should be 200 with the action in the `rejected` array

6. **Actor identity mismatch is rejected:**
   - Build an action where `action["actor_id"]` is "actor_1" but authenticate as "actor_2"
   - Assert the action is rejected with reason `"actor_mismatch"`

### Flow D: Permission-Scoped Query

7. **Permission-scoped query returns only entities the actor can see:**
   - Bootstrap group "g_1" for "actor_1", write "todo_1" in "g_1"
   - Bootstrap group "g_2" for "actor_2", write "todo_2" in "g_2"
   - POST `/entities/query` as "actor_1" with `{"type": "todo"}`
   - Assert response contains only "todo_1"
   - POST `/entities/query` as "actor_2" with `{"type": "todo"}`
   - Assert response contains only "todo_2"

### Validation Checks

8. **HLC future drift rejection:**
   - Build an action with HLC from `System.os_time(:millisecond) + 200_000` (200s in future, exceeds 120s limit)
   - Use `hlc_from(System.os_time(:millisecond) + 200_000)` to build the HLC
   - Assert the action is rejected with reason `"hlc_future_drift"`

9. **HLC staleness rejection:**
   - Build an action with HLC from `System.os_time(:millisecond) - 100_000_000` (>24h ago)
   - Use `hlc_from(System.os_time(:millisecond) - 100_000_000)` to build the HLC
   - Assert the action is rejected with reason `"hlc_stale"`

10. **Structure validation rejects Actions with missing required fields:**
    - Build an action with missing `id` field
    - Assert the action is rejected with reason `"invalid_structure"`

11. **Structure validation rejects Actions with invalid method:**
    - Build an action with update method `"upsert"` (invalid)
    - Assert the action is rejected with reason `"invalid_structure"`

### Auth Integration

12. **Handshake without auth header returns 401:**
    - POST `/sync/handshake` without `x-ebb-actor-id` header
    - Assert 401

13. **Actions without auth header returns 401:**
    - POST `/sync/actions` without `x-ebb-actor-id` header
    - Assert 401

### Backward Compatibility

14. **Existing Slice 1 flows still work (with auth):**
    - Bootstrap a group, write a todo entity, GET it back
    - Verify the full write → read cycle works end-to-end
    - This confirms that adding auth and permission checking didn't break the basic flow

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/slice2_integration_test.exs
```

All 14 test cases pass. The complete permission-checked write flow works end-to-end.

Also run the full test suite to verify nothing is broken:

```bash
cd ebb_server && mix test
```

All tests pass across all test files:
- `system_cache_test.exs` — existing + new permission API tests
- `writer_test.exs` — existing + new system cache update tests
- `permission_checker_test.exs` — all validation and authorization tests
- `auth_plug_test.exs` — bypass and external auth tests
- `handshake_test.exs` — handshake endpoint tests
- `entity_query_test.exs` — entity query endpoint tests
- `entity_store_query_test.exs` — entity store query unit tests
- `integration_test.exs` — existing Slice 1 integration tests (updated with auth headers)
- `slice2_integration_test.exs` — full Slice 2 integration tests

### Acceptance Criteria Verification

| Criterion | Test(s) |
|---|---|
| Group bootstrap accepted without prior permissions | Test 1 |
| ETS caches contain GroupMember and Relationship after bootstrap | Test 1 |
| User entity write to actor's Group accepted | Test 3 |
| User entity write to non-member Group rejected | Test 5 |
| Intra-Action resolution works | Test 4 |
| Permission-scoped query returns only visible entities | Test 7 |
| HLC future drift rejected (>120s) | Test 8 |
| HLC staleness rejected (>24h) | Test 9 |
| Actor identity mismatch rejected | Test 6 |
| Structure validation rejects missing fields | Tests 10, 11 |
| Auth integration: handshake returns actor_id | Test 2 |
