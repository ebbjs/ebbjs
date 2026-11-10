defmodule EbbServer.Storage.WriterComponentScopeTest do
  @moduledoc """
  Pins that fan-out scope is a per-subject decision, not a per-component one.

  A system row's scope is named by one of its component Updates — an
  `entityGroup` row's `group_id`, a relationship row's `source_id` — while its
  siblings carry none. Resolving scope per component Update would leave the
  sibling with an empty scope and silently drop its delivery.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionFormat, EntityGroupCache, RocksDB, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)
    %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

    Map.merge(cache, %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    })
  end

  defp stored_action(gsn, rocks_name) do
    {:ok, frame} =
      RocksDB.get(
        RocksDB.cf_actions(rocks_name),
        RocksDB.encode_gsn_key(gsn),
        name: rocks_name
      )

    ActionFormat.decode(frame, gsn)
  end

  test "every component Update of an entityGroup create is scoped to its group", ctx do
    updates = [
      validated_component("eg_1", "entityGroup/entity_id", %{"value" => "todo_1", "hlc" => 1},
        method: :replace
      ),
      validated_component("eg_1", "entityGroup/group_id", %{"value" => "g_1", "hlc" => 1},
        method: :replace
      )
    ]

    action = validated_action(%{updates: updates})

    assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

    stored = stored_action(1, ctx.rocks_name)

    assert Enum.map(stored["updates"], & &1["component"]) == [
             "entityGroup/entity_id",
             "entityGroup/group_id"
           ]

    assert stored["update_scopes"] == [["g_1"], ["g_1"]]
  end

  test "every component Update of a relationship create is scoped to its source's groups", ctx do
    # The source entity's groups are the edge's scope; the source_id component
    # is what names it, and its siblings must inherit the same list.
    EntityGroupCache.put_entity_group(
      %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"},
      entity_groups: ctx.entity_groups,
      entity_groups_by_id: ctx.entity_groups_by_id,
      entity_groups_by_group: ctx.entity_groups_by_group
    )

    :ets.insert(ctx.entity_types, {"todo_1", "todo"})

    updates =
      for {field, value} <- [
            {"source_id", "todo_1"},
            {"target_id", "g_2"},
            {"type", "note"},
            {"field", "link"}
          ] do
        validated_component("rel_1", "relationship/#{field}", %{"value" => value, "hlc" => 1},
          method: :replace
        )
      end

    action = validated_action(%{updates: updates})

    assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

    stored = stored_action(1, ctx.rocks_name)

    assert stored["update_scopes"] == [["g_1"], ["g_1"], ["g_1"], ["g_1"]]

    assert Enum.map(stored["updates"], & &1["component"]) == [
             "relationship/source_id",
             "relationship/target_id",
             "relationship/type",
             "relationship/field"
           ]
  end
end
