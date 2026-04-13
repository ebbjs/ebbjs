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
    rel_id = "rel_" <> Nanoid.generate()

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

    rel_action = %{
      id: "act_rel_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_rel_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "source_id" => group_id,
            "target_id" => group_id,
            "type" => group_id,
            "field" => "group"
          }
        }
      ]
    }

    {:ok, {_gsn3, _gsn3}, []} = Writer.write_actions([rel_action])
    :ok
  end

  defp write_todo(todo_id, group_id, actor_id, opts \\ []) do
    title = Keyword.get(opts, :title, "Test todo")
    completed = Keyword.get(opts, :completed, false)
    hlc = generate_hlc()
    rel_id = "rel_" <> Nanoid.generate()

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

    rel_action = %{
      id: "act_rel_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_rel_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "source_id" => todo_id,
            "target_id" => group_id,
            "type" => "todo",
            "field" => "group"
          }
        }
      ]
    }

    {:ok, {_gsn2, _gsn2}, []} = Writer.write_actions([rel_action])
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
end
