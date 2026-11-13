defmodule EbbServer.AppScopeIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn

  import EbbServer.Integration.ActionHelpers

  alias EbbServer.Sync.Router
  alias EbbServer.TestHelpers

  @actor "a_app_scope"

  describe "group app scope" do
    test "the handshake projects each group's app ids and false removes one" do
      bootstrap_group(@actor, "g_notes", ["note.*", "ebb/group.*"], %{"notes" => true})
      bootstrap_group(@actor, "g_issues", ["issue.*", "ebb/group.*"], %{"issues" => true})

      bootstrap_group(@actor, "g_bridge", ["note.*", "issue.*", "ebb/group.*"], %{
        "notes" => true,
        "issues" => true
      })

      groups = handshake_groups()
      assert groups["g_notes"]["apps"] == ["notes"]
      assert groups["g_issues"]["apps"] == ["issues"]
      assert groups["g_bridge"]["apps"] == ["issues", "notes"]

      assert :ok = patch_group_apps("g_bridge", ["issues"])

      groups = handshake_groups()
      assert groups["g_bridge"]["apps"] == ["issues"]

      # An empty list is an empty scope, not an unscoped group.
      assert :ok = patch_group_apps("g_notes", [])

      groups = handshake_groups()
      assert groups["g_notes"]["apps"] == []
    end

    test "an unscoped group publishes null rather than an empty list" do
      bootstrap_group(@actor, "g_unscoped", ["note.*", "ebb/group.*"])

      groups = handshake_groups()
      assert Map.has_key?(groups["g_unscoped"], "apps")
      assert groups["g_unscoped"]["apps"] == nil
    end
  end

  defp handshake_groups do
    conn =
      conn(:post, "/sync/handshake", Jason.encode!(%{"cursors" => %{}, "schema_version" => 1}))
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-ebb-actor-id", @actor)
      |> Router.call([])

    assert conn.status == 200

    conn.resp_body
    |> Jason.decode!()
    |> Map.fetch!("groups")
    |> Map.new(fn group -> {group["id"], group} end)
  end

  # The group value is atomic, so an app-scope change re-states the whole
  # value: the scope is the list the caller passes.
  defp patch_group_apps(group_id, apps) do
    # One logical millisecond past the bootstrap so the patch outranks it.
    hlc = TestHelpers.generate_hlc() + 0x10000
    update_id = "upd_apps_" <> Nanoid.generate()

    action = %{
      "id" => "act_apps_" <> Nanoid.generate(),
      "actor_id" => @actor,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => update_id,
          "subject_id" => group_id,
          "component" => "ebb/group",
          "method" => "replace",
          "data" => %{"value" => %{"name" => "Test Group", "apps" => apps}, "hlc" => hlc}
        }
      ]
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), @actor)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["rejected"] == []

    :ok
  end
end
