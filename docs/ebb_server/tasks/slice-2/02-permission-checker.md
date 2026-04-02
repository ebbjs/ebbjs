# Phase 2: Permission Checker

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 1 — System Cache Permission APIs](01-system-cache-permissions.md)
> **Produces:** `EbbServer.Storage.PermissionChecker` stateless module with all validation and authorization checks, plus unit tests

---

## Task 1. Create the Permission Checker module

**Files:** `ebb_server/lib/ebb_server/storage/permission_checker.ex` (create)

Create `EbbServer.Storage.PermissionChecker` as a stateless module (no GenServer). All state comes from ETS lookups via SystemCache functions defined in Phase 1 (`get_permissions/2`, `get_entity_group/1`).

**Types (module attributes or `@type` specs):**

```elixir
@type raw_action :: %{String.t() => term()}
@type raw_update :: %{String.t() => term()}

@type validated_action :: %{
  id: String.t(),
  actor_id: String.t(),
  hlc: non_neg_integer(),
  updates: [validated_update()]
}

@type validated_update :: %{
  id: String.t(),
  subject_id: String.t(),
  subject_type: String.t(),
  method: :put | :patch | :delete,
  data: map() | nil
}

@type rejection :: %{
  action_id: String.t(),
  reason: String.t(),
  details: String.t() | nil
}
```

**`validate_and_authorize(actions, actor_id)`:**

Main entry point. Iterates each raw action (string-keyed map from MessagePack decode) and runs the validation pipeline:

1. `validate_structure/1` — check required fields, valid formats
2. `validate_actor/2` — check `action["actor_id"] == actor_id`
3. `validate_hlc/1` — check HLC drift and staleness
4. `authorize_updates/2` — check Group membership and permissions

If all checks pass, convert the raw action to a `validated_action` (atom keys, atom methods). If any check fails, add to rejected list with reason.

Returns `{accepted :: [validated_action()], rejected :: [rejection()]}`.

```elixir
def validate_and_authorize(actions, actor_id, opts \\ []) do
  Enum.reduce(actions, {[], []}, fn action, {accepted, rejected} ->
    case run_checks(action, actor_id, opts) do
      {:ok, validated} -> {[validated | accepted], rejected}
      {:error, reason, details} ->
        rejection = %{action_id: action["id"], reason: reason, details: details}
        {accepted, [rejection | rejected]}
    end
  end)
  |> then(fn {accepted, rejected} -> {Enum.reverse(accepted), Enum.reverse(rejected)} end)
end

defp run_checks(action, actor_id, opts) do
  with :ok <- validate_structure(action),
       :ok <- validate_actor(action, actor_id),
       :ok <- validate_hlc(action, opts),
       :ok <- authorize_updates(action, actor_id, opts) do
    {:ok, to_validated_action(action)}
  end
end
```

**`validate_structure/1`:**

Checks required fields on the action and each update. Returns `:ok` or `{:error, reason, details}`.

```elixir
def validate_structure(action) do
  cond do
    not is_binary(action["id"]) or action["id"] == "" ->
      {:error, "invalid_structure", "action id must be a non-empty string"}
    not is_binary(action["actor_id"]) or action["actor_id"] == "" ->
      {:error, "invalid_structure", "action actor_id must be a non-empty string"}
    normalize_hlc(action["hlc"]) == nil ->
      {:error, "invalid_structure", "action hlc must be a positive integer"}
    not is_list(action["updates"]) or action["updates"] == [] ->
      {:error, "invalid_structure", "action updates must be a non-empty list"}
    true ->
      validate_updates_structure(action["updates"])
  end
end
```

**Note:** `normalize_hlc/1` (defined in `validate_hlc`) accepts both integers and parseable integer strings, matching the existing router's behavior. This ensures backward compatibility with clients that send HLC as a string.

For each update, check: `id` (non-empty string), `subject_id` (non-empty string), `subject_type` (non-empty string), `method` (one of `"put"`, `"patch"`, `"delete"`), `data` (map). For `"put"`/`"patch"` on **user entity types** (not `"group"`, `"groupMember"`, or `"relationship"`), `data["fields"]` must be a map. System entity types (`"relationship"` in particular) store data at the top level of `data` (e.g., `data["source_id"]`), not nested under `"fields"`, so the `data["fields"]` check must be skipped for them.

```elixir
@system_entity_types ["group", "groupMember", "relationship"]

defp validate_update_structure(update) do
  cond do
    not is_binary(update["id"]) or update["id"] == "" ->
      {:error, "invalid_structure", "update id must be a non-empty string"}
    not is_binary(update["subject_id"]) or update["subject_id"] == "" ->
      {:error, "invalid_structure", "update subject_id must be a non-empty string"}
    not is_binary(update["subject_type"]) or update["subject_type"] == "" ->
      {:error, "invalid_structure", "update subject_type must be a non-empty string"}
    update["method"] not in ["put", "patch", "delete"] ->
      {:error, "invalid_structure", "update method must be one of: put, patch, delete"}
    not is_map(update["data"]) ->
      {:error, "invalid_structure", "update data must be a map"}
    update["method"] in ["put", "patch"] and
      update["subject_type"] not in @system_entity_types and
      not is_map(update["data"]["fields"]) ->
      {:error, "invalid_structure", "update data.fields must be a map for put/patch on user entities"}
    true ->
      :ok
  end
end
```

**`validate_actor/2`:**

```elixir
def validate_actor(action, actor_id) do
  if action["actor_id"] == actor_id do
    :ok
  else
    {:error, "actor_mismatch", "action actor_id does not match authenticated actor"}
  end
end
```

**`validate_hlc/1`:**

Extract logical time via bitwise right shift: `logical_time_ms = action["hlc"] >>> 16` (using `Bitwise.bsr/2` or `>>>` operator with `import Bitwise`).

The HLC may arrive as an integer or as a string (MessagePack can encode large integers as strings depending on the client). Normalize to integer first, matching the existing router's behavior of accepting string HLCs via `Integer.parse/1`.

Compare to `System.os_time(:millisecond)`:
- If `logical_time_ms > now + 120_000` → reject with `"hlc_future_drift"`
- If `logical_time_ms < now - 86_400_000` → reject with `"hlc_stale"`

```elixir
import Bitwise

def validate_hlc(action, opts \\ []) do
  hlc = normalize_hlc(action["hlc"])

  cond do
    hlc == nil ->
      {:error, "invalid_hlc", "hlc must be a positive integer"}
    hlc <= 0 ->
      {:error, "invalid_hlc", "hlc must be a positive integer"}
    true ->
      logical_time_ms = hlc >>> 16
      now = Keyword.get(opts, :now_ms, System.os_time(:millisecond))

      cond do
        logical_time_ms > now + 120_000 ->
          {:error, "hlc_future_drift", "logical time is more than 120s in the future"}
        logical_time_ms < now - 86_400_000 ->
          {:error, "hlc_stale", "logical time is more than 24h in the past"}
        true ->
          :ok
      end
  end
end

defp normalize_hlc(hlc) when is_integer(hlc), do: hlc
defp normalize_hlc(hlc) when is_binary(hlc) do
  case Integer.parse(hlc) do
    {int, ""} when int > 0 -> int
    _ -> nil
  end
end
defp normalize_hlc(_), do: nil
```

**Note:** The `opts` keyword accepts `:now_ms` for deterministic testing. Pass through from `validate_and_authorize/3`.

**`authorize_updates/2`:**

1. Build intra-action context by scanning Relationship updates in the action
2. Detect Group bootstrap pattern
3. If bootstrap detected, allow entire action
4. Otherwise, check each update individually

```elixir
def authorize_updates(action, actor_id, opts \\ []) do
  updates = action["updates"]
  intra_ctx = build_intra_action_context(updates)

  if is_group_bootstrap?(updates, actor_id) do
    :ok
  else
    check_all_updates(updates, actor_id, intra_ctx, opts)
  end
end
```

**`build_intra_action_context/1`:**

Scan updates for Relationship PUTs. Build a map of `%{source_id => target_id}` (entity_id → group_id).

```elixir
defp build_intra_action_context(updates) do
  updates
  |> Enum.filter(fn u -> u["subject_type"] == "relationship" and u["method"] == "put" end)
  |> Enum.reduce(%{}, fn u, acc ->
    source_id = get_in(u, ["data", "source_id"])
    target_id = get_in(u, ["data", "target_id"])
    if source_id && target_id, do: Map.put(acc, source_id, target_id), else: acc
  end)
end
```

**`is_group_bootstrap?/2`:**

Detect the pattern: Action has PUT for `group` type + PUT for `groupMember` where `actor_id` matches the authenticated actor and `group_id` matches the new group + PUT for `relationship` linking to the new group.

```elixir
defp is_group_bootstrap?(updates, actor_id) do
  group_ids = updates
    |> Enum.filter(fn u -> u["subject_type"] == "group" and u["method"] == "put" end)
    |> Enum.map(fn u -> u["subject_id"] end)
    |> MapSet.new()

  has_matching_member = Enum.any?(updates, fn u ->
    u["subject_type"] == "groupMember" and
    u["method"] == "put" and
    get_in(u, ["data", "actor_id"]) == actor_id and
    MapSet.member?(group_ids, get_in(u, ["data", "group_id"]))
  end)

  has_matching_relationship = Enum.any?(updates, fn u ->
    u["subject_type"] == "relationship" and
    u["method"] == "put" and
    MapSet.member?(group_ids, get_in(u, ["data", "target_id"]))
  end)

  MapSet.size(group_ids) > 0 and has_matching_member and has_matching_relationship
end
```

**`check_all_updates/4`:**

For each update, dispatch based on `subject_type`:
- `"group"`, `"groupMember"`, `"relationship"` → system entity authorization
- Any other type → user entity authorization

```elixir
defp check_all_updates(updates, actor_id, intra_ctx, opts) do
  Enum.reduce_while(updates, :ok, fn update, _acc ->
    result = case update["subject_type"] do
      type when type in @system_entity_types ->
        authorize_system_entity_update(update, actor_id, intra_ctx, opts)
      _user_type ->
        authorize_user_entity_update(update, actor_id, intra_ctx, opts)
    end

    case result do
      :ok -> {:cont, :ok}
      error -> {:halt, error}
    end
  end)
end
```

**System entity authorization (`authorize_system_entity_update/4`):**

For system entity updates outside of a bootstrap action, the actor must be a member of the relevant group:

- `"group"` updates: actor must be a member of that group (for edits to existing groups). For new groups, this is handled by the bootstrap check above.
- `"groupMember"` updates: actor must be a member of the `group_id` referenced in the update's data.
- `"relationship"` updates: actor must be a member of the `target_id` (group) referenced in the update's data.

```elixir
defp authorize_system_entity_update(update, actor_id, _intra_ctx, opts) do
  case update["subject_type"] do
    "group" ->
      # Editing an existing group — actor must be a member
      group_id = update["subject_id"]
      case SystemCache.get_permissions(actor_id, group_id, opts) do
        nil -> {:error, "not_authorized", "actor is not a member of the group"}
        _perms -> :ok
      end

    "groupMember" ->
      # Adding/editing a group member — actor must be a member of the target group
      group_id = get_in(update, ["data", "fields", "group_id", "value"]) ||
                 get_in(update, ["data", "group_id"])
      case SystemCache.get_permissions(actor_id, group_id, opts) do
        nil -> {:error, "not_authorized", "actor is not a member of the target group"}
        _perms -> :ok
      end

    "relationship" ->
      # Creating/editing a relationship — actor must be a member of the target group
      target_id = get_in(update, ["data", "target_id"])
      case SystemCache.get_permissions(actor_id, target_id, opts) do
        nil -> {:error, "not_authorized", "actor is not a member of the target group"}
        _perms -> :ok
      end
  end
end
```

**Note:** System entity authorization outside of bootstrap requires group membership but does not check specific permissions (e.g., `"groupMember.create"`). Any member of a group can manage that group's system entities. More granular system entity permissions can be added later.

**User entity authorization (`authorize_user_entity_update/4`):**

1. Find entity's group: `SystemCache.get_entity_group(update["subject_id"], opts)` — if nil, check intra-action context
2. If no group found at all → reject with `"not_authorized"`
3. Check permissions: `SystemCache.get_permissions(actor_id, group_id, opts)` — if nil → reject
4. If permissions is a list, check for exact match (`"#{type}.#{permission}"`) or wildcard (`"#{type}.*"`)
5. Permission mapping: `"put"` → `"create"`, `"patch"` → `"update"`, `"delete"` → `"delete"`

```elixir
defp method_to_permission("put"), do: "create"
defp method_to_permission("patch"), do: "update"
defp method_to_permission("delete"), do: "delete"
```

**`to_validated_action/1`:**

Convert string-keyed raw action to atom-keyed validated action:

```elixir
defp to_validated_action(action) do
  %{
    id: action["id"],
    actor_id: action["actor_id"],
    hlc: normalize_hlc(action["hlc"]),
    updates: Enum.map(action["updates"], &to_validated_update/1)
  }
end

@method_atoms %{"put" => :put, "patch" => :patch, "delete" => :delete}

defp to_validated_update(update) do
  %{
    id: update["id"],
    subject_id: update["subject_id"],
    subject_type: update["subject_type"],
    method: Map.fetch!(@method_atoms, update["method"]),
    data: update["data"]
  }
end
```

**Important:** All SystemCache calls should accept optional table name params via `opts` for test isolation. Pass through the `opts` keyword from `validate_and_authorize/3` to all internal functions that call SystemCache.

---

## Task 2. Unit tests for Permission Checker

**Files:** `ebb_server/test/ebb_server/storage/permission_checker_test.exs` (create)

Tests should manually populate ETS tables to test authorization in isolation, without needing the full storage stack.

**Test setup:**

Create isolated ETS tables for `group_members`, `relationships`, and `relationships_by_group` in each test's setup. Use unique names per test to allow parallel execution.

```elixir
defmodule EbbServer.Storage.PermissionCheckerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.PermissionChecker

  defp create_isolated_tables do
    uid = System.unique_integer([:positive])
    gm = :"test_gm_#{uid}"
    rel = :"test_rel_#{uid}"
    rbg = :"test_rbg_#{uid}"

    :ets.new(gm, [:bag, :public, :named_table])
    :ets.new(rel, [:set, :public, :named_table])
    :ets.new(rbg, [:bag, :public, :named_table])

    on_exit(fn ->
      for t <- [gm, rel, rbg] do
        try do :ets.delete(t) rescue _ -> :ok end
      end
    end)

    %{group_members: gm, relationships: rel, relationships_by_group: rbg}
  end
```

**Test cases:**

1. **`validate_structure/1` — valid action passes:**
   - Build a valid raw action with all required fields
   - Assert `validate_structure(action) == :ok`

2. **`validate_structure/1` — missing id rejected:**
   - Action with `"id" => nil` → `{:error, "invalid_structure", _}`

3. **`validate_structure/1` — missing actor_id rejected:**
   - Action with `"actor_id" => ""` → `{:error, "invalid_structure", _}`

4. **`validate_structure/1` — invalid method rejected:**
   - Update with `"method" => "upsert"` → `{:error, "invalid_structure", _}`

5. **`validate_structure/1` — empty updates rejected:**
   - Action with `"updates" => []` → `{:error, "invalid_structure", _}`

6. **`validate_structure/1` — system entity without `data.fields` passes:**
   - Build action with a relationship PUT update where `data` has `source_id`, `target_id` at top level (no `"fields"` key)
   - Assert `validate_structure(action) == :ok`

7. **`validate_structure/1` — user entity without `data.fields` rejected:**
   - Build action with a "todo" PUT update where `data` has no `"fields"` key
   - Assert `{:error, "invalid_structure", _}`

8. **`validate_structure/1` — string HLC accepted:**
   - Action with `"hlc" => "#{generate_hlc()}"` (string representation)
   - Assert `validate_structure(action) == :ok`

9. **`validate_actor/2` — matching actor passes:**
   - `validate_actor(%{"actor_id" => "a_1"}, "a_1")` → `:ok`

10. **`validate_actor/2` — mismatched actor rejected:**
    - `validate_actor(%{"actor_id" => "a_1"}, "a_2")` → `{:error, "actor_mismatch", _}`

11. **`validate_hlc/1` — current HLC passes:**
    - Build action with `generate_hlc()` → `:ok`

12. **`validate_hlc/1` — string HLC passes:**
    - Build action with `"hlc" => "#{generate_hlc()}"` (string representation of valid HLC)
    - Assert `:ok`

13. **`validate_hlc/1` — future drift rejected:**
    - Build HLC from `System.os_time(:millisecond) + 200_000` (200s in future) → `{:error, "hlc_future_drift", _}`

14. **`validate_hlc/1` — stale HLC rejected:**
    - Build HLC from `System.os_time(:millisecond) - 100_000_000` (>24h ago) → `{:error, "hlc_stale", _}`

15. **`authorize_updates/2` — Group bootstrap allowed without prior permissions:**
    - Build action with PUT for group, PUT for groupMember (matching actor), PUT for relationship (linking to group)
    - No ETS entries needed
    - Assert `authorize_updates(action, actor_id, opts) == :ok`

16. **`authorize_updates/2` — authorized user entity write:**
    - Populate ETS: group_members has `{actor_id, %{id: "gm_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]}}`
    - Populate ETS: relationships has `{entity_id, %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}`
    - Build action with PUT for entity_id of type "todo"
    - Assert `:ok`

17. **`authorize_updates/2` — unauthorized write (not a member):**
    - Populate ETS: relationships has entry linking entity to group "g_1"
    - No group_members entry for actor
    - Assert `{:error, "not_authorized", _}`

18. **`authorize_updates/2` — unauthorized write (wrong permissions):**
    - Populate ETS: group_members has `{actor_id, %{..., permissions: ["post.create"]}}` (wrong type)
    - Populate ETS: relationships has entry linking entity to group
    - Build action with PUT for "todo" type
    - Assert `{:error, "not_authorized", _}`

19. **`authorize_updates/2` — wildcard permission matches:**
    - Populate ETS: group_members with `permissions: ["todo.*"]`
    - Populate ETS: relationships linking entity to group
    - Build action with PATCH for "todo" type
    - Assert `:ok`

20. **`authorize_updates/2` — intra-action resolution:**
    - No ETS entries for the entity
    - Build action with: PUT for new entity + PUT for relationship linking entity to group
    - Populate ETS: group_members with actor in that group with correct permissions
    - Assert `:ok` (relationship from same action provides the group context)

21. **`authorize_updates/2` — system entity update authorized when actor is group member:**
    - Populate ETS: group_members with actor in group "g_1"
    - Build action with PATCH for a "groupMember" entity in group "g_1"
    - Assert `:ok`

22. **`authorize_updates/2` — system entity update rejected when actor is not group member:**
    - No group_members entry for actor
    - Build action with PATCH for a "groupMember" entity in group "g_1"
    - Assert `{:error, "not_authorized", _}`

23. **`validate_and_authorize/2` — full pipeline, mixed accepted and rejected:**
    - Build two actions: one valid and authorized, one with actor mismatch
    - Assert `{[validated_action], [rejection]}`
    - Verify validated action has atom keys and atom method
    - Verify validated action's HLC is an integer (even if input was a string)

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/permission_checker_test.exs
```

All 23 test cases pass. Permission Checker validates structure (including system entity data shape exemption), actor identity, HLC drift/staleness (with string HLC support), and Group-based authorization including bootstrap detection, intra-action resolution, and system entity authorization.
