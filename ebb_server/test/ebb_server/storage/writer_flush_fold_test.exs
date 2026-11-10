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
          validated_component(group_id, "group/name", leaf("Old name", hlc), method: :replace),
          validated_component(group_id, "group/apps", apps_field(%{"notes" => true}, hlc),
            method: :merge
          )
        ]
      })

    # What a rename of the same group looks like: only the component the
    # request touched, in the same flush as the create.
    rename =
      validated_action(%{
        updates: [
          validated_component(group_id, "group/name", leaf("New name", hlc + 1), method: :merge)
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, rename], ctx.writer_name)

    # Unscoped here means "every app", so a fold that lost the `apps`
    # component would widen the group's scope to the whole server.
    assert GroupAppsCache.get_apps(group_id, ctx.group_apps) == MapSet.new(["notes"])
  end

  test "a groupMember permissions write after the create in one flush reaches the caches", ctx do
    hlc = generate_hlc()
    member_id = "gm_" <> Nanoid.generate()

    create =
      validated_action(%{
        updates: [
          validated_component(member_id, "groupMember/actor_id", leaf("actor_1", hlc),
            method: :replace
          ),
          validated_component(member_id, "groupMember/group_id", leaf("group_1", hlc),
            method: :replace
          ),
          validated_component(member_id, "groupMember/permissions", leaf(["todo.read"], hlc),
            method: :replace
          )
        ]
      })

    # The row's identity components are untouched, so this Action carries
    # only the component the request changed.
    permissions =
      validated_action(%{
        updates: [
          validated_component(
            member_id,
            "groupMember/permissions",
            leaf(["todo.write"], hlc + 1),
            method: :merge
          )
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, permissions], ctx.writer_name)

    # A `:put` fold would plan no membership row at all (the Action names
    # neither the actor nor the group), so the cache would keep the
    # permissions the second Action wrote over.
    assert [%{group_id: "group_1", permissions: ["todo.write"]}] =
             GroupCache.get_actor_groups("actor_1", ctx.group_members)

    assert GroupCache.get_permissions("actor_1", "group_1", ctx.group_members) == ["todo.write"]
  end

  test "an entityGroup move after the create in one flush keeps the row and its scope", ctx do
    hlc = generate_hlc()
    membership_id = "eg_" <> Nanoid.generate()

    create =
      validated_action(%{
        updates: [
          validated_component(membership_id, "entityGroup/entity_id", leaf("todo_1", hlc),
            method: :replace
          ),
          validated_component(membership_id, "entityGroup/group_id", leaf("group_1", hlc),
            method: :replace
          )
        ]
      })

    # Moving the membership re-states only the component that names it: the
    # `entity_id` sibling arrives in the create above.
    move =
      validated_action(%{
        updates: [
          validated_component(membership_id, "entityGroup/group_id", leaf("group_2", hlc + 1),
            method: :merge
          )
        ]
      })

    assert {:ok, {1, 2}, []} = Writer.write_actions([create, move], ctx.writer_name)

    # A `:put` fold drops the row: it names no `entity_id`, and a put reads no
    # prior row, so the move would leave the entity indexed under the old
    # group with no planned mutation behind it.
    # The cache row keeps the create's entity under the group the second
    # Action names, and the entity is indexed under exactly that group.
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
