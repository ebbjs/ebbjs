# Phase 8: Entity Query Endpoint

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 7 — Entity Store Query](07-entity-store-query.md), [Phase 5 — Wire Permission Checker](05-wire-permission-checker.md)
> **Produces:** `POST /entities/query` endpoint in the Router, plus unit tests

---

## Task 23. Add entity query endpoint to Router

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (modify)

Add `POST /entities/query` endpoint. This endpoint accepts a JSON body with `type`, optional `filter`, and uses the authenticated `actor_id` from AuthPlug.

**Request format:** JSON body:

```json
{
  "type": "todo",
  "filter": { "completed": true },
  "limit": 50,
  "offset": 0
}
```

**Response format:** JSON array of entities:

```json
[
  {
    "id": "todo_abc",
    "type": "todo",
    "data": { "fields": { "title": { "type": "lww", "value": "Buy milk", "hlc": 123 } } },
    "created_hlc": 123,
    "updated_hlc": 456,
    "deleted_hlc": null,
    "last_gsn": 5
  }
]
```

**Implementation:**

```elixir
post "/entities/query" do
  {:ok, body, conn} = Plug.Conn.read_body(conn)
  actor_id = conn.assigns.actor_id

  case Jason.decode(body) do
    {:ok, %{"type" => type} = payload} when is_binary(type) and type != "" ->
      filter = payload["filter"]
      opts = []
      opts = if payload["limit"], do: [{:limit, payload["limit"]} | opts], else: opts
      opts = if payload["offset"], do: [{:offset, payload["offset"]} | opts], else: opts

      case EntityStore.query(type, filter, actor_id, opts) do
        {:ok, entities} ->
          response = Enum.map(entities, fn entity ->
            %{
              "id" => entity.id,
              "type" => entity.type,
              "data" => entity.data,
              "created_hlc" => entity.created_hlc,
              "updated_hlc" => entity.updated_hlc,
              "deleted_hlc" => entity.deleted_hlc,
              "last_gsn" => entity.last_gsn
            }
          end)

          send_json(conn, 200, response)

        {:error, reason} ->
          send_json(conn, 503, %{"error" => "query_failed", "details" => inspect(reason)})
      end

    {:ok, _} ->
      send_json(conn, 422, %{"error" => "validation_failed", "details" => "type is required and must be a non-empty string"})

    {:error, _} ->
      send_json(conn, 422, %{"error" => "invalid_json"})
  end
end
```

**Placement in router:** Add this route after the existing `get "/entities/:id"` route and before the `match _` catch-all.

**Note:** The `actor_id` comes from `conn.assigns.actor_id` (set by AuthPlug). The `filter` and pagination params come from the JSON body. The `EntityStore.query/3` function handles permission filtering via the SQLite permission JOIN.

---

## Task 24. Unit tests for entity query endpoint

**Files:** `ebb_server/test/ebb_server/sync/entity_query_test.exs` (create)

Test the entity query endpoint via `Plug.Test`. These tests require the full storage stack.

**Test setup:**

Same pattern as handshake tests: start storage supervisor with tmp_dir, clean up on exit.

```elixir
defmodule EbbServer.Sync.EntityQueryTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import EbbServer.TestHelpers
  alias EbbServer.Sync.Router

  # ... standard storage supervisor setup ...

  defp post_query(body, actor_id \\ "a_test") do
    conn(:post, "/entities/query", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp post_actions(body, actor_id \\ "a_test") do
    # Same helper as integration tests, with auth header
    # ... build conn with msgpack body and x-ebb-actor-id header ...
  end

  defp bootstrap_group(actor_id, group_id) do
    # Helper that creates a Group + GroupMember + Relationship bootstrap action
    hlc = generate_hlc()
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
          "data" => %{"fields" => %{"name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}}}
        },
        %{
          "id" => "upd_gm_" <> Nanoid.generate(),
          "subject_id" => "gm_" <> Nanoid.generate(),
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
          "id" => "upd_rel_" <> Nanoid.generate(),
          "subject_id" => "rel_" <> Nanoid.generate(),
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
    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end
```

**Test cases:**

1. **Query returns entities of the correct type:**
   - Bootstrap a group, write two "todo" entities with relationships to the group
   - `POST /entities/query` with `{"type": "todo"}`
   - Assert 200, response is a JSON array with 2 entities

2. **Query returns empty array when no entities exist:**
   - `POST /entities/query` with `{"type": "nonexistent"}`
   - Assert 200, response is `[]`

3. **Query respects permissions:**
   - Bootstrap group for actor "a_1"
   - Write a todo in that group
   - Query as "a_1" → returns the todo
   - Query as "a_2" (not a member) → returns `[]`

4. **Query with filter:**
   - Write two todos: one completed, one not
   - Query with `{"type": "todo", "filter": {"completed": true}}`
   - Assert only the completed todo is returned

5. **Query without type returns 422:**
   - `POST /entities/query` with `{}`
   - Assert 422

6. **Query without auth returns 401:**
   - POST without `x-ebb-actor-id` header
   - Assert 401

7. **Query with invalid JSON returns 422:**
   - POST with non-JSON body
   - Assert 422

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/sync/entity_query_test.exs
```

All 7 test cases pass. Entity query endpoint returns permission-scoped results with optional filtering.
