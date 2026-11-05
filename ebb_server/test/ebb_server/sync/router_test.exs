defmodule EbbServer.Sync.RouterTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Storage.{
    CacheTables,
    DirtyTracker,
    EntityGroupCache,
    GroupCache,
    RocksDB,
    WatermarkTracker
  }

  alias EbbServer.Sync.PresenceRateLimit.Buckets
  alias EbbServer.Sync.Router
  alias Exqlite.Sqlite3

  defp post_presence(body, actor_id) do
    post_presence_raw(Jason.encode!(body), actor_id)
  end

  defp post_presence_raw(body, actor_id) do
    conn(:post, "/sync/presence", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  # A valid presence body padded to exactly `size` bytes. The pad lives inside
  # `data`, so the shape the route parses stays the same.
  defp presence_body_of_size(size, entity_id) do
    base = Jason.encode!(%{"entity_id" => entity_id, "data" => %{"pad" => ""}})
    padding = size - byte_size(base)

    Jason.encode!(%{
      "entity_id" => entity_id,
      "data" => %{"pad" => String.duplicate("x", padding)}
    })
  end

  defp put_config(key, value) do
    previous = Application.get_env(:ebb_server, key)
    Application.put_env(:ebb_server, key, value)

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, key)
        previous -> Application.put_env(:ebb_server, key, previous)
      end
    end)
  end

  defp setup_entity_group(entity_id, group_id) do
    eg_id = "eg_" <> Nanoid.generate()

    :ok =
      EntityGroupCache.put_entity_group(
        %{id: eg_id, entity_id: entity_id, group_id: group_id},
        entity_groups: CacheTables.entity_groups(),
        entity_groups_by_id: CacheTables.entity_groups_by_id(),
        entity_groups_by_group: CacheTables.entity_groups_by_group()
      )
  end

  defp setup_group_membership(actor_id, group_id, permissions \\ ["read", "write"]) do
    gm_id = "gm_" <> Nanoid.generate()

    :ok =
      GroupCache.put_group_member(%{
        id: gm_id,
        actor_id: actor_id,
        group_id: group_id,
        permissions: permissions
      })
  end

  defp get_entity(entity_id, actor_id) do
    conn(:get, "/entities/#{entity_id}")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp unique(suffix) do
    "#{suffix}_#{:erlang.unique_integer([:positive])}"
  end

  # An entity_actions row naming a GSN whose action is absent makes
  # materialization raise; the caller sees the mapped failure rather than a
  # decoded entity.
  defp corrupt_entity_action_log(entity_id, gsn) do
    :ok =
      RocksDB.write_batch([
        {:put, RocksDB.cf_entity_actions(), RocksDB.encode_entity_flush_key(entity_id, gsn),
         RocksDB.encode_gsn_list([gsn])}
      ])

    :ok = DirtyTracker.mark_dirty_batch([{entity_id, "todo"}])
  end

  # Renaming the table out from under the shared SQLite connection is the
  # cheapest read-side failure a test can inject: `prepare` then fails, which is
  # the generic error the route maps to `503 query_failed`.
  defp break_entities_table(tmp_dir) do
    {:ok, db} = Sqlite3.open(Path.join(tmp_dir, "ebb.db"))
    :ok = Sqlite3.execute(db, "ALTER TABLE entities RENAME TO entities_disabled")
    Sqlite3.close(db)
  end

  describe "POST /sync/presence" do
    test "204 on success - valid presence broadcast for entity in subscribed group" do
      entity_id = "todo_xyz"
      group_id = "g_test"
      actor_id = "a_member"

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      conn =
        post_presence(
          %{
            "entity_id" => entity_id,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          actor_id
        )

      assert conn.status == 204
    end

    test "404 for unknown entity - entity belongs to no group" do
      conn =
        post_presence(
          %{
            "entity_id" => "unknown_entity",
            "data" => %{"cursor" => %{"line" => 1, "col" => 1}}
          },
          "a_member"
        )

      assert conn.status == 404
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "entity_not_found"
    end

    test "404 for non-member - actor not in entity's group" do
      entity_id = "todo_xyz"
      group_id = "g_private"
      actor_id = "a_outsider"

      setup_group_membership("a_member", group_id)
      setup_entity_group(entity_id, group_id)

      conn =
        post_presence(
          %{
            "entity_id" => entity_id,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          actor_id
        )

      assert conn.status == 404
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "entity_not_found"
    end

    test "a foreign entity and a missing entity are indistinguishable" do
      foreign_id = "todo_foreign"
      group_id = "g_someone_else"
      actor_id = "a_outsider"
      data = %{"data" => %{"cursor" => %{"line" => 5, "col" => 12}}}

      setup_group_membership("a_member", group_id)
      setup_entity_group(foreign_id, group_id)

      foreign = post_presence(Map.put(data, "entity_id", foreign_id), actor_id)
      missing = post_presence(Map.put(data, "entity_id", "todo_missing"), actor_id)

      assert {foreign.status, foreign.resp_body} == {missing.status, missing.resp_body}
    end

    test "422 for missing entity_id" do
      conn =
        post_presence(
          %{
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
    end

    test "422 for empty entity_id" do
      conn =
        post_presence(
          %{
            "entity_id" => "",
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
    end

    test "422 for invalid JSON" do
      conn =
        conn(:post, "/sync/presence", "not json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", "a_member")
        |> Router.call([])

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "invalid_json"
    end

    test "422 when entity_id is not a string" do
      conn =
        post_presence(
          %{
            "entity_id" => 123,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
    end

    test "413 for a body over the size cap, not 500" do
      # Comfortably over any sane default cap, so the test does not pin the
      # default itself.
      body = presence_body_of_size(64 * 1024, unique("todo"))

      conn = post_presence_raw(body, unique("a_padded"))

      assert conn.status == 413
      assert %{"error" => "payload_too_large"} = Jason.decode!(conn.resp_body)
    end

    test "accepts a body exactly at the client's 8 KiB payload cap" do
      entity_id = unique("todo")
      group_id = unique("g")
      actor_id = unique("a")

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      body = presence_body_of_size(8 * 1024, entity_id)
      assert byte_size(body) == 8_192

      assert post_presence_raw(body, actor_id).status == 204
    end

    test "the size cap is configurable" do
      put_config(:presence_max_body_bytes, 1_024)

      entity_id = unique("todo")
      group_id = unique("g")
      actor_id = unique("a")

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      assert post_presence_raw(presence_body_of_size(1_024, entity_id), actor_id).status == 204

      over = post_presence_raw(presence_body_of_size(1_025, entity_id), actor_id)
      assert over.status == 413
      assert %{"error" => "payload_too_large"} = Jason.decode!(over.resp_body)
    end

    test "an invalid size cap raises instead of serving an unbounded body" do
      put_config(:presence_max_body_bytes, 0)

      # Raised inside a route, so `Plug.Router` wraps it.
      error =
        assert_raise Plug.Conn.WrapperError, fn ->
          post_presence_raw("{}", unique("a"))
        end

      assert %ArgumentError{message: message} = error.reason
      assert message =~ "presence_max_body_bytes"
    end
  end

  describe "POST /sync/presence rate limit" do
    setup do
      put_config(:presence_rate_limit, {1, 1})
    end

    test "an over-limit actor gets 429 with retry-after; a second actor is unaffected" do
      entity_id = unique("todo")
      group_id = unique("g")
      actor_id = unique("a")
      other_actor_id = unique("a")

      setup_group_membership(actor_id, group_id)
      setup_group_membership(other_actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      body = %{"entity_id" => entity_id, "data" => %{"cursor" => %{"line" => 1, "col" => 1}}}

      assert post_presence(body, actor_id).status == 204

      limited = post_presence(body, actor_id)
      assert limited.status == 429
      assert %{"error" => "rate_limited"} = Jason.decode!(limited.resp_body)
      assert [retry_after] = get_resp_header(limited, "retry-after")
      assert String.to_integer(retry_after) >= 1

      # The limit is per actor, not per route or per node.
      assert post_presence(body, other_actor_id).status == 204
    end

    test "two connections from the same actor share one bucket" do
      entity_id = unique("todo")
      group_id = unique("g")
      actor_id = unique("a")

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      body = %{"entity_id" => entity_id, "data" => %{"cursor" => %{"line" => 1, "col" => 1}}}

      # Each call is its own conn, as two tabs would be.
      assert post_presence(body, actor_id).status == 204
      assert post_presence(body, actor_id).status == 429
      assert [_one_bucket] = :ets.lookup(Buckets.table(), actor_id)
    end

    test "does not limit other routes" do
      actor_id = unique("a")

      assert post_presence(%{"entity_id" => unique("todo"), "data" => %{}}, actor_id).status ==
               404

      handshake =
        conn(:post, "/sync/handshake", Jason.encode!(%{"cursors" => %{}, "schema_version" => 1}))
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert handshake.status == 200
    end

    test "an invalid rate configuration raises instead of disabling the limit" do
      put_config(:presence_rate_limit, {0, 1})

      assert_raise ArgumentError, ~r/presence_rate_limit/, fn ->
        post_presence_raw("{}", unique("a"))
      end
    end
  end

  describe "GET /entities/:id" do
    test "401 when the actor header is absent" do
      conn = conn(:get, "/entities/todo_anything") |> Router.call([])

      assert conn.status == 401
      assert conn.halted
      assert %{"error" => "unauthorized"} = Jason.decode!(conn.resp_body)
    end

    test "the route itself answers 401 when no actor was assigned upstream" do
      # AuthPlug rejects an absent header before the route runs, so the route's
      # own guard is only reachable when it is dispatched without the plug
      # pipeline. It is defence in depth, and it must not fall through to a read.
      conn =
        conn(:get, "/entities/todo_anything")
        |> Router.match([])
        |> Router.dispatch([])

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"error" => "unauthorized"}
    end

    test "503 materialization_failed rather than 404 when the action log is unreadable" do
      entity_id = unique("todo_unreadable")
      group_id = unique("g_unreadable")
      actor_id = unique("a_unreadable")

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)
      corrupt_entity_action_log(entity_id, 1)

      conn = get_entity(entity_id, actor_id)

      # A 404 here would tell a member that a readable entity does not exist.
      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "materialization_failed"}
    end

    test "404 not_found for an id the actor may read but that has no state" do
      entity_id = unique("todo_absent")
      group_id = unique("g_absent")
      actor_id = unique("a_absent")

      setup_group_membership(actor_id, group_id)
      setup_entity_group(entity_id, group_id)

      conn = get_entity(entity_id, actor_id)

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"error" => "not_found"}
    end
  end

  describe "POST /entities/query" do
    test "503 query_failed when the entity cache cannot answer", %{tmp_dir: tmp_dir} do
      break_entities_table(tmp_dir)

      conn =
        conn(:post, "/entities/query", Jason.encode!(%{"type" => "todo"}))
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", "a_member")
        |> Router.call([])

      assert conn.status == 503
      assert %{"error" => "query_failed", "details" => details} = Jason.decode!(conn.resp_body)
      assert is_binary(details) and details != ""
    end
  end

  describe "POST /sync/actions" do
    test "422 invalid_msgpack for an empty body" do
      conn =
        conn(:post, "/sync/actions", "")
        |> put_req_header("content-type", "application/msgpack")
        |> put_req_header("x-ebb-actor-id", "a_member")
        |> Router.call([])

      assert conn.status == 422
      assert Jason.decode!(conn.resp_body) == %{"error" => "invalid_msgpack"}
    end
  end

  describe "unknown routes" do
    test "404 with no body for a path no route matches" do
      conn =
        conn(:get, "/sync/no_such_route")
        |> put_req_header("x-ebb-actor-id", "a_member")
        |> Router.call([])

      assert conn.status == 404
      assert conn.resp_body == ""
    end
  end

  describe "GET /healthz" do
    test "200 with no auth headers at all" do
      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"status" => "ok"}
    end

    test "503 with no internals when the storage tree is not answering" do
      sqlite = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite)

      :ok = :sys.suspend(sqlite)
      on_exit(fn -> if Process.alive?(sqlite), do: :sys.resume(sqlite) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "503 with no internals when the probe reports a degraded state" do
      gsn_ref = :persistent_term.get({WatermarkTracker, :gsn_ref})
      invalid = :atomics.new(1, signed: true)
      :atomics.put(invalid, 1, -1)

      :persistent_term.put({WatermarkTracker, :gsn_ref}, invalid)
      on_exit(fn -> :persistent_term.put({WatermarkTracker, :gsn_ref}, gsn_ref) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "503 with no internals when a probe raises" do
      gsn_ref = :persistent_term.get({WatermarkTracker, :gsn_ref})

      :persistent_term.put({WatermarkTracker, :gsn_ref}, :not_an_atomics)
      on_exit(fn -> :persistent_term.put({WatermarkTracker, :gsn_ref}, gsn_ref) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "requires no actor header while /sync/handshake still does" do
      health = conn(:get, "/healthz") |> Router.call([])
      assert health.status == 200

      handshake =
        conn(:post, "/sync/handshake", Jason.encode!(%{}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert handshake.status == 401
    end
  end
end
