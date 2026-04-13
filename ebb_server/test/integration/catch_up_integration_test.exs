defmodule EbbServer.CatchUpIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  import EbbServer.Integration.ActionHelpers

  alias EbbServer.Sync.Router

  describe "GET /sync/groups/:group_id" do
    test "returns actions for group member with correct headers", %{
      tmp_dir: _tmp_dir
    } do
      actor_id = "a_catchup_#{:erlang.unique_integer([:positive])}"
      group_id = "g_catchup_#{:erlang.unique_integer([:positive])}"

      bootstrap_result =
        bootstrap_group(actor_id, group_id, [
          "todo.read",
          "todo.write",
          "todo.create"
        ])

      assert bootstrap_result.status == 200

      entity_id = "todo_#{Nanoid.generate()}"

      write_result =
        write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
          "title" => %{
            "type" => "lww",
            "value" => "First Task",
            "hlc" => "2024-01-01T00:00:00.000Z"
          }
        })

      assert write_result.status == 200

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      assert_get_response(conn, actor_id, group_id)
    end

    test "offset query param filters actions by GSN", %{tmp_dir: _tmp_dir} do
      actor_id = "a_offset_#{:erlang.unique_integer([:positive])}"
      group_id = "g_offset_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..5 do
        result =
          write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-0#{i}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}?offset=3")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      {:ok, actions} = Jason.decode(conn.resp_body)

      assert length(actions) == 3
      assert Enum.all?(actions, fn a -> a["gsn"] > 3 end)
      assert Enum.all?(actions, fn a -> a["gsn"] <= 6 end)
    end

    test "non-member receives 403", %{tmp_dir: _tmp_dir} do
      group_id = "g_unknown_#{:erlang.unique_integer([:positive])}"
      non_member = "a_outsider_#{:erlang.unique_integer([:positive])}"

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", non_member)
        |> Router.call([])

      assert conn.status == 403
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "not_member"}
    end

    test "invalid offset returns 400", %{tmp_dir: _tmp_dir} do
      actor_id = "a_invalid_#{:erlang.unique_integer([:positive])}"
      group_id = "g_invalid_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write"
      ])

      conn =
        conn(:get, "/sync/groups/#{group_id}?offset=abc")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "invalid_offset"}
    end

    test "negative offset returns 400", %{tmp_dir: _tmp_dir} do
      actor_id = "a_neg_#{:erlang.unique_integer([:positive])}"
      group_id = "g_neg_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write"
      ])

      conn =
        conn(:get, "/sync/groups/#{group_id}?offset=-1")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
    end

    test "Stream-Up-To-Date header is true when at watermark", %{tmp_dir: _tmp_dir} do
      actor_id = "a_current_#{:erlang.unique_integer([:positive])}"
      group_id = "g_current_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      assert get_resp_header(conn, "stream-up-to-date") == ["true"]
      assert get_resp_header(conn, "stream-next-offset") == []
    end

    test "pagination: more than limit returns Stream-Next-Offset", %{
      tmp_dir: _tmp_dir
    } do
      actor_id = "a_page_#{:erlang.unique_integer([:positive])}"
      group_id = "g_page_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..250 do
        month = if i < 10, do: "0#{i}", else: Integer.to_string(i)

        result =
          write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
            "title" => %{
              "type" => "lww",
              "value" => "Task #{i}",
              "hlc" => "2024-01-#{month}T00:00:00.000Z"
            }
          })

        assert result.status == 200
      end

      Process.sleep(200)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      {:ok, actions} = Jason.decode(conn.resp_body)
      assert length(actions) == 200
      refute get_resp_header(conn, "stream-up-to-date") == ["true"]
      [next_offset_header] = get_resp_header(conn, "stream-next-offset")
      next_offset = String.to_integer(next_offset_header)

      conn2 =
        conn(:get, "/sync/groups/#{group_id}?offset=#{next_offset}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn2.status == 200
      {:ok, second_page} = Jason.decode(conn2.resp_body)
      assert length(second_page) == 51
      assert get_resp_header(conn2, "stream-up-to-date") == ["true"]
    end

    test "actions are sorted by GSN ascending", %{tmp_dir: _tmp_dir} do
      actor_id = "a_sort_#{:erlang.unique_integer([:positive])}"
      group_id = "g_sort_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      entity_id = "todo_#{Nanoid.generate()}"

      for i <- 1..10 do
        write_entity_in_group(actor_id, entity_id, "todo", group_id, %{
          "title" => %{
            "type" => "lww",
            "value" => "Task #{i}",
            "hlc" => "2024-01-0#{i}T00:00:00.000Z"
          }
        })
      end

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      {:ok, actions} = Jason.decode(conn.resp_body)

      gsns = Enum.map(actions, fn a -> a["gsn"] end)
      assert gsns == Enum.sort(gsns)
    end

    test "new group member sees bootstrap actions", %{
      tmp_dir: _tmp_dir
    } do
      actor_id = "a_empty_#{:erlang.unique_integer([:positive])}"
      group_id = "g_empty_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write"
      ])

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      {:ok, actions} = Jason.decode(conn.resp_body)
      assert length(actions) == 1
      assert get_resp_header(conn, "stream-up-to-date") == ["true"]
      assert get_resp_header(conn, "stream-next-offset") == []
    end

    test "returns correct action structure with id, actor_id, hlc, gsn, updates",
         %{tmp_dir: _tmp_dir} do
      actor_id = "a_struct_#{:erlang.unique_integer([:positive])}"
      group_id = "g_struct_#{:erlang.unique_integer([:positive])}"

      bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      Process.sleep(100)

      conn =
        conn(:get, "/sync/groups/#{group_id}")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 200
      {:ok, actions} = Jason.decode(conn.resp_body)

      action = hd(actions)
      assert action["id"] |> is_binary()
      assert action["actor_id"] == actor_id
      assert is_integer(action["hlc"])
      assert action["gsn"] |> is_integer()
      assert action["updates"] |> is_list()
    end
  end

  defp assert_get_response(conn, _actor_id, _group_id) do
    assert conn.status == 200
    {:ok, response} = Jason.decode(conn.resp_body)
    assert is_list(response)

    headers = conn.resp_headers
    header_names = Enum.map(headers, fn {k, _v} -> k end)
    assert "stream-up-to-date" in header_names || "stream-next-offset" in header_names
  end
end
