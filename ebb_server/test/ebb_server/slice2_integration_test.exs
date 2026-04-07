defmodule EbbServer.Slice2IntegrationTest do
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
      tmp_dir(%{module: __MODULE__, test: "slice2_#{:erlang.unique_integer([:positive])}"})

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

  defp post_query(body, actor_id \\ "a_test") do
    conn(:post, "/entities/query", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp post_handshake(body, actor_id \\ "a_test") do
    conn(:post, "/sync/handshake", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
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
            "fields" => %{
              "name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}
            }
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

  defp write_entity_in_group(actor_id, entity_id, entity_type, group_id, fields) do
    hlc = generate_hlc()
    rel_id = "rel_" <> Nanoid.generate()

    action = %{
      "id" => "act_write_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_entity_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "subject_type" => entity_type,
          "method" => "put",
          "data" => %{"fields" => fields}
        },
        %{
          "id" => rel_id,
          "subject_id" => rel_id,
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{
            "source_id" => entity_id,
            "target_id" => group_id,
            "type" => entity_type,
            "field" => "group"
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  describe "Flow A: Group Bootstrap" do
    test "group bootstrap accepted without prior permissions" do
      conn = bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      assert SystemCache.get_actor_groups("actor_1")
             |> Enum.any?(fn gm -> gm.group_id == "group_1" end)

      assert SystemCache.get_entity_group("group_1") == "group_1"
    end

    test "handshake returns bootstrapped group" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      conn = post_handshake(%{"cursors" => %{}, "schema_version" => 1}, "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["groups"] |> hd() |> Map.get("id") == "group_1"
    end
  end

  describe "Flow B: Authorized Write" do
    test "authorized write to actor's group accepted" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])

      entity_id = "todo_auth_1"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_auth_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_auth_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Authorized Todo", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Authorized Todo"
    end

    test "intra-action resolution: new entity + relationship in same action" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_intra_1"
      hlc = generate_hlc()
      rel_id = "rel_intra_" <> Nanoid.generate()

      action = %{
        "id" => "act_intra_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_intra_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Intra Action", "hlc" => hlc}
              }
            }
          },
          %{
            "id" => rel_id,
            "subject_id" => rel_id,
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => entity_id,
              "target_id" => "group_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Intra Action"
    end
  end

  describe "Flow C: Unauthorized Write Rejected" do
    test "write to group actor does NOT belong to is rejected" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_unauth_1"
      hlc = generate_hlc()

      fields = %{
        "title" => %{"type" => "lww", "value" => "Unauthorized Todo", "hlc" => hlc}
      }

      conn = write_entity_in_group("actor_2", entity_id, "todo", "group_1", fields)
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "not_authorized"
    end

    test "actor identity mismatch is rejected" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_mismatch_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_mismatch_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_mismatch_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Mismatch Test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_2")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "actor_mismatch"
    end
  end

  describe "Flow D: Permission-Scoped Query" do
    test "permission-scoped query returns only visible entities" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_2", "group_2", ["todo.create", "todo.read"])

      hlc_1 = generate_hlc()
      hlc_2 = generate_hlc()

      action_1 = %{
        "id" => "act_q1_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc_1,
        "updates" => [
          %{
            "id" => "upd_q1_" <> Nanoid.generate(),
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Todo 1", "hlc" => hlc_1}
              }
            }
          },
          %{
            "id" => "rel_q1_" <> Nanoid.generate(),
            "subject_id" => "rel_q1_" <> Nanoid.generate(),
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_1",
              "target_id" => "group_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      action_2 = %{
        "id" => "act_q2_" <> Nanoid.generate(),
        "actor_id" => "actor_2",
        "hlc" => hlc_2,
        "updates" => [
          %{
            "id" => "upd_q2_" <> Nanoid.generate(),
            "subject_id" => "todo_2",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Todo 2", "hlc" => hlc_2}
              }
            }
          },
          %{
            "id" => "rel_q2_" <> Nanoid.generate(),
            "subject_id" => "rel_q2_" <> Nanoid.generate(),
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_2",
              "target_id" => "group_2",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      post_actions(msgpack_encode!(%{"actions" => [action_1]}), "actor_1")
      post_actions(msgpack_encode!(%{"actions" => [action_2]}), "actor_2")

      conn = post_query(%{"type" => "todo"}, "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      entity_ids = Enum.map(response, & &1["id"])
      assert "todo_1" in entity_ids
      refute "todo_2" in entity_ids

      conn = post_query(%{"type" => "todo"}, "actor_2")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      entity_ids = Enum.map(response, & &1["id"])
      assert "todo_2" in entity_ids
      refute "todo_1" in entity_ids
    end
  end

  describe "Validation Checks" do
    test "HLC future drift rejected (>120s)" do
      hlc_future = hlc_from(System.os_time(:millisecond) + 200_000)

      action = %{
        "id" => "act_future_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc_future,
        "updates" => [
          %{
            "id" => "upd_future_" <> Nanoid.generate(),
            "subject_id" => "todo_future",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Future Test", "hlc" => hlc_future}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "hlc_future_drift"
    end

    test "HLC staleness rejected (>24h)" do
      hlc_stale = hlc_from(System.os_time(:millisecond) - 100_000_000)

      action = %{
        "id" => "act_stale_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc_stale,
        "updates" => [
          %{
            "id" => "upd_stale_" <> Nanoid.generate(),
            "subject_id" => "todo_stale",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Stale Test", "hlc" => hlc_stale}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "hlc_stale"
    end

    test "structure validation rejects missing action id" do
      action = %{
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_no_id_" <> Nanoid.generate(),
            "subject_id" => "todo_no_id",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "No ID Test", "hlc" => generate_hlc()}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "invalid_structure"
    end

    test "structure validation rejects invalid method" do
      action = %{
        "id" => "act_invalid_method_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_inv_method_" <> Nanoid.generate(),
            "subject_id" => "todo_inv_method",
            "subject_type" => "todo",
            "method" => "upsert",
            "data" => %{
              "fields" => %{
                "title" => %{
                  "type" => "lww",
                  "value" => "Invalid Method",
                  "hlc" => generate_hlc()
                }
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "invalid_structure"
    end
  end

  describe "Auth Integration" do
    test "handshake without auth header returns 401" do
      conn =
        conn(:post, "/sync/handshake", Jason.encode!(%{"cursors" => %{}, "schema_version" => 1}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert conn.status == 401
    end

    test "actions without auth header returns 401" do
      action = %{
        "id" => "act_no_auth_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => []
      }

      owner = self()
      ref = make_ref()

      state = %{
        method: "POST",
        params: %{},
        req_body: msgpack_encode!(%{"actions" => [action]}),
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

      conn = Router.call(conn, [])
      assert conn.status == 401
    end
  end

  describe "Backward Compatibility" do
    test "existing Slice 1 flows still work" do
      bootstrap_group("a_test", "g_test", ["todo.*", "post.*"])

      entity_id = "todo_compat_1"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_compat_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_compat_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Compatibility Test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id)
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["id"] == entity_id
      assert entity["data"]["fields"]["title"]["value"] == "Compatibility Test"
    end
  end
end
