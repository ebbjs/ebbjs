# Investigation: Slice 1 smoke test cascade — seven bugs across the SSE + write + watermark + fan-out path

> **Status:** All bugs fixed. Smoke test passes end-to-end. Branch: `investigation/seed-catchup-mismatch`.
> **Affected:** `ebb_server` (release `0.1.0`) plus the @ebbjs/client materializer and the @ebbjs/server seed helpers. Exercised through `examples/ebb-client-smoke/`.
> **Triggered by:** Adding the integration test path (release binary + real `pnpm --filter ebb-client-smoke start` run).

## Summary

When `pnpm --filter ebb-client-smoke start` runs against a real `ebb_server` release, it fails at five different points. Each fix exposed the next bug, so the cascade looked like one issue but was seven interacting ones. The bugs span:

1. **Server catch-up:** `cf_group_actions` index empty (Writer / Fields.get)
2. **Server SSE plumbing:** Bandit commits the chunked response as soon as the plug returns (architecture)
3. **Server SSE stale cursor:** `write_stale_cursor_response` calls `chunk/2` without `send_chunked/2` (500)
4. **Server SSE alias:** `SSEConnection.start_link/4` raised `:undef` for the bare `SSEConnection` symbol (alias missing)
5. **Server watermark:** `Writer` never advanced the watermark (opts not wired in `application.ex`)
6. **Server watermark advance:** `advance_watermark/1` used `:ets.next(table, integer)` against a `{gsn, pid}` keyed table (stuck at 1)
7. **Server fan-out:** `Writer` never notified `FanOutRouter` (opts not wired in `application.ex`)
8. **Client materializer:** `mergeFields` did not unwrap `data.fields` for user-entity patches (double-wrap)
9. **Wire format:** seed used `updateId` (camelCase) instead of `update_id` (FieldValue schema)
10. **Authorizer:** seed gave `["read", "write"]` permissions, server requires `<type>.<verb>` or `<type>.*`

Each bug is documented below with the chain of evidence that surfaced it.

---

## Bug 1 — `cf_group_actions` index empty (the original "seed → catchUp" report)

`Writer.get_group_id_for_group_action_index/3` reads `data["source_id"]` and `data["target_id"]` *without* unwrapping the `FieldValue` shape (`{value, update_id, hlc}`). Meanwhile the sibling helper `build_intra_action_context/1` correctly uses `Fields.get/3` to unwrap. So when the seed action wraps relationship fields in FieldValue:

```elixir
data = %{"source_id" => %{"value" => "ent_w", "update_id" => "...", "hlc" => "..."}, ...}
```

the intra_ctx is built correctly (`%{"ent_w" => "grp_w"}`), but the index-lookup function sees `source_id = %{"value" => "ent_w", ...}` — a map — and tries to look that up in the cache and intra_ctx. Both miss. `build_group_action_index` returns `[]`. No cf_group_actions entry gets written.

The integration test in `catch_up_integration_test.exs` doesn't hit this bug because its helpers (`test/support/integration/action_helpers.ex`) send relationship fields as *plain strings* (`"source_id" => "todo_bootstrap"`) — not wrapped in FieldValue. The two paths were never exercised against the same writer code with the same data shape.

**Fix** — `ebb_server/lib/ebb_server/storage/writer.ex`: use `Fields.get/3` in `get_group_id_for_group_action_index/3`, matching the convention already used by `build_intra_action_context/1`.

---

## Bug 2 — Bandit closes the SSE response as soon as the plug returns

Once catch-up works, the smoke test reaches the SSE `subscribe()` step and sees the stream open then close immediately. `curl`-ing the endpoint directly shows `200 OK` headers but no event payloads.

**Root cause** — architectural. Bandit's pipeline runs the plug and waits for the returned `Plug.Conn`. Once the plug handler returns, Bandit's `Bandit.Pipeline.commit_response!/1` runs and calls `mod.chunk(adapter, "")`. Per the Bandit source comment:

```
# Sending an empty chunk implicitly ends the response.
```

So the empty terminator chunk Bandit sends to "commit" the response is the same one that ends the SSE stream — there is no way to keep the connection open after the plug returns.

This is invisible in unit tests because they use a plain `GenServer.start_link({conn, ...})` and the `validate_calling_process!` check is only enforced against the adapter on `chunk/2`. The unit tests never call `chunk/2`, so the test passes — but the production code path crashes the moment a chunk is attempted.

**Fix** — `ebb_server/lib/ebb_server/sync/sse_handler.ex` + `sse_connection.ex`:

- `SSEConnection` no longer calls `Plug.Conn.chunk` directly. It runs as a separate GenServer that receives `push_action` / `push_control` / `push_presence` casts and forwards each event to the request process via `send(parent, {:sse_chunk, kind, payload})`.
- `SSEHandler.open_sse/4` runs in the Bandit request process. After `send_chunked/2`, it enters a `receive` loop and writes chunks on behalf of the `SSEConnection` (it owns the adapter, so only it can call `chunk/2`).
- The loop exits when a chunk returns `{:error, :closed}` (client disconnect) or the `SSEConnection` DOWN fires. Bandit then commits the terminator chunk and the connection closes normally.

A side benefit: the `SSEConnection` monitors the request process and vice-versa, so cleanup happens on either side dying.

---

## Bug 3 — `write_stale_cursor_response` calls `chunk/2` without `send_chunked/2` first

The first client connection (after the seed writes a single action, so watermark = 1) sends `cursor=1`. The check `if cursor > watermark` is `1 > 1` → false, so this path doesn't fire here. But for a client that connects after the writer advances the watermark above 1, the router calls this branch:

```elixir
SSEHandler.write_stale_cursor_response(conn, watermark + 1)
```

That function called `Plug.Conn.chunk(conn, event)` without first calling `Plug.Conn.send_chunked(conn, 200)`. The router returns `:closed`, Bandit commits the response — but the `chunk/2` call itself raises because the conn is still in `:set` state, not `:chunked`.

**Fix** — `ebb_server/lib/ebb_server/sync/sse_handler.ex`: call `send_chunked(200)` and set the SSE headers before the first `chunk/2`.

---

## Bug 4 — `SSEConnectionSupervisor.start_child/3` raised `:undef`

```
** (UndefinedFunctionError) function EbbServer.Sync.SSEConnection.start_link/4 is undefined (module EbbServer.Sync.SSEConnection is not available)
```

`SSEConnectionSupervisor` lives in `EbbServer.Sync.Sup` and the file references the bare `SSEConnection` atom. Without an alias, Elixir looked up the module in `EbbServer.Sync.Sup.SSEConnection`, which doesn't exist.

**Fix** — `ebb_server/lib/ebb_server/sync/sup/sse_connection_supervisor.ex`: add `alias EbbServer.Sync.SSEConnection`.

---

## Bug 5 — `Writer` started without the WatermarkTracker's registered name

`WatermarkTracker.advance_watermark/1` is only invoked from `Writer` when `state.watermark_tracker` is non-nil and `Process.whereis/1` returns a live process. The default for that option in `Writer.init/1` is `nil`, and `Application.start/2` was launching the writer as just `{EbbServer.Storage.Writer, []}` — never passing the registered name. So `state.watermark_tracker` was `nil`, and `WatermarkTracker.committed_watermark()` always returned 0.

This in turn meant the SSE handshake saw `cursor=0 > watermark=0` is false (it should have been `1 > 0`), but more critically it meant every later write's `:batch_committed` notification found `to_push = []` because the watermark hadn't advanced.

**Fix** — `ebb_server/lib/ebb_server/application.ex`: pass `watermark_tracker: EbbServer.Storage.WatermarkTracker` to the Writer spec.

---

## Bug 6 — `WatermarkTracker.advance_watermark/1` never advances past 1

Once the watermark-tracker name was wired in, advancing started working — but only the *first* write advanced the watermark (from 0 to 1). Subsequent writes stayed at 1. The next bug.

The previous implementation called `:ets.next(table, current_watermark)` where the keys are `{gsn, pid}` tuples. In Erlang term ordering, `{1, smallest_pid} > 1` (tuple > integer). So `:ets.next(table, 1)` returned `{1, smallest_pid}` (gsn = 1, not 2), the guard `gsn == current_watermark + 1` failed, and the watermark never advanced.

This bug had been masked by:

- The integration tests that called `advance_watermark/1` always started from a fresh process with `current_watermark = 0`, where `:ets.next(table, 0)` correctly returns `{1, pid}`.
- The test for "stops at gap" checked `(1, 2)` then `(4, 4)` → returns 2, which also worked because of the same starting-from-0 path.

**Fix** — `ebb_server/lib/ebb_server/storage/watermark_tracker.ex`: replace the `:ets.next/2` traversal with a direct `has_committed?(table, gsn)` probe that uses `:ets.match_object/2` to look for any tuple with the requested `gsn`. Walk `gsn → gsn + 1 → gsn + 2 → …` and CAS-advance each step. On CAS contention, retry from the latest committed watermark (some other writer may have advanced past us).

A regression test was added (`test/ebb_server/storage/watermark_tracker_test.exs`) that calls `advance_watermark/1` three times in a row with `mark_range_committed` for `1, 2, 3, …, 5` to lock the bug down.

---

## Bug 7 — `Writer` never notified `FanOutRouter` of new batches

Even with the watermark advancing correctly, the SSE event for the new write never arrived at the client. Logs showed `FanOutRouter` receiving no `:batch_committed` message.

`Writer.init/1` defaults `fan_out_router` to `nil`. The condition `if state.fan_out_router && Process.whereis(state.fan_out_router) do` is therefore always false, so `send(state.fan_out_router, {:batch_committed, ...})` never runs.

**Fix** — `ebb_server/lib/ebb_server/application.ex`: also pass `fan_out_router: EbbServer.Sync.FanOutRouter` to the Writer spec (alongside `watermark_tracker`).

---

## Bug 8 — Client materializer double-wrapped user-entity patches

With the server now actually pushing the SSE event, the smoke test reached the final assertion (entity title = "Updated via SSE") and failed because the storage entity was unchanged. Logs from inside `mergeFields`:

```
patch = { "title": { value: "Updated via SSE", … } }
merged before = { "title": { value: "Hello, ebb", … } }
```

`mergeFields` iterated `Object.entries(patch)`. `patch` is what the wire delivered — which is `{ fields: { title: {…} } }` for user entities (per `ActionValidator.well_formed_data?/1`). So the loop saw `entries = [["fields", { title: {…} }]]` and wrote a `fields` key into `data.fields`, producing `{ fields: { fields: {...}, title: {...} } }`.

The corresponding put path was already fixed (extracted via `extractFields/1`), but the patch path wasn't.

**Fix** — `packages/storage/src/memory/entity-store.memory.ts`: introduce `extractPatchFields/1` that mirrors `extractFields/1` and call it from `mergeFields/2`. Updated the cast in both helpers to use `unknown` because the static `Update.data` type is `PutData | PatchData | null` and neither allows `{ fields: {...} }` at the top level.

Tests in `memory-adapter.test.ts`, `client.test.ts`, `client-sse.test.ts`, and `sse.test.ts` were updated to use the wrapped shape and to use `as never` to bypass the static-type guard (matching the production wire format).

---

## Bug 9 — Seed used `updateId` (camelCase) instead of `update_id`

After bug 8 was fixed, the merge now ran with `hlcCmp = 0` and compared `patchValue.update_id` vs `existingValue.update_id`. The existing value was the *seeded* entity, whose `FieldValue` had `updateId: "seed_title"` (camelCase from `examples/ebb-client-smoke/src/seed.ts` and `packages/server/src/seed-client.ts`). The patch used `update_id` (the correct snake_case per `@ebbjs/core`'s `FieldValueSchema`). So `existingValue.update_id` was `undefined`, `"upd_followup" >= undefined` is `false`, and the patch was rejected.

**Fix** — `examples/ebb-client-smoke/src/seed.ts`, `packages/server/src/seed-client.ts`, `packages/server/src/types.ts`: rename `updateId` → `update_id` to match the `FieldValue` schema.

---

## Bug 10 — Authorizer requires `<type>.<verb>` permissions, not bare `["read", "write"]`

`EbbServer.Storage.PermissionHelper.check_permission/3` checks for `"<type>.<permission>"` (e.g., `"todo.update"`) or `"<type>.*"`. The seed used `["read", "write"]` (no type prefix), so the writer's user-entity update was rejected with `not_authorized: missing required permission`.

**Fix** — `examples/ebb-client-smoke/src/seed.ts`: change the seed permissions to `["todo.*"]`. A real product would derive these from the entity type the actor can write to; for the smoke test, a wildcard on `todo.*` is fine.

---

## Reconstruction recipe

```bash
pkill -9 -f ebb_server 2>&1 ; \
cd /home/drew/projects/ebbjs/ebb_server && . "$HOME/.asdf/asdf.sh" && \
rm -rf _build/prod && MIX_ENV=prod mix release --overwrite 2>&1 | tail -3 && \
rm -rf /home/drew/projects/ebbjs/packages/server/dist/ebb_server && \
mkdir -p /home/drew/projects/ebbjs/packages/server/dist/ebb_server && \
cp -r _build/prod/rel/ebb_server/* /home/drew/projects/ebbjs/packages/server/dist/ebb_server/
```

Then from the repo root:

```bash
pkill -9 -f ebb_server 2>&1
rm -rf /tmp/ebb-smoke-data /tmp/ebb-smoke.out
EBB_DATA_DIR=/tmp/ebb-smoke-data pnpm --filter ebb-client-smoke start
```

Expected: `✓ smoke test passed`.

## Verification

- 310 Elixir tests pass (`MIX_ENV=test mix test`), including the new regression test for the `WatermarkTracker.advance_watermark/1` stale-cursor bug.
- 44 TypeScript storage tests pass.
- 46 client tests pass (`packages/client/src/sync/`).
- End-to-end smoke test passes (`pnpm --filter ebb-client-smoke start`).