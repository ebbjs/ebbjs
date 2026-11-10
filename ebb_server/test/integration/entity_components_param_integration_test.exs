defmodule EbbServer.EntityComponentsParamIntegrationTest do
  @moduledoc """
  Pins `GET /entities/:id?components=`, the component-scoped read.

  The whole row is returned when the parameter is absent; when it is present,
  `data.fields` is filtered to the requested components' fields and unknown
  names are ignored. The row shape itself does not change.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import Plug.Test
  import Plug.Conn
  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers, except: [get_entity: 1, get_entity: 2]

  alias EbbServer.Sync.Router

  setup do
    bootstrap_group("a_test", "g_test", ["todo.create", "todo.update", "todo.read"])
    entity_id = "todo_components"
    hlc = generate_hlc()

    action = %{
      "id" => "act_components",
      "actor_id" => "a_test",
      "hlc" => hlc,
      "updates" =>
        [
          %{
            "id" => "upd_title",
            "subject_id" => entity_id,
            "component" => "todo/title",
            "method" => "replace",
            "data" => %{"value" => "Buy milk", "hlc" => hlc}
          },
          %{
            "id" => "upd_completed",
            "subject_id" => entity_id,
            "component" => "todo/completed",
            "method" => "replace",
            "data" => %{"value" => false, "hlc" => hlc}
          }
        ] ++ entity_group_update(entity_id, "g_test", hlc)
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

    %{entity_id: entity_id}
  end

  defp get_entity(uri) do
    conn(:get, uri)
    |> put_req_header("x-ebb-actor-id", "a_test")
    |> Router.call([])
  end

  test "an omitted parameter returns the whole row", %{entity_id: entity_id} do
    conn = get_entity("/entities/#{entity_id}")
    assert conn.status == 200

    fields = Jason.decode!(conn.resp_body)["data"]["fields"]

    assert Map.keys(fields) |> Enum.sort() == ["completed", "title"]
  end

  test "a present parameter filters the fields to the requested components", %{
    entity_id: entity_id
  } do
    conn = get_entity("/entities/#{entity_id}?components=todo/title")
    assert conn.status == 200

    fields = Jason.decode!(conn.resp_body)["data"]["fields"]

    assert Map.keys(fields) == ["title"]
    assert fields["title"]["value"] == "Buy milk"
  end

  test "unknown component names are ignored", %{entity_id: entity_id} do
    conn = get_entity("/entities/#{entity_id}?components=todo/title,note/missing,other/title")
    assert conn.status == 200

    fields = Jason.decode!(conn.resp_body)["data"]["fields"]

    assert Map.keys(fields) == ["title"]
  end

  test "the rest of the row is untouched", %{entity_id: entity_id} do
    whole = Jason.decode!(get_entity("/entities/#{entity_id}").resp_body)
    filtered = Jason.decode!(get_entity("/entities/#{entity_id}?components=todo/title").resp_body)

    assert Map.drop(filtered, ["data"]) == Map.drop(whole, ["data"])
  end
end
