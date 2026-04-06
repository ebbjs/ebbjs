defmodule EbbServer.IntegrationTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import Plug.Conn
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

    case EbbServer.Storage.Supervisor.start_link(data_dir: tmp_dir) do
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

  defp post_actions(body, actor_id \\ "a_test") do
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
      |> Map.put(:req_headers, [
        {"content-type", "application/msgpack"},
        {"x-ebb-actor-id", actor_id}
      ])
      |> Map.put(:host, "www.example.com")
      |> Map.put(:port, 80)
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> Map.put(:scheme, :http)
      |> Map.put(:adapter, {Plug.Adapters.Test.Conn, state})

    Router.call(conn, [])
  end

  defp get_entity(id, actor_id \\ "a_test") do
    conn(:get, "/entities/#{id}")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp msgpack_encode!(data) do
    data |> Msgpax.pack!() |> IO.iodata_to_binary()
  end

  defp bootstrap_group(actor_id, group_id, permissions) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()
    rel_id = "rel_" <> Nanoid.generate()

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
          "data" => %{
            "fields" => %{"name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}}
          }
        },
        %{
          "id" => gm_id,
          "subject_id" => gm_id,
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{
            "actor_id" => actor_id,
            "group_id" => group_id,
            "permissions" => permissions
          }
        },
        %{
          "id" => rel_id,
          "subject_id" => rel_id,
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{
            "source_id" => "todo_bootstrap",
            "target_id" => group_id,
            "type" => "todo",
            "field" => "group"
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    :ok
  end

  describe "POST /sync/actions then GET /entities/:id" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.update", "todo.read"])
      :ok
    end

    test "POST action, GET entity back" do
      entity_id = "todo_xyz789"
      hlc = generate_hlc()

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
      hlc = generate_hlc()

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
      hlc = generate_hlc()

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

      assert entity["last_gsn"] == 2
    end

    @tag :restart
    @tag skip: "RocksDB lock limitation on macOS - run on Linux"
    test "action is durable (survives process restart)", %{tmp_dir: _tmp_dir} do
    end

    test "dirty bit lifecycle" do
      entity_id = "todo_dirty_test"
      hlc = generate_hlc()

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
      hlc1 = generate_hlc()
      hlc2 = generate_hlc()

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

      assert entity1_resp["last_gsn"] == 2
      assert entity2_resp["last_gsn"] == 3
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
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create", "todo.update"])
      :ok
    end

    test "HLC as positive integer is accepted" do
      entity_id = "todo_hlc_int"

      action_body = %{
        "id" => "act_hlc_int",
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_hlc_int",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Integer HLC", "hlc" => generate_hlc()}
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
        "hlc" => "#{generate_hlc()}",
        "updates" => [
          %{
            "id" => "upd_hlc_str",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "String HLC", "hlc" => generate_hlc()}
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
        "updates" => [
          %{
            "id" => "upd_hlc_zero",
            "subject_id" => "todo_zero",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => 0}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end

    test "HLC as negative integer is rejected" do
      action_body = %{
        "id" => "act_hlc_neg",
        "actor_id" => "a_test",
        "hlc" => -1,
        "updates" => [
          %{
            "id" => "upd_hlc_neg",
            "subject_id" => "todo_neg",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => -1}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end

    test "HLC as non-numeric string is rejected" do
      action_body = %{
        "id" => "act_hlc_nan",
        "actor_id" => "a_test",
        "hlc" => "abc",
        "updates" => [
          %{
            "id" => "upd_hlc_nan",
            "subject_id" => "todo_nan",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => "abc"}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end

    test "HLC as float is rejected" do
      action_body = %{
        "id" => "act_hlc_float",
        "actor_id" => "a_test",
        "hlc" => 1.5,
        "updates" => [
          %{
            "id" => "upd_hlc_float",
            "subject_id" => "todo_float",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => 1.5}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end

    test "HLC as nil is rejected" do
      action_body = %{
        "id" => "act_hlc_nil",
        "actor_id" => "a_test",
        "hlc" => nil,
        "updates" => [
          %{
            "id" => "upd_hlc_nil",
            "subject_id" => "todo_nil",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => nil}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end

    test "HLC as empty string is rejected" do
      action_body = %{
        "id" => "act_hlc_empty",
        "actor_id" => "a_test",
        "hlc" => "",
        "updates" => [
          %{
            "id" => "upd_hlc_empty",
            "subject_id" => "todo_empty",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => ""}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []
    end
  end

  describe "rejection format" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.create"])
      :ok
    end

    test "returns rejection with id and reason" do
      action_body = %{
        "id" => "act_rej",
        "actor_id" => "a_test",
        "hlc" => 0,
        "updates" => [
          %{
            "id" => "upd_rej",
            "subject_id" => "todo_rej",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => 0}}
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert is_list(response["rejected"])
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert %{"id" => "act_rej", "reason" => _} = rejection
    end
  end
end
