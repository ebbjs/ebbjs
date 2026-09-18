# Investigation: `seed()` populates `cf_actions` and RelationshipCache but not `cf_group_actions`, breaking `catchUp`

> **Status:** Open. Started during slice 1 review of `@ebbjs/client`. Branch: `investigation/seed-catchup-mismatch`.
> **Affected:** `ebb_server` (release `0.1.0`), exercised through `examples/ebb-client-smoke/` and the existing `MIX_ENV=test mix test test/integration/catch_up_integration_test.exs`.
> **Workaround available?** No.

## TL;DR

After the slice 1 smoke test (`pnpm --filter ebb-client-smoke start`) seeds a group + member + relationship + entity, then calls `client.catchUp(grp_smoke, 0)`, the server returns `[]` instead of the bootstrapping action. The action *is* persisted (entity materialises via `GET /entities/:id`, `max_gsn` advances), and the in-memory `RelationshipCache` is populated, but the `cf_group_actions` index the catch-up endpoint reads from is **empty**. So catch-up never finds the action.

The bug appears to be on the server's data path between `seed()`'s wire shape and the writer's group-action-index logic. Specifically, the writer's `build_group_action_index/6` returns `[]` for the seed action even though it contains a `relationship` update. The integration test in `test/integration/catch_up_integration_test.exs` exercises the same endpoint with a structurally similar action and passes — which is what makes this hard to triage: the divergence is subtle.

## What we know

### Reproduction (deterministic)

```
1. Start the prod release with EBB_DATA_DIR=/tmp/ebb-X
2. POST /sync/actions with an action built by @ebbjs/server's seed()
   - subject updates: {group, groupMember, relationship, entity}
   - field values wrapped in {value, update_id, hlc} (FieldValue shape)
3. GET /sync/groups/grp_X?offset=0
   → returns [] (expected: at least 1 action)
4. GET /entities/ent_X
   → returns the entity correctly materialised
```

### Observed state after a successful seed

Probed via `mix run --no-start` against the live RocksDB directory after the release exits:

| Probe                                          | Value                | Expected    | Notes                              |
| ---------------------------------------------- | -------------------- | ----------- | ---------------------------------- |
| `RocksDB.get_max_gsn()`                        | `1`                  | `1`         | ✅ Action was persisted            |
| `WatermarkTracker.committed_watermark()`       | `0` (then `1` after explicit seed call) | `1` (after write) | ⚠️ Race / timing; see below  |
| `RelationshipCache.get_entity_group("ent_X")`  | `"grp_X"`            | `"grp_X"`   | ✅ Cache populated                  |
| `:ets.tab2list(:ebb_relationships)`           | contains `ent_X → grp_X` | same    | ✅ Cache populated                  |
| `cf_group_actions` iterator                    | `[]`                 | at least 1 entry | ❌ **Index not written**         |
| `catch_up_group(grp_X, actor_X, 0)`            | `{:ok, [], %{up_to_date: true}}` | `{:ok, [action], ...}` | ❌ Empty result            |

### Two layers of weird

1. **`cf_group_actions` is empty.** The writer only writes here for `subject_type == "relationship"`, via `Writer.build_group_action_index/6`. The seed action has a `relationship` update, so it *should* fire. It doesn't.

2. **Watermark behaviour is inconsistent.**
   - In the iex session (writer called directly, then probed), `committed_watermark()` stays at `0` after a write to an empty DB — the `advance_watermark` loop's `ets.next(:committed_ranges, 0)` finds the tuple `{1, pid}` but the `match?` guard requires `gsn == current_watermark + 1`, i.e. `gsn == 1`. The key's first element is `1`, so it should match. But the test showed `watermark: 0`.
   - After re-opening the same DB and seeding-from-rocksdb, `committed_watermark()` returns `1` (the seeded value from `RocksDB.get_max_gsn`). So the watermark *can* reflect reality — just not synchronously with the write.
   - **Likely:** `advance_watermark/1` is called immediately after `mark_range_committed/3` inside `Writer.handle_call({:write_actions, ...})`, but the WatermarkTracker's ETS table and atomics reference are process-local. If `advance_watermark` is called from the Writer process, the ETS reads see the right state — but if some test/probe reads from a different process, atomics get fresh state. **Worth confirming, not the root cause.**

### What we ruled out

| Hypothesis                                                         | Status                |
| ------------------------------------------------------------------ | --------------------- |
| Bug is in `@ebbjs/client`                                          | ❌ 46 mocked unit tests pass; storage materialises the entity on read. |
| `seed()` HTTP request fails silently                              | ❌ The entity appears in `GET /entities/:id` afterwards. |
| `RelationshipCache` is the wrong source for catch-up                | ❌ Catch-up reads `cf_group_actions`, a RocksDB column family. RelationshipCache is only consulted *during the write* to build the index entry. |
| `seed-client.ts` sends data in the wrong shape                     | ⚠️ Possibly. The integration test helpers in `test/support/integration/action_helpers.ex` use a *flat* `data: %{actor_id: "...", group_id: "...", permissions: [...]}` shape; our seed nests each field inside a `{value, update_id, hlc}` wrapper. The server's `Fields.get/3` unwraps `{value: x}` to `x` for nested-field reads, but the `relationship` path goes through `Fields.get(data, "source_id")` directly — should still work. **Verify.** |
| `to_storage_format` mangles the relationship data                   | ⚠️ It does NOT wrap `relationship` (or `groupMember`) data in `{fields: ...}`, it stores flat. But our seed *already* sends flat data with FieldValue wrappers, so storage sees the FieldValue shapes. **Verify the Fields.get path with this shape.** |
| The `relationships_by_group` ETS table isn't seeded before the write | ❌ Storage supervisor populates it on startup from RocksDB. After the write it has `ent_X → grp_X` in the cache. |
| `build_intra_action_context` returns an empty map for our shape      | ⚠️ Reads `Fields.get(data, "source_id")` and `Fields.get(data, "target_id")`. With our seed these resolve to plain strings. **Verify by adding a print or running the writer in `iex` with our exact action.** |

### What the writer's `build_group_action_index` requires

From `ebb_server/lib/ebb_server/storage/writer.ex`:

```elixir
defp build_group_action_index(_action_id, _gsn, _update, _rocks_name, nil, _intra_ctx), do: []

defp build_group_action_index(action_id, gsn, update, rocks_name, relationships, intra_ctx) do
  group_id = get_group_id_for_group_action_index(update, relationships, intra_ctx)
  if group_id do
    key = <<group_id::binary, gsn::unsigned-big-integer-size(64)>>
    [{:put, RocksDB.cf_group_actions(rocks_name), key, action_id}]
  else
    []
  end
end

defp get_group_id_for_group_action_index(update, relationships, intra_ctx) do
  case update.subject_type do
    "relationship" ->
      data = update.data || %{}
      source_id = data["source_id"]
      if source_id do
        Map.get(intra_ctx, source_id) ||
          RelationshipCache.get_entity_group(source_id, relationships)
      else
        nil
      end
    _ ->
      RelationshipCache.get_entity_group(update.subject_id, relationships)
  end
end
```

For our relationship update, `update.subject_type` must equal `"relationship"` (string). After `to_validated_update/1` in `ActionValidator`, the method becomes the atom `:put` — but `subject_type` stays a string (it's the raw incoming value). The case clause matches on the string. ✅

`update.data["source_id"]` — this reads `data` as a map with string keys. After msgpack decode + validation, the data shape our seed produces is:

```js
{
  source_id: { value: "ent_z", update_id: "u_xxx", hlc: "..." },
  target_id: { value: "grp_z", update_id: "u_xxx", hlc: "..." },
  type: { value: "todo", update_id: "u_xxx", hlc: "..." },
  field: { value: "ownedBy", update_id: "u_xxx", hlc: "..." },
}
```

After msgpack decode, this should be a map with string keys (`"source_id"`, etc.) and string values for the keys (since msgpack preserves types but Object → map). So `data["source_id"]` is the `{value, update_id, hlc}` object — a non-nil value. ✅

`intra_ctx` is built by `build_intra_action_context/1`:

```elixir
defp build_intra_action_context(updates) do
  updates
  |> Enum.filter(fn u -> u.subject_type == "relationship" end)
  |> Enum.reduce(%{}, fn u, acc ->
    data = u.data || %{}
    source_id = Fields.get(data, "source_id")
    target_id = Fields.get(data, "target_id")
    if source_id && target_id, do: Map.put(acc, source_id, target_id), else: acc
  end)
end
```

This calls `Fields.get/3` which **unwraps `{value: x}` to `x`**. So `source_id = "ent_z"`, `target_id = "grp_z"`. The intra_ctx map gets `{ent_z: grp_z}`. ✅

Then `get_group_id_for_group_action_index`:
- `Map.get(intra_ctx, "ent_z")` → `"grp_z"`. Returns `"grp_z"`. ✅

So `build_group_action_index` should write `{:put, cf_group_actions, <<"grp_z", 1::64>>, action_id}`. The cf_group_actions entry **should** exist. But it doesn't. So somewhere between the above analysis and the actual run, something's different.

### Two candidates worth investigating first

1. **`update.data` doesn't have string keys after msgpack decode** — msgpack preserves keys as strings (or as the type the encoder chose), but @msgpack/msgpack for JS may use object property names without explicit conversion. If keys come through as atoms (Erlang-side) or undefined behaviour, `data["source_id"]` returns `undefined` (JS) / errors (Elixir). Check the @msgpack/msgpack behaviour for objects with keys that look like atoms.

2. **`update.data` is processed twice** — once by `PermissionChecker.validate_and_authorize/2` (which may deep-clone or transform) and once by the writer. The data shape reaching the writer may differ from what the seed sends. Look at `ActionValidator.to_validated_action/1` and `PermissionChecker` carefully — they may transform `data`.

## What we need to test next (in priority order)

1. **Capture the exact action as seen by the writer.** Add a temporary `IO.inspect(actions, label: "writer sees")` at the top of `Writer.handle_call({:write_actions, ...})`, seed via HTTP, compare against what the integration test sends. This is the fastest way to bisect.

2. **Bisect within the writer.** Add inspects in `build_update_ops` and `build_group_action_index` to see what `update`, `intra_ctx`, `relationships` look like for our shape vs the integration test's shape.

3. **Check msgpack key types.** In an iex session, decode a sample of the seed's wire bytes with `Msgpax.unpack` and inspect the result. Compare key types to what the integration test sends.

4. **If the difference is in `data["source_id"]`** (returns nil where the integration test gets the string), the fix is likely in `seed-client.ts` (send flat string fields for `relationship`/`groupMember`) or in the writer's relationship branch (use `Fields.get` instead of direct map access).

## Tangential issues uncovered (out of scope for this investigation but worth filing)

- **`@ebbjs/server` `harness.ts` uses `__dirname` in ESM.** Bundling fails with `ReferenceError` at runtime. Fixed on slice 1 branch with `import.meta.url`.
- **`ebb_server` prod release ignores `EBB_PORT`.** `application.ex` reads `Application.get_env(:ebb_server, :port, 4000)` instead of `System.get_env("EBB_PORT")`. Smoke test works around by using port 4000.
- **Watermark advance may not be synchronous with write reply.** Should be — the `handle_call` does `mark_range_committed` then `advance_watermark` before `{:reply, ...}` — but worth a regression test.

## References

- `ebb_server/lib/ebb_server/storage/writer.ex` (Writer)
- `ebb_server/lib/ebb_server/storage/relationship_cache.ex`
- `ebb_server/lib/ebb_server/storage/watermark_tracker.ex`
- `ebb_server/lib/ebb_server/sync/catch_up.ex`
- `ebb_server/lib/ebb_server/storage/action_validator.ex`
- `packages/server/src/seed-client.ts`
- `examples/ebb-client-smoke/src/seed.ts`, `src/index.ts`
- `ebb_server/test/integration/catch_up_integration_test.exs` (the working path)
- `ebb_server/test/support/integration/action_helpers.ex` (helpers used by the working integration test)
