defmodule EbbServer.GroupBootstrapIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers

  alias EbbServer.Storage.{GroupCache, RelationshipCache}

  describe "group bootstrap" do
    test "group bootstrap accepted without prior permissions" do
      conn = bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      assert GroupCache.get_actor_groups("actor_1")
             |> Enum.any?(fn gm -> gm.group_id == "group_1" end)

      assert RelationshipCache.get_entity_group("group_1") == "group_1"
    end
  end
end
