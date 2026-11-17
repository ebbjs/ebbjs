defmodule EbbServer.RowCreateIntegrationTest do
  @moduledoc """
  The row-scoped `create` on the server: a zero-component row exists, is
  readable, is listed with its group, and travels through catch-up.

  The create is the only wire fact that brings a row into existence, so a
  component write with no create is refused rather than materialized.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  import EbbServer.Integration.ActionHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Sync.{CatchUp, Router}

  setup do
    actor_id = "a_create_#{:erlang.unique_integer([:positive])}"
    group_id = "g_create_#{:erlang.unique_integer([:positive])}"

    assert bootstrap_group(actor_id, group_id, ["todo.create", "todo.read"]).status == 200

    %{actor_id: actor_id, group_id: group_id}
  end

  test "a zero-component create is readable with its created_hlc", ctx do
    entity_id = "todo_create_only_#{:erlang.unique_integer([:positive])}"
    created_hlc = generate_hlc()

    post_create(ctx, entity_id, created_hlc)

    conn = get_entity(entity_id, ctx.actor_id)
    assert conn.status == 200

    entity = Jason.decode!(conn.resp_body)
    assert entity["model"] == "todo"
    assert entity["data"] == %{"fields" => %{}}
    assert entity["created_hlc"] == created_hlc
    assert entity["deleted_hlc"] == nil
  end

  test "the group listing returns a zero-component row", ctx do
    entity_id = "todo_create_listed_#{:erlang.unique_integer([:positive])}"
    created_hlc = generate_hlc()

    post_create(ctx, entity_id, created_hlc)

    conn = get_listing(ctx.group_id, ctx.actor_id)
    assert conn.status == 200

    page = Jason.decode!(conn.resp_body)
    entity = Enum.find(page["entities"], &(&1["id"] == entity_id))

    assert entity, "the listing must carry the zero-component row"
    assert entity["model"] == "todo"
    assert entity["data"] == %{"fields" => %{}}
    assert entity["created_hlc"] == created_hlc
  end

  test "catch-up delivers the create Update for a zero-component row", ctx do
    entity_id = "todo_create_catch_up_#{:erlang.unique_integer([:positive])}"
    created_hlc = generate_hlc()

    post_create(ctx, entity_id, created_hlc)

    assert {:ok, actions, _meta} = CatchUp.catch_up_group(ctx.group_id, ctx.actor_id, 0)

    action =
      Enum.find(actions, fn action ->
        Enum.any?(
          action["updates"],
          &(&1["subject_id"] == entity_id and &1["method"] == "create")
        )
      end)

    assert action, "catch-up must deliver the create"

    create =
      Enum.find(action["updates"], &(&1["subject_id"] == entity_id and &1["method"] == "create"))

    assert create["model"] == "todo"
    assert create["hlc"] == created_hlc
    refute Map.has_key?(create, "component")
  end

  test "a component write with no create is refused", ctx do
    entity_id = "todo_no_create_#{:erlang.unique_integer([:positive])}"
    hlc = generate_hlc()

    action = %{
      "id" => "act_no_create_#{:erlang.unique_integer([:positive])}",
      "actor_id" => ctx.actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_no_create_#{:erlang.unique_integer([:positive])}",
          "subject_id" => entity_id,
          "component" => "todo/title",
          "method" => "replace",
          "data" => %{"type" => "lww", "value" => "orphan", "hlc" => hlc}
        }
      ]
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), ctx.actor_id)
    assert conn.status == 200

    assert %{"rejected" => [rejection]} = Jason.decode!(conn.resp_body)
    assert rejection["reason"] in ["missing_ownership", "not_authorized"]

    assert get_entity(entity_id, ctx.actor_id).status == 404
  end

  defp post_create(ctx, entity_id, created_hlc) do
    action = %{
      "id" => "act_create_#{:erlang.unique_integer([:positive])}",
      "actor_id" => ctx.actor_id,
      "hlc" => created_hlc,
      "updates" =>
        [
          create_update(
            "upd_create_#{:erlang.unique_integer([:positive])}",
            entity_id,
            "todo",
            created_hlc
          )
        ] ++ membership_update(entity_id, ctx.group_id, created_hlc)
    }

    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), ctx.actor_id)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"rejected" => []}
  end

  defp get_listing(group_id, actor_id) do
    conn(:get, "/sync/groups/#{group_id}/entities")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end
end
