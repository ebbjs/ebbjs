# Phase 6: Handshake Endpoint

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 4 — Auth Integration](04-auth-integration.md), [Phase 2 — System Cache Permission APIs](02-system-cache-permissions.md)
> **Produces:** `POST /sync/handshake` endpoint in the Router, plus unit tests

---

## Task 18. Add handshake endpoint to Router

**Files:** `ebb_server/lib/ebb_server/sync/router.ex` (modify)

Add `POST /sync/handshake` endpoint. This endpoint authenticates the client (via AuthPlug, already wired in Phase 5), looks up the actor's Groups from SystemCache, and returns the actor's identity and group memberships.

**Request format:** JSON body with `cursors` and `schema_version`:

```json
{
  "cursors": {"group_1": 500, "group_2": 200},
  "schema_version": 1
}
```

**Response format:** JSON with `actor_id` and `groups`:

```json
{
  "actor_id": "actor_123",
  "groups": [
    {"id": "group_1", "permissions": ["todo.create", "todo.update"]},
    {"id": "group_2", "permissions": ["post.*"]}
  ]
}
```

**Implementation:**

```elixir
post "/sync/handshake" do
  {:ok, body, conn} = Plug.Conn.read_body(conn)
  actor_id = conn.assigns.actor_id

  case Jason.decode(body) do
    {:ok, payload} ->
      _cursors = payload["cursors"] || %{}
      _schema_version = payload["schema_version"]

      # Look up actor's groups from SystemCache
      groups = SystemCache.get_actor_groups(actor_id)

      response = %{
        "actor_id" => actor_id,
        "groups" => Enum.map(groups, fn %{group_id: gid, permissions: perms} ->
          %{"id" => gid, "permissions" => perms}
        end)
      }

      send_json(conn, 200, response)

    {:error, _} ->
      send_json(conn, 422, %{"error" => "invalid_json"})
  end
end
```

**Cursor validation:** For Slice 2, cursor validation is stubbed. The endpoint accepts cursors but does not validate them against the committed watermark or low-water mark. This will be implemented in a later slice when catch-up and fan-out are built.

**Note:** The handshake endpoint must be placed before the `match _` catch-all in the router. Place it after the existing `post "/sync/actions"` route.

**Add `alias EbbServer.Storage.SystemCache`** to the router's alias list if not already present.

---

## Task 19. Unit tests for handshake endpoint

**Files:** `ebb_server/test/ebb_server/sync/handshake_test.exs` (create)

Test the handshake endpoint via `Plug.Test`. These tests require the full storage stack (for SystemCache) and use bypass auth mode.

**Test setup:**

Same pattern as the existing integration tests: start the storage supervisor with a tmp_dir, clean up on exit.

```elixir
defmodule EbbServer.Sync.HandshakeTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import EbbServer.TestHelpers
  alias EbbServer.Sync.Router
  alias EbbServer.Storage.SystemCache

  setup do
    # Same setup as integration_test.exs: stop existing supervisor, start fresh
    if pid = Process.whereis(EbbServer.Storage.Supervisor) do
      GenServer.stop(pid)
      :timer.sleep(200)
    end

    tmp_dir = tmp_dir(%{module: __MODULE__, test: "handshake_#{:erlang.unique_integer([:positive])}"})
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

  defp post_handshake(body, actor_id \\ "a_test") do
    conn(:post, "/sync/handshake", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end
```

**Test cases:**

1. **Handshake with no groups returns empty list:**
   - POST handshake with actor "a_new" who has no group memberships
   - Assert 200 response
   - Assert `response["actor_id"] == "a_new"`
   - Assert `response["groups"] == []`

2. **Handshake returns actor's groups after bootstrap:**
   - First, POST a bootstrap action (Group + GroupMember + Relationship) via `/sync/actions`
   - Then POST handshake
   - Assert response includes the group with correct permissions

3. **Handshake with invalid JSON returns 422:**
   - POST with non-JSON body
   - Assert 422

4. **Handshake without auth returns 401:**
   - POST without `x-ebb-actor-id` header
   - Assert 401

5. **Handshake accepts cursors (stub validation):**
   - POST with `{"cursors": {"g_1": 100}, "schema_version": 1}`
   - Assert 200 (cursors are accepted but not validated)

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/sync/handshake_test.exs
```

All 5 test cases pass. Handshake endpoint authenticates, looks up groups, and returns the correct response.
