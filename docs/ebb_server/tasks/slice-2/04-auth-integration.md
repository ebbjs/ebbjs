# Phase 4: Auth Integration

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** Slice 1 complete (Router exists)
> **Produces:** `EbbServer.Sync.AuthPlug` Plug module with configurable auth modes, plus unit tests

---

## Task 11. Create the AuthPlug module

**Files:** `ebb_server/lib/ebb_server/sync/auth_plug.ex` (create)

Create `EbbServer.Sync.AuthPlug` as a Plug that authenticates incoming requests. Supports two modes:

1. **`:external`** (default) — forwards auth headers to a configured URL, expects `{"actor_id": "..."}` on 200
2. **`:bypass`** — trusts the `x-ebb-actor-id` header directly (for testing)

The mode is configured via `Application.get_env(:ebb_server, :auth_mode, :external)`.

```elixir
defmodule EbbServer.Sync.AuthPlug do
  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case auth_mode() do
      :bypass -> bypass_auth(conn)
      :external -> external_auth(conn)
    end
  end

  defp auth_mode do
    Application.get_env(:ebb_server, :auth_mode, :external)
  end
```

**Bypass mode (`bypass_auth/1`):**

Read the `x-ebb-actor-id` header. If present, assign `actor_id` to conn. If missing, return 401.

```elixir
defp bypass_auth(conn) do
  case get_req_header(conn, "x-ebb-actor-id") do
    [actor_id] when actor_id != "" ->
      assign(conn, :actor_id, actor_id)
    _ ->
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(401, Jason.encode!(%{"error" => "unauthorized", "details" => "missing x-ebb-actor-id header"}))
      |> halt()
  end
end
```

**External mode (`external_auth/1`):**

Forward the request's auth-related headers (`authorization`, `cookie`, or all headers) to the configured `auth_url` via an HTTP POST. Use `Req` — it's already a dependency (currently scoped to `:test` only, so move it to all environments in `mix.exs`).

**Why `Req` over `:httpc`:** `:httpc` has an awkward charlist-based API, painful tuple-based responses (`{:ok, {{_version, status, _reason}, _headers, body}}`), and manual JSON decoding. `Req` is idiomatic Elixir with built-in JSON decoding, sensible defaults, and clean error handling. It's already in the project's deps.

**Modify `mix.exs`:** Change `{:req, "~> 0.5", only: :test}` to `{:req, "~> 0.5"}` (remove the `only: :test` restriction).

```elixir
defp external_auth(conn) do
  auth_url = Application.get_env(:ebb_server, :auth_url)

  if is_nil(auth_url) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(500, Jason.encode!(%{"error" => "auth_url not configured"}))
    |> halt()
  else
    headers = extract_auth_headers(conn)
    case call_auth_url(auth_url, headers) do
      {:ok, actor_id} ->
        assign(conn, :actor_id, actor_id)
      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(401, Jason.encode!(%{"error" => "unauthorized", "details" => reason}))
        |> halt()
    end
  end
end

defp extract_auth_headers(conn) do
  conn.req_headers
  |> Enum.filter(fn {name, _} -> name in ["authorization", "cookie", "x-ebb-token"] end)
end

defp call_auth_url(url, headers) do
  case Req.post(url, headers: headers, receive_timeout: 5_000) do
    {:ok, %Req.Response{status: 200, body: %{"actor_id" => actor_id}}} when is_binary(actor_id) ->
      {:ok, actor_id}
    {:ok, %Req.Response{status: 200}} ->
      {:error, "invalid auth response"}
    {:ok, %Req.Response{status: status}} ->
      {:error, "auth server returned #{status}"}
    {:error, exception} ->
      {:error, "auth request failed: #{Exception.message(exception)}"}
  end
end
```

**Note:** `Req` automatically decodes JSON response bodies when the content-type is `application/json`, so `body` is already a map — no manual `Jason.decode` needed.

---

## Task 12. Add auth configuration and promote Req dependency

**Files:** `ebb_server/mix.exs` (modify), `ebb_server/config/test.exs` (modify)

Promote `Req` from test-only to all environments in `mix.exs`:

```elixir
# Before:
{:req, "~> 0.5", only: :test}

# After:
{:req, "~> 0.5"}
```

Add bypass auth mode for tests in `config/test.exs`:

```elixir
config :ebb_server, auth_mode: :bypass
```

This means all tests can authenticate by simply setting the `x-ebb-actor-id` header on requests.

**Files:** `ebb_server/config/config.exs` (modify)

Add default auth configuration (external mode is the default, no change needed for mode, but document the `auth_url` config):

```elixir
# config :ebb_server, auth_url: "http://localhost:3001/auth"
# config :ebb_server, auth_mode: :external  # default
```

No actual change needed in `config.exs` since `:external` is the default and `auth_url` will be set per deployment. Just add a comment for documentation.

---

## Task 13. Unit tests for AuthPlug

**Files:** `ebb_server/test/ebb_server/sync/auth_plug_test.exs` (create)

Test the AuthPlug in both bypass and external modes.

**Test setup:**

Use `Application.put_env` to switch auth modes per test. Restore on exit.

```elixir
defmodule EbbServer.Sync.AuthPlugTest do
  use ExUnit.Case, async: false

  import Plug.Test
  alias EbbServer.Sync.AuthPlug

  setup do
    original_mode = Application.get_env(:ebb_server, :auth_mode)
    original_url = Application.get_env(:ebb_server, :auth_url)

    on_exit(fn ->
      if original_mode, do: Application.put_env(:ebb_server, :auth_mode, original_mode),
        else: Application.delete_env(:ebb_server, :auth_mode)
      if original_url, do: Application.put_env(:ebb_server, :auth_url, original_url),
        else: Application.delete_env(:ebb_server, :auth_url)
    end)

    :ok
  end
```

**Test cases:**

1. **Bypass mode — valid header assigns actor_id:**
   - Set `auth_mode: :bypass`
   - Build conn with `x-ebb-actor-id: "actor_123"` header
   - Call `AuthPlug.call(conn, [])`
   - Assert `conn.assigns.actor_id == "actor_123"`
   - Assert conn is not halted

2. **Bypass mode — missing header returns 401:**
   - Set `auth_mode: :bypass`
   - Build conn without the header
   - Call `AuthPlug.call(conn, [])`
   - Assert `conn.status == 401`
   - Assert conn is halted

3. **Bypass mode — empty header returns 401:**
   - Set `auth_mode: :bypass`
   - Build conn with `x-ebb-actor-id: ""` header
   - Assert 401

4. **External mode — missing auth_url returns 500:**
   - Set `auth_mode: :external`
   - Delete `auth_url` config
   - Call AuthPlug
   - Assert `conn.status == 500`

5. **External mode — successful auth (mock):**
   - Start a simple Plug-based mock server on a random port that returns `{"actor_id": "ext_actor"}`
   - Set `auth_url` to `http://localhost:<port>/auth`
   - Set `auth_mode: :external`
   - Call AuthPlug with an `authorization` header
   - Assert `conn.assigns.actor_id == "ext_actor"`
   - Stop the mock server

   For the mock server, use `Bandit.start_link` with a simple Plug that returns the expected JSON. Use `port: 0` to get a random available port, then extract the actual port from the Bandit server info:

   ```elixir
   defmodule MockAuthServer do
     use Plug.Router
     plug :match
     plug :dispatch

     post "/auth" do
       conn
       |> put_resp_content_type("application/json")
       |> send_resp(200, Jason.encode!(%{"actor_id" => "ext_actor"}))
     end
   end

   {:ok, server_pid} = Bandit.start_link(plug: MockAuthServer, port: 0, scheme: :http)

   # Extract the actual port from the Bandit server
   {:ok, {_ip, port}} = ThousandIsland.listener_info(server_pid)

   on_exit(fn -> GenServer.stop(server_pid) end)

   Application.put_env(:ebb_server, :auth_url, "http://localhost:#{port}/auth")
   ```

   **Note:** `ThousandIsland.listener_info/1` returns `{:ok, {address, port}}` for the actual bound address and port. Bandit uses ThousandIsland under the hood.

6. **External mode — auth server returns 401:**
   - Start mock server that returns 401
   - Assert AuthPlug returns 401

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/sync/auth_plug_test.exs
```

All 6 test cases pass. AuthPlug correctly handles bypass mode (for testing) and external mode (for production auth delegation).
