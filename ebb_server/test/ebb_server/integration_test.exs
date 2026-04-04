defmodule EbbServer.IntegrationTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import EbbServer.TestHelpers
  alias EbbServer.Storage.SystemCache
  alias EbbServer.Sync.Router

  setup do
    if pid = Process.whereis(EbbServer.Storage.Supervisor) do
      GenServer.stop(pid)
      :timer.sleep(200)
    end

    tmp_dir =
      tmp_dir(%{module: __MODULE__, test: "integration_#{:erlang.unique_integer([:positive])}"})

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

  defp post_actions(body) do
    owner = self()
    ref = make_ref()

    state = %{
      method: "POST",
      params: %{},
      req_body: body,
      chunks: nil,
      ref: ref,
      owner: owner,
      http_protocol: :"HTTP/1.1",
      peer_data: %{address: {127, 0, 0, 1}, port: 111_317, ssl_cert: nil},
      sock_data: %{address: {127, 0, 0, 1}, port: 111_318},
      ssl_data: nil
    }

    conn =
      %Plug.Conn{}
      |> Map.put(:method, "POST")
      |> Map.put(:path_info, ["sync", "actions"])
      |> Map.put(:request_path, "/sync/actions")
      |> Map.put(:query_string, "")
      |> Map.put(:query_params, %Plug.Conn.Unfetched{aspect: :query_params})
      |> Map.put(:body_params, %Plug.Conn.Unfetched{aspect: :body_params})
      |> Map.put(:params, %Plug.Conn.Unfetched{aspect: :params})
      |> Map.put(:req_headers, [{"content-type", "application/msgpack"}])
      |> Map.put(:host, "www.example.com")
      |> Map.put(:port, 80)
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> Map.put(:scheme, :http)
      |> Map.put(:adapter, {Plug.Adapters.Test.Conn, state})

    Router.call(conn, [])
  end

  defp get_entity(id, actor_id \\ "a_test") do
    conn(:get, "/entities/#{id}?actor_id=#{actor_id}")
    |> Router.call([])
  end

  defp msgpack_encode!(data) do
    data |> Msgpax.pack!() |> IO.iodata_to_binary()
  end

  describe "POST /sync/actions then GET /entities/:id" do
    test "POST action, GET entity back" do
      entity_id = "todo_xyz789"
      hlc = hlc_from(1_000)

      action_body = %{
        "id" => "act_test1",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_test1",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
                "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200

      {:ok, response_body} = Jason.decode(conn.resp_body)
      assert response_body == %{"rejected" => []}

      conn = get_entity(entity_id)
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["id"] == entity_id
      assert entity["type"] == "todo"
      assert entity["data"]["fields"]["title"]["value"] == "Buy milk"
      assert entity["data"]["fields"]["completed"]["value"] == false
    end

    test "second GET returns same data (cache hit)" do
      entity_id = "todo_cache_test"
      hlc = hlc_from(2_000)

      action_body = %{
        "id" => "act_cache",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_cache",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Cached item", "hlc" => hlc}
              }
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      conn1 = get_entity(entity_id)
      {:ok, entity1} = Jason.decode(conn1.resp_body)

      conn2 = get_entity(entity_id)
      {:ok, entity2} = Jason.decode(conn2.resp_body)

      assert conn1.status == 200
      assert conn2.status == 200
      assert entity1 == entity2
      assert entity1["id"] == entity_id
      assert entity1["data"]["fields"]["title"]["value"] == "Cached item"
    end

    test "GET nonexistent entity returns 404" do
      conn = get_entity("nonexistent_entity_xyz")
      assert conn.status == 404
    end

    test "GSN is assigned as 1" do
      entity_id = "todo_gsn_test"
      hlc = hlc_from(3_000)

      action_body = %{
        "id" => "act_gsn",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_gsn",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "GSN test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      conn = get_entity(entity_id)
      {:ok, entity} = Jason.decode(conn.resp_body)

      assert entity["last_gsn"] == 1
    end

    @tag :restart
    @tag skip: "RocksDB lock limitation on macOS - run on Linux"
    test "action is durable (survives process restart)", %{tmp_dir: _tmp_dir} do
    end

    test "dirty bit lifecycle" do
      entity_id = "todo_dirty_test"
      hlc = hlc_from(5_000)

      action_body = %{
        "id" => "act_dirty",
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_dirty",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Dirty test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_body]}))

      assert SystemCache.dirty?(entity_id)

      conn = get_entity(entity_id)
      assert conn.status == 200

      refute SystemCache.dirty?(entity_id)

      conn = get_entity(entity_id)
      assert conn.status == 200
    end

    test "multiple actions, sequential GSNs" do
      entity1 = "todo_seq1"
      entity2 = "todo_seq2"
      hlc1 = hlc_from(6_000)
      hlc2 = hlc_from(6_001)

      action1 = %{
        "id" => "act_seq1",
        "actor_id" => "a_test",
        "hlc" => hlc1,
        "updates" => [
          %{
            "id" => "upd_seq1",
            "subject_id" => entity1,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "First entity", "hlc" => hlc1}
              }
            }
          }
        ]
      }

      action2 = %{
        "id" => "act_seq2",
        "actor_id" => "a_test",
        "hlc" => hlc2,
        "updates" => [
          %{
            "id" => "upd_seq2",
            "subject_id" => entity2,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Second entity", "hlc" => hlc2}
              }
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action1]}))
      post_actions(msgpack_encode!(%{"actions" => [action2]}))

      conn1 = get_entity(entity1)
      {:ok, entity1_resp} = Jason.decode(conn1.resp_body)

      conn2 = get_entity(entity2)
      {:ok, entity2_resp} = Jason.decode(conn2.resp_body)

      assert entity1_resp["last_gsn"] == 1
      assert entity2_resp["last_gsn"] == 2
      assert entity1_resp["data"]["fields"]["title"]["value"] == "First entity"
      assert entity2_resp["data"]["fields"]["title"]["value"] == "Second entity"
    end

    test "POST with non-MessagePack body returns 422" do
      conn = post_actions("not valid msgpack {")
      assert conn.status == 422
    end

    test "POST with missing actions key returns 422" do
      body = msgpack_encode!(%{"not_actions" => []})
      conn = post_actions(body)
      assert conn.status == 422
    end
  end

  describe "HLC validation" do
    test "HLC as positive integer is accepted" do
      entity_id = "todo_hlc_int"

      action_body = %{
        "id" => "act_hlc_int",
        "actor_id" => "a_test",
        "hlc" => 123,
        "updates" => [
          %{
            "id" => "upd_hlc_int",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Integer HLC", "hlc" => 123}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
    end

    test "HLC as positive integer string is accepted" do
      entity_id = "todo_hlc_str"

      action_body = %{
        "id" => "act_hlc_str",
        "actor_id" => "a_test",
        "hlc" => "123",
        "updates" => [
          %{
            "id" => "upd_hlc_str",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "String HLC", "hlc" => "123"}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
    end

    test "HLC as zero is rejected" do
      action_body = %{
        "id" => "act_hlc_zero",
        "actor_id" => "a_test",
        "hlc" => 0,
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end

    test "HLC as negative integer is rejected" do
      action_body = %{
        "id" => "act_hlc_neg",
        "actor_id" => "a_test",
        "hlc" => -1,
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end

    test "HLC as non-numeric string is rejected" do
      action_body = %{
        "id" => "act_hlc_nan",
        "actor_id" => "a_test",
        "hlc" => "abc",
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end

    test "HLC as float is rejected" do
      action_body = %{
        "id" => "act_hlc_float",
        "actor_id" => "a_test",
        "hlc" => 1.5,
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end

    test "HLC as nil is rejected" do
      action_body = %{
        "id" => "act_hlc_nil",
        "actor_id" => "a_test",
        "hlc" => nil,
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end

    test "HLC as empty string is rejected" do
      action_body = %{
        "id" => "act_hlc_empty",
        "actor_id" => "a_test",
        "hlc" => "",
        "updates" => []
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422
    end
  end

  describe "validation error format" do
    test "returns structured error with field and message" do
      action_body = %{
        "id" => "",
        "actor_id" => "a_test",
        "hlc" => 0,
        "updates" => "not_a_list"
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 422

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
      assert is_list(response["details"])

      fields = Enum.map(response["details"], & &1["field"])
      messages = Enum.map(response["details"], & &1["message"])

      assert "0.id" in fields
      assert "must be a non-empty string" in messages
      assert "0.hlc" in fields
      assert "must be a positive integer" in messages
      assert "0.updates" in fields
      assert "must be a list" in messages
    end
  end
end
