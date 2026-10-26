defmodule EbbServer.Sync.EntityQueryTest do
  @moduledoc """
  Behavioral tests for entity query endpoint (POST /entities/query).

  Queries return entities of a given type that the actor has permission
  to read, filtered and sorted by various criteria.

  ## Key Behaviors Tested

  - Query validation: requires type parameter
  - Permission scoping: only returns entities in readable groups
  - Filter support: supports filtering by field values
  - Auth requirements: requires valid actor_id
  - Empty results: returns empty array when no matches

  ## Architecture Context

  Query first materializes dirty entities, then delegates to SQLite
  with permission-filtered JOINs.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import Plug.Test
  import Plug.Conn
  import EbbServer.TestHelpers

  alias EbbServer.Storage.Writer
  alias EbbServer.Sync.Router

  defp post_query(body, actor_id \\ "a_test") do
    conn(:post, "/entities/query", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp bootstrap_group(actor_id, group_id, permissions) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    group_action = %{
      id: "act_group_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_group_" <> Nanoid.generate(),
          subject_id: group_id,
          subject_type: "group",
          method: :put,
          data: %{
            "fields" => %{"name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}}
          }
        }
      ]
    }

    {:ok, {_gsn1, _gsn1}, []} = Writer.write_actions([group_action])

    gm_action = %{
      id: "act_gm_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_gm_" <> Nanoid.generate(),
          subject_id: gm_id,
          subject_type: "groupMember",
          method: :put,
          data: %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => permissions, "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {_gsn2, _gsn2}, []} = Writer.write_actions([gm_action])

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_eg_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_eg_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
      ]
    }

    {:ok, {_gsn3, _gsn3}, []} = Writer.write_actions([eg_action])
    :ok
  end

  defp write_todo(todo_id, group_id, actor_id, opts \\ []) do
    title = Keyword.get(opts, :title, "Test todo")
    completed = Keyword.get(opts, :completed, false)
    hlc = generate_hlc()
    eg_id = "eg_" <> Nanoid.generate()

    todo_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: todo_id,
          subject_type: "todo",
          method: :put,
          data: %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => title, "hlc" => hlc},
              "completed" => %{"type" => "lww", "value" => completed, "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {_gsn1, _gsn1}, []} = Writer.write_actions([todo_action])

    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_eg_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_eg_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => todo_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
      ]
    }

    {:ok, {_gsn2, _gsn2}, []} = Writer.write_actions([eg_action])
    :ok
  end

  describe "POST /entities/query" do
    test "query without type returns 422" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn = post_query(%{})

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
    end

    test "query without auth returns 401" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/entities/query", Jason.encode!(%{"type" => "todo"}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert conn.status == 401
    end

    test "query with invalid JSON returns 422" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/entities/query", "not json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", "a_test")
        |> Router.call([])

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "invalid_json"
    end

    test "query returns empty array when no entities exist" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn = post_query(%{"type" => "nonexistent"})

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == []
    end

    test "query returns entities of the correct type" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_1", "g_query_1", ["todo.*"])
      write_todo("todo_query_1", "g_query_1", "a_1")
      write_todo("todo_query_2", "g_query_1", "a_1")

      conn = post_query(%{"type" => "todo"}, "a_1")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert is_list(response)
      assert length(response) == 2
      assert Enum.all?(response, fn entity -> entity["type"] == "todo" end)
    end

    test "query respects permissions" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_1", "g_perm_1", ["todo.*"])
      write_todo("todo_perm_1", "g_perm_1", "a_1")

      conn_a1 = post_query(%{"type" => "todo"}, "a_1")
      assert conn_a1.status == 200
      {:ok, response_a1} = Jason.decode(conn_a1.resp_body)
      assert length(response_a1) == 1

      conn_a2 = post_query(%{"type" => "todo"}, "a_2")
      assert conn_a2.status == 200
      {:ok, response_a2} = Jason.decode(conn_a2.resp_body)
      assert response_a2 == []
    end

    test "a membership with an empty permission list reads nothing" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_revoked", "g_revoked", [])
      write_todo("todo_revoked", "g_revoked", "a_revoked")

      conn = post_query(%{"type" => "todo"}, "a_revoked")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == []
    end

    test "a membership with permissions still reads the row" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_kept", "g_kept", ["todo.read"])
      write_todo("todo_kept", "g_kept", "a_kept")

      conn = post_query(%{"type" => "todo"}, "a_kept")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert Enum.map(response, & &1["id"]) == ["todo_kept"]
    end

    test "query with filter" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_filter", "g_filter_1", ["todo.*"])
      write_todo("todo_filter_1", "g_filter_1", "a_filter", completed: true, title: "Done task")
      write_todo("todo_filter_2", "g_filter_1", "a_filter", completed: false, title: "Not done")

      conn = post_query(%{"type" => "todo", "filter" => %{"completed" => true}}, "a_filter")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert length(response) == 1
      assert hd(response)["data"]["fields"]["completed"]["value"] == true
    end
  end

  describe "POST /entities/query filter validation" do
    test "rejects every malformed shape and leaves the SQLite process alone" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      sqlite_pid = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite_pid)

      for filter <- malformed_query_filters() do
        conn = post_query(%{"type" => "todo", "filter" => filter})

        assert conn.status == 422, "expected #{inspect(filter)} to be rejected"
        assert Jason.decode!(conn.resp_body) == %{"error" => "invalid_filter"}
        assert Process.whereis(EbbServer.Storage.SQLite) == sqlite_pid
      end
    end

    test "four repeated malformed filters do not restart the storage tree" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      sqlite_pid = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite_pid)

      for _ <- 1..4 do
        conn = post_query(%{"type" => "todo", "filter" => %{"a b" => "x"}})
        assert conn.status == 422
      end

      assert Process.whereis(EbbServer.Storage.SQLite) == sqlite_pid
    end

    test "valid scalar filters and the empty filter keep their rows" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_scalar", "g_scalar", ["todo.*"])
      write_todo("todo_done", "g_scalar", "a_scalar", completed: true, title: "Done task")
      write_todo("todo_open", "g_scalar", "a_scalar", completed: false, title: "Not done")

      cases = [
        {%{"completed" => true}, ["todo_done"]},
        {%{"completed" => false}, ["todo_open"]},
        {%{"completed" => 1}, ["todo_done"]},
        {%{"title" => "Done task"}, ["todo_done"]},
        {%{"title" => nil}, []},
        {%{}, ["todo_done", "todo_open"]}
      ]

      for {filter, expected_ids} <- cases do
        conn = post_query(%{"type" => "todo", "filter" => filter}, "a_scalar")

        assert conn.status == 200, "expected #{inspect(filter)} to be accepted"

        ids =
          conn.resp_body
          |> Jason.decode!()
          |> Enum.map(& &1["id"])
          |> Enum.sort()

        assert ids == Enum.sort(expected_ids)
      end
    end
  end

  describe "POST /entities/query pagination" do
    test "rejects a limit outside 1..1000, whatever its JSON type" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      for limit <- [0, -1, 1.5, "10", 1001] do
        conn = post_query(%{"type" => "todo", "limit" => limit})

        assert conn.status == 422, "expected #{inspect(limit)} to be rejected"
        assert Jason.decode!(conn.resp_body) == %{"error" => "invalid_limit"}
      end
    end

    test "rejects an offset SQLite cannot bind without restarting storage" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      sqlite_pid = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite_pid)

      for offset <- [-1, 9_223_372_036_854_775_808] do
        conn = post_query(%{"type" => "todo", "offset" => offset})

        assert conn.status == 422
        assert Jason.decode!(conn.resp_body) == %{"error" => "invalid_offset"}
        assert Process.whereis(EbbServer.Storage.SQLite) == sqlite_pid
      end
    end

    test "rejects a boolean window instead of treating it as omitted" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      assert %{"error" => "invalid_limit"} =
               post_query(%{"type" => "todo", "limit" => false})
               |> Map.get(:resp_body)
               |> Jason.decode!()

      assert %{"error" => "invalid_offset"} =
               post_query(%{"type" => "todo", "offset" => false})
               |> Map.get(:resp_body)
               |> Jason.decode!()
    end

    test "accepts the maximum limit" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      bootstrap_group("a_limit_max", "g_limit_max", ["todo.*"])
      write_todo("todo_limit_max", "g_limit_max", "a_limit_max")

      conn = post_query(%{"type" => "todo", "limit" => 1000}, "a_limit_max")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert Enum.map(response, & &1["id"]) == ["todo_limit_max"]
    end
  end
end
