defmodule EbbServer.Integration.ActionHelpers do
  @moduledoc """
  Shared helper functions for integration tests that interact with actions.

  Provides:
  - `post_actions/2` - POST action(s) to /sync/actions endpoint
  - `get_entity/2` - GET an entity by ID
  - `bootstrap_group/3` - Create a test group with permissions
  - `write_entity_in_group/5` - Write an entity to a group
  - `entity_group_update/3` - Build a same-Action `entityGroup` put
  - `msgpack_encode!/1` - Encode data as MessagePack binary
  """

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Sync.Router
  alias EbbServer.TestHelpers

  def post_actions(body, actor_id \\ "a_test") do
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

  def get_entity(id, actor_id \\ "a_test") do
    conn(:get, "/entities/#{id}")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  def msgpack_encode!(data), do: data |> Msgpax.pack!() |> IO.iodata_to_binary()

  def bootstrap_group(actor_id, group_id, permissions) do
    hlc = TestHelpers.generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

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
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => permissions, "hlc" => hlc}
            }
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  def write_entity_in_group(actor_id, entity_id, entity_type, group_id, fields) do
    hlc = TestHelpers.generate_hlc()

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
        entity_group_update(entity_id, group_id, hlc)
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  def entity_group_update(entity_id, group_id, hlc) do
    eg_id = "eg_" <> Nanoid.generate()

    %{
      "id" => eg_id,
      "subject_id" => eg_id,
      "subject_type" => "entityGroup",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
        }
      }
    }
  end
end
