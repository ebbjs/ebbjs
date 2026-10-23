defmodule EbbServer.Storage.EntityViewTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers

  alias EbbServer.Storage.{EntityStore, EntityView, Writer}

  @view_keys ["created_hlc", "data", "deleted_hlc", "id", "last_gsn", "type", "updated_hlc"]

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(dir)
    %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

    %{
      cache: cache,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    }
  end

  describe "for_actor/3" do
    test "returns the entity's wire view to a member", ctx do
      entity_id = "todo_view"
      write_todo(ctx, entity_id)
      put_membership(ctx.cache, entity_id, "g_1", "a_member")

      assert {:ok, view} = EntityView.for_actor(entity_id, "a_member", store_opts(ctx))

      assert view |> Map.keys() |> Enum.sort() == @view_keys

      assert {:ok, entity} = EntityStore.get(entity_id, "a_member", store_opts(ctx))
      assert view["id"] == entity.id
      assert view["type"] == entity.type
      assert view["data"] == entity.data
      assert view["created_hlc"] == entity.created_hlc
      assert view["updated_hlc"] == entity.updated_hlc
      assert view["deleted_hlc"] == entity.deleted_hlc
      assert view["last_gsn"] == entity.last_gsn
    end

    test "returns :not_found to a non-member", ctx do
      entity_id = "todo_view"
      write_todo(ctx, entity_id)
      put_membership(ctx.cache, entity_id, "g_1", "a_other")

      assert :not_found = EntityView.for_actor(entity_id, "a_member", store_opts(ctx))
    end

    test "returns :not_found for a missing entity", ctx do
      assert :not_found = EntityView.for_actor("todo_missing", "a_member", store_opts(ctx))
    end
  end

  defp write_todo(ctx, entity_id) do
    hlc = generate_hlc()

    update =
      validated_update(%{
        subject_id: entity_id,
        data: %{
          "fields" => %{"title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc}}
        }
      })

    action = validated_action(%{actor_id: "a_member", updates: [update]})

    assert {:ok, _gsn_range, []} = Writer.write_actions([action], ctx.writer_name)
  end

  defp put_membership(cache, entity_id, group_id, actor_id) do
    :ets.insert(
      cache.entity_groups,
      {entity_id, %{id: "eg_1", entity_id: entity_id, group_id: group_id}}
    )

    :ets.insert(
      cache.group_members,
      {actor_id, %{id: "gm_1", group_id: group_id, permissions: ["todo.read"]}}
    )
  end

  defp store_opts(ctx) do
    [rocks_name: ctx.rocks_name, sqlite_name: ctx.sqlite_name, dirty_set: ctx.cache.dirty_set]
  end
end
