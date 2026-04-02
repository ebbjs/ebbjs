# Phase 5: Wire Permission Checker into HTTP API

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 2 — Permission Checker](02-permission-checker.md), [Phase 4 — Auth Integration](04-auth-integration.md)
> **Produces:** Updated `EbbServer.Sync.Router` with AuthPlug and Permission Checker integration in `POST /sync/actions`

---

## Task 14. Add AuthPlug to the Router

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (modify)

The AuthPlug needs to run before `match`/`dispatch` for endpoints that require authentication. However, some endpoints (like a future health check) may not need auth. The simplest approach for now: add AuthPlug to the plug pipeline for all routes, and handle auth-optional routes by checking `conn.halted?` or using a separate router.

For Slice 2, all endpoints require auth. Add the plug:

```elixir
plug Plug.Logger
plug EbbServer.Sync.AuthPlug
plug :match
plug :dispatch
```

**Important:** This means `GET /entities/:id` will now also require auth. The `actor_id` will come from `conn.assigns.actor_id` instead of the query parameter. However, to maintain backward compatibility with Slice 1 integration tests, keep the query parameter fallback for now. The `actor_id` from auth takes precedence.

Update the `GET /entities/:id` handler to prefer `conn.assigns.actor_id`:

```elixir
get "/entities/:id" do
  conn = Plug.Conn.fetch_query_params(conn)
  entity_id = conn.path_params["id"]
  actor_id = conn.assigns[:actor_id] || conn.query_params["actor_id"]

  case actor_id do
    nil -> send_json(conn, 400, %{"error" => "actor_id required"})
    actor_id -> # ... existing entity lookup logic
  end
end
```

---

## Task 15. Integrate Permission Checker into POST /sync/actions

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (modify)

Replace the current validation + write flow in `POST /sync/actions` with the Permission Checker pipeline.

**Current flow:**
1. Decode MessagePack → `decode_and_validate/1`
2. Router-level validation (structure checks)
3. `Writer.write_actions(actions)`

**New flow:**
1. Decode MessagePack body (keep the `Msgpax.unpack` step)
2. Extract actions list (keep the `decoded["actions"]` check)
3. Call `PermissionChecker.validate_and_authorize(actions, conn.assigns.actor_id)`
4. Pass `accepted` actions to `Writer.write_actions/1`
5. Combine Writer rejections with Permission Checker rejections in response

```elixir
post "/sync/actions" do
  {:ok, body, conn} = Plug.Conn.read_body(conn)
  actor_id = conn.assigns.actor_id

  case decode_msgpack(body) do
    {:ok, actions} ->
      {accepted, pc_rejected} = PermissionChecker.validate_and_authorize(actions, actor_id)

      if accepted == [] do
        send_json(conn, 200, %{"rejected" => format_rejections(pc_rejected)})
      else
        case Writer.write_actions(accepted) do
          {:ok, _gsn_range, writer_rejected} ->
            all_rejected = format_rejections(pc_rejected) ++ format_writer_rejections(writer_rejected)
            send_json(conn, 200, %{"rejected" => all_rejected})

          {:error, _reason} ->
            send_json(conn, 503, %{"error" => "write_failed"})
        end
      end

    {:error, error_type, reason} ->
      send_error(conn, error_type, reason)
  end
end
```

**Note on Writer input format:** The Permission Checker returns `validated_action` maps with atom keys and atom methods (`:put`, `:patch`, `:delete`). The current Writer expects string-keyed maps (from MessagePack decode). There are two options:

**Option A:** Update the Writer to accept atom-keyed validated actions. This is cleaner but requires modifying the Writer's `handle_call`, `validate_and_categorize`, and all internal functions that access action/update fields.

**Option B:** Have the Permission Checker return the original string-keyed actions alongside the validated versions, or convert back to string keys before passing to Writer.

**Recommended: Option A.** Update the Writer to work with atom-keyed maps. The Writer's internal validation (`validate_and_categorize`, `valid_action?`, `valid_update?`) can be simplified or removed since the Permission Checker now handles all validation. The Writer should trust that incoming actions are already validated.

**Modify Writer to accept validated actions:**

In `handle_call`, the actions now have atom keys. Update field access:
- `action["id"]` → `action.id` or `action[:id]`
- `action["updates"]` → `action.updates`
- `update["subject_id"]` → `update.subject_id`
- `update["method"]` → `update.method` (now an atom: `:put`, `:patch`, `:delete`)
- `action["gsn"]` → still set as string key `"gsn"` for ETF storage, or switch to atom

**Important decision:** When storing to RocksDB via ETF, the action should be stored with string keys for consistency with the existing data format and for compatibility with EntityStore materialization (which reads string keys). Convert back to string keys before ETF encoding:

```elixir
defp to_storage_format(action, gsn) do
  %{
    "id" => action.id,
    "actor_id" => action.actor_id,
    "hlc" => action.hlc,
    "gsn" => gsn,
    "updates" => Enum.map(action.updates, fn update ->
      %{
        "id" => update.id,
        "subject_id" => update.subject_id,
        "subject_type" => update.subject_type,
        "method" => Atom.to_string(update.method),
        "data" => update.data
      }
    end)
  }
end
```

**Simplify Writer validation:**

Remove `validate_and_categorize/1`, `valid_action?/1`, `valid_update?/1`, and `build_empty_update_rejections/1` from the Writer. The Permission Checker now handles all validation. The Writer can trust that all incoming actions are valid and non-empty.

Keep a minimal safety check: reject actions with empty updates (the Permission Checker should catch this, but defense in depth).

**Update `update_system_caches/2` for atom keys:**

The system cache update logic from Phase 3 must be updated to use atom-keyed access:

```elixir
defp update_system_caches(actions, state) do
  Enum.each(actions, fn action ->
    Enum.each(action.updates, fn update ->
      case update.subject_type do
        "groupMember" -> handle_group_member_update(update, state)
        "relationship" -> handle_relationship_update(update, state)
        _ -> :ok
      end
    end)
  end)
end

defp handle_group_member_update(update, _state) do
  case update.method do
    method when method in [:put, :patch] ->
      data = update.data
      fields = data["fields"] || %{}

      SystemCache.put_group_member(%{
        id: update.subject_id,
        actor_id: get_field_value(fields, "actor_id"),
        group_id: get_field_value(fields, "group_id"),
        permissions: get_field_value(fields, "permissions")
      })

    :delete ->
      SystemCache.delete_group_member(update.subject_id)
  end
end

defp handle_relationship_update(update, _state) do
  case update.method do
    method when method in [:put, :patch] ->
      data = update.data

      SystemCache.put_relationship(%{
        id: update.subject_id,
        source_id: data["source_id"] || get_field_value(data["fields"], "source_id"),
        target_id: data["target_id"] || get_field_value(data["fields"], "target_id"),
        type: data["type"] || get_field_value(data["fields"], "type"),
        field: data["field"] || get_field_value(data["fields"], "field")
      })

    :delete ->
      SystemCache.delete_relationship(update.subject_id)
  end
end
```

**Note:** The `data` field in `validated_update` is still a string-keyed map (it comes from the MessagePack decode and is passed through as-is by the Permission Checker). Only the action/update structural keys are atom-ified. So `update.data["fields"]` is correct (atom key for `data`, string key for `"fields"`).

**Update `decode_msgpack/1` helper:**

Simplify the router's decode function to just handle MessagePack decoding and actions list extraction, without the deep validation.

**⚠️ Behavior change:** The router previously returned 422 with structured `{field, message}` errors for individual action validation failures. With the Permission Checker handling validation, the API now returns:
- **422** only for request-level errors (invalid MessagePack encoding, missing `actions` key, `actions` not a list)
- **200 with `rejected` array** for action-level errors (bad structure, bad HLC, actor mismatch, unauthorized)

This is intentional: the API processes what it can and reports per-action rejections. A batch with 10 actions where 2 are invalid will accept the 8 valid ones and reject the 2 invalid ones, rather than failing the entire request. The rejection format changes from `[{"field": "0.hlc", "message": "must be a positive integer"}]` to `[{"id": "act_123", "reason": "invalid_structure", "details": "..."}]`.

```elixir
defp decode_msgpack(<<>>) do
  {:error, :invalid_msgpack, "empty body"}
end

defp decode_msgpack(body) do
  case Msgpax.unpack(body) do
    {:ok, %{"actions" => actions}} when is_list(actions) ->
      {:ok, actions}
    {:ok, _} ->
      {:error, :invalid_msgpack, "actions key is required and must be a list"}
    {:error, reason} ->
      {:error, :invalid_msgpack, reason}
  end
end
```

**Update rejection formatting:**

```elixir
defp format_rejections(rejections) do
  Enum.map(rejections, fn %{action_id: id, reason: reason, details: details} ->
    rejection = %{"id" => id, "reason" => reason}
    if details, do: Map.put(rejection, "details", details), else: rejection
  end)
end

# Writer rejections now use atom-keyed actions
defp format_writer_rejections(rejections) do
  Enum.map(rejections, fn %{action: action, reason: reason} ->
    %{"id" => action.id, "reason" => reason}
  end)
end
```

**Note:** The Writer's `rejected_action` type changes from `%{action: %{"id" => ...}, reason: ...}` (string keys) to `%{action: %{id: ..., ...}, reason: ...}` (atom keys). The `format_writer_rejections` function uses `action.id` (atom key access) accordingly.

---

## Task 16. Update existing Writer tests for atom-keyed actions

**Files:** `ebb_server/test/ebb_server/storage/writer_test.exs` (modify)

The Writer now accepts atom-keyed `validated_action` maps instead of string-keyed raw maps. All existing Writer tests must be updated.

**Update `sample_action` and `sample_update` usage in Writer tests:**

The existing tests use `sample_action()` and `sample_update()` from TestHelpers, which return string-keyed maps. The Writer now expects atom-keyed maps (the output of `PermissionChecker.to_validated_action`). Add a helper to convert:

```elixir
defp validated_action(overrides \\ %{}) do
  hlc = generate_hlc()
  update = validated_update()

  Map.merge(
    %{
      id: "act_" <> Nanoid.generate(),
      actor_id: "a_test",
      hlc: hlc,
      updates: [update]
    },
    overrides
  )
end

defp validated_update(overrides \\ %{}) do
  hlc = generate_hlc()

  Map.merge(
    %{
      id: "upd_" <> Nanoid.generate(),
      subject_id: "todo_" <> Nanoid.generate(),
      subject_type: "todo",
      method: :put,
      data: %{
        "fields" => %{
          "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
          "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
        }
      }
    },
    overrides
  )
end
```

**Update all test cases** to use `validated_action()` and `validated_update()` instead of `sample_action()` and `sample_update()`. Key changes:
- All field access in assertions changes from `action["id"]` to `action.id`
- Method values change from `"put"` to `:put`
- The ETF round-trip test must account for `to_storage_format` converting back to string keys

**Update ETF round-trip test:**

The stored action now has string keys (via `to_storage_format`), so the decoded ETF will have string keys even though the input had atom keys:

```elixir
test "action survives encode/decode round-trip" do
  # ... write validated_action ...
  decoded = :erlang.binary_to_term(binary, [:safe])
  # Stored format has string keys
  assert decoded["id"] == action.id
  assert decoded["actor_id"] == action.actor_id
  assert decoded["gsn"] == 1
end
```

**Update validation tests:**

The Writer no longer does its own validation (Permission Checker handles it). Remove or simplify the validation test cases:
- Remove "actions with invalid updates are rejected" test (Permission Checker handles this)
- Keep "actions with empty updates are filtered out" test as a safety check
- Update the empty-updates test to use atom-keyed maps

---

## Task 17. Update existing integration tests

**Files:** `ebb_server/test/ebb_server/integration_test.exs` (modify)

The existing integration tests need to be updated to work with the new auth requirement. Since test config has `auth_mode: :bypass`, all requests need the `x-ebb-actor-id` header.

**Update `post_actions/1`:**

Add the `x-ebb-actor-id` header to the request:

```elixir
defp post_actions(body, actor_id \\ "a_test") do
  # ... existing conn setup ...
  |> Map.put(:req_headers, [
    {"content-type", "application/msgpack"},
    {"x-ebb-actor-id", actor_id}
  ])
  # ...
end
```

**Update `get_entity/2`:**

Add the auth header:

```elixir
defp get_entity(id, actor_id \\ "a_test") do
  conn(:get, "/entities/#{id}?actor_id=#{actor_id}")
  |> put_req_header("x-ebb-actor-id", actor_id)
  |> Router.call([])
end
```

**Update HLC validation tests:**

The existing HLC validation tests use small HLC values like `123` which will now be rejected by the Permission Checker's HLC staleness check (logical time `123 >>> 16 = 0` is way in the past). These tests need significant rework:

1. **"HLC as positive integer is accepted"** — Change `"hlc" => 123` to `"hlc" => generate_hlc()`. The test now needs a valid action with proper actor_id matching and a group bootstrap (since the Permission Checker requires authorization). Alternatively, this test can be simplified to just verify the HLC passes validation by checking the response doesn't contain an HLC-related rejection.

2. **"HLC as positive integer string is accepted"** — Change to `"hlc" => "#{generate_hlc()}"`. The Permission Checker's `normalize_hlc/1` accepts string HLCs, so this should still pass.

3. **"HLC as zero/negative/nil/empty/float/non-numeric" tests** — These now return **200 with rejections** instead of **422**. The validation moved from the router (which returned 422) to the Permission Checker (which returns rejections in the 200 body). Update assertions:

```elixir
# Before:
assert conn.status == 422

# After:
assert conn.status == 200
{:ok, response} = Jason.decode(conn.resp_body)
assert length(response["rejected"]) > 0
# The rejection reason will be "invalid_structure" or "invalid_hlc"
```

**Important behavior change:** With the Permission Checker handling validation, the router no longer returns 422 for individual action validation errors. Instead:
- **422** is only returned for request-level errors (invalid MessagePack, missing `actions` key)
- **200 with rejections** is returned for action-level validation errors (bad HLC, missing fields, unauthorized)

This is a deliberate design change: the API now always processes what it can and reports per-action rejections, rather than failing the entire request for one bad action.

**Update the "validation error format" test:**

The existing test checks for 422 with structured `{field, message}` details. This test needs to be reworked:
- If the action has structural issues that the Permission Checker catches, it will be in the `rejected` array with a reason string, not the `{field, message}` format
- Remove or replace this test with one that checks the new rejection format

**Ensure actor_id consistency:** All existing test actions use `"actor_id" => "a_test"`. The `x-ebb-actor-id` header must also be `"a_test"` to avoid actor mismatch rejections.

**Ensure actions have proper authorization:** The existing tests write "todo" entities without group bootstrap. After this phase, these writes will be rejected by the Permission Checker as unauthorized (no group membership). Options:
1. **Recommended:** Add a `bootstrap_group` helper to the integration tests and call it before writing entities
2. Alternative: Add a test-only bypass in the Permission Checker (not recommended — tests should exercise real behavior)

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/writer_test.exs
```

All existing Writer tests pass with atom-keyed action updates. System cache update tests (from Phase 3) also pass with atom-keyed maps.

```bash
cd ebb_server && mix test test/ebb_server/integration_test.exs
```

All existing integration tests pass (with auth header updates, HLC fixes, and validation assertion changes). The Permission Checker is now wired into the action write path.

```bash
cd ebb_server && mix test
```

Full test suite passes.
