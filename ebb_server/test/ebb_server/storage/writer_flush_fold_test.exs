defmodule EbbServer.Storage.WriterFlushFoldTest do
  @moduledoc """
  Pins that later Actions of one flush fold against the rows the flush's own
  earlier Actions created.

  A flush is one commit, and a whole request is normally one flush, so the
  outbox shape "create a system row, then write another component of it" puts
  two Actions on one row in one commit. The second write must fold as a
  `:patch` of the components it carries: a `:put` tells the cache planner to
  replace the whole row, which drops the group's app scope, drops a
  membership's cache row, and leaves the authorization cache holding
  permissions that were just written over.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionFormat,
    EntityGroupCache,
    GroupAppsCache,
    GroupCache,
    RocksDB,
    Writer
  }

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    start_sqlite(rocks_dir)
    %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

    Map.merge(cache, %{rocks_name: rocks_name, writer_name: writer_name})
  end

  test "a rename in the same flush keeps the apps scope the create wrote", ctx do
    hlc = generate_hlc()
    group_id = "group_" <> Nanoid.generate()

    create =
      validated_action(%{
        updates: [
          validated_component(
            group_id,
            "ebb/group",
            leaf(%{"name" => "Old name", "apps" => ["notes"]}, hlc)
          )
        ]
      })

    # The group value is atomic, so a rename re-states the whole value: the
    # app scope is part of it, never a sibling that a fold can drop.
    rename =
      validated_action(%{
        updates: [
          validated_component(
            group_id,
            "ebb/group",
            leaf(%{"name" => "New name", "apps" => ["notes"]}, hlc + 1)
          )
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, rename], ctx.writer_name)

    assert GroupAppsCache.get_apps(group_id, ctx.group_apps) == MapSet.new(["notes"])
  end

  test "a groupMember permissions write after the create in one flush reaches the caches", ctx do
    hlc = generate_hlc()
    member_id = "gm_" <> Nanoid.generate()

    create =
      validated_action(%{
        updates: [
          validated_component(
            member_id,
            "ebb/grant",
            leaf(
              %{
                "actor_id" => "actor_1",
                "group_id" => "group_1",
                "permissions" => ["todo.read"]
              },
              hlc
            )
          )
        ]
      })

    permissions =
      validated_action(%{
        updates: [
          validated_component(
            member_id,
            "ebb/grant",
            leaf(
              %{
                "actor_id" => "actor_1",
                "group_id" => "group_1",
                "permissions" => ["todo.write"]
              },
              hlc + 1
            )
          )
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, permissions], ctx.writer_name)

    assert [%{group_id: "group_1", permissions: ["todo.write"]}] =
             GroupCache.get_actor_groups("actor_1", ctx.group_members)

    assert GroupCache.get_permissions("actor_1", "group_1", ctx.group_members) == ["todo.write"]
  end

  test "a later membership write in one flush keeps the row and its scope", ctx do
    hlc = generate_hlc()
    membership_id = "eg_" <> Nanoid.generate()

    create =
      validated_action(%{
        updates: [
          validated_component(
            membership_id,
            "ebb/membership",
            leaf(%{"entity_id" => "todo_1", "group_id" => "group_1"}, hlc)
          )
        ]
      })

    # The second Action re-states the row's whole value (moving a membership
    # is a delete plus a create, so a later write of the same row names the
    # same pair here).
    later =
      validated_action(%{
        updates: [
          validated_component(
            membership_id,
            "ebb/membership",
            leaf(%{"entity_id" => "todo_1", "group_id" => "group_2"}, hlc + 1)
          )
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, later], ctx.writer_name)

    assert EntityGroupCache.entity_groups("todo_1", ctx.entity_groups) == ["group_2"]

    assert %{id: ^membership_id, entity_id: "todo_1", group_id: "group_2"} =
             EntityGroupCache.get_entity_group(membership_id, ctx.entity_groups_by_id)

    assert update_scopes(ctx.rocks_name, 2) == [["group_2"]]
  end

  defp update_scopes(rocks_name, gsn) do
    {:ok, frame} =
      RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), name: rocks_name)

    ActionFormat.decode(frame, gsn)["update_scopes"]
  end

  defp leaf(value, hlc) do
    %{"type" => "lww", "value" => value, "hlc" => hlc, "update_id" => "upd_" <> Nanoid.generate()}
  end

  defp apps_field(entries, hlc) do
    %{"map" => Map.new(entries, fn {app_id, value} -> {app_id, leaf(value, hlc)} end)}
  end
end
