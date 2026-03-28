# Phase 7: HTTP API

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 5 — Writer](05-writer.md), [Phase 6 — Entity Store](06-entity-store.md)
> **Produces:** `EbbServer.Sync.Router` Plug router with `POST /sync/actions` and `GET /entities/:id`

---

## Task 18. POST /sync/actions

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (create)

Create `EbbServer.Sync.Router` as a `Plug.Router`.

**Module setup:**

```elixir
use Plug.Router

plug Plug.Logger
plug :match
plug :dispatch
```

**`POST /sync/actions`:**

- Read raw body: `{:ok, body, conn} = Plug.Conn.read_body(conn)`
- Decode MessagePack: `{:ok, decoded} = Msgpax.unpack(body)`
- Extract actions list: `actions = decoded["actions"] || []`
- Basic validation: verify `actions` is a list, each action has `"id"`, `"actor_id"`, `"hlc"`, `"updates"` keys. Each update has `"id"`, `"subject_id"`, `"subject_type"`, `"method"`, `"data"` keys. Method must be one of `"put"`, `"patch"`, `"delete"`.
- If validation fails, return 422 with error details
- Call `Writer.write_actions(actions)` — this blocks until durable
- On `{:ok, _gsn_range}` → respond 200 with `Jason.encode!(%{"rejected" => []})`
- On `{:error, reason}` → respond 503

**Content-Type:** Set `content-type: application/json` on response.

---

## Task 19. GET /entities/:id

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (modify)

Add the GET endpoint to the router:

**`GET /entities/:id`:**

- Extract `id` from path params
- Call `Plug.Conn.fetch_query_params(conn)` to parse query string
- Extract `actor_id` from `conn.query_params["actor_id"]` (required but not validated in Slice 1)
- If `actor_id` is missing, return 400 with `{"error": "actor_id query parameter required"}`
- Call `EntityStore.get(id, actor_id)`
- On `{:ok, entity}`:
  - Format response: `%{"id" => entity.id, "type" => entity.type, "data" => entity.data, "created_hlc" => entity.created_hlc, "updated_hlc" => entity.updated_hlc, "deleted_hlc" => entity.deleted_hlc, "last_gsn" => entity.last_gsn}`
  - Respond 200 with `Jason.encode!(response)`
- On `:not_found` → respond 404 with `{"error": "not_found"}`

Add a catch-all `match _ do ... end` that returns 404.

---

## Verification

No standalone tests for this phase — the HTTP endpoints are validated by the integration tests in Phase 9. However, you can manually test with:

```bash
# Start the server (after wiring in Phase 8)
cd ebb_server && mix run --no-halt

# In another terminal, POST an action (requires a MessagePack payload)
# GET an entity
curl http://localhost:4000/entities/todo_xyz789?actor_id=a_test
```
