defmodule EbbServer.Storage.QuerySemanticsVectorsTest do
  @moduledoc """
  Cross-language conformance for query semantics.

  `EbbServer.Storage.SQLite`'s filter SQL and `packages/client`'s plan executor
  must reproduce `fixtures/query_semantics_vectors.json`, so the two
  hand-mirrored implementations of one predicate language cannot drift.

  Fixture rows are written through the real write path (one create per row
  plus its `entityGroup` row, each as one Update per component) so the query
  also runs the permission JOINs a caller reaches through
  `EntityStore.query/4`.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, Writer}

  import EbbServer.TestHelpers

  @vectors_path Path.expand("../../../../fixtures/query_semantics_vectors.json", __DIR__)

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: gm_table,
      group_members_by_id: gm_by_id_table,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id_table,
      entity_groups_by_group: eg_by_group_table,
      relationships: rel_table,
      relationships_by_id: rbi_table
    } = start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{name: writer_name} =
      start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: gsn_counter,
        group_members: gm_table,
        group_members_by_id: gm_by_id_table,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table,
        relationships: rel_table,
        relationships_by_id: rbi_table
      })

    %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    }
  end

  test "reproduces every shared query-semantics vector", %{
    rocks_name: rocks_name,
    sqlite_name: sqlite_name,
    writer_name: writer_name,
    dirty_set: dirty_set
  } do
    vectors = load_vectors()
    assert vectors["rows"] != [], "expected #{@vectors_path} to contain rows"
    assert vectors["cases"] != [], "expected #{@vectors_path} to contain cases"

    group_id = "g_vectors_#{System.unique_integer([:positive])}"
    actor_id = "a_vectors_#{System.unique_integer([:positive])}"

    bootstrap_group(group_id, actor_id, writer_name)

    for row <- vectors["rows"] do
      write_row(row["id"], group_id, actor_id, writer_name, row["fields"], row["maps"] || %{})
    end

    opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

    for %{"name" => name, "filter" => filter, "expected" => expected} <- vectors["cases"] do
      assert {:ok, rows} = EntityStore.query("todo", filter, actor_id, opts)

      ids = rows |> Enum.map(& &1.id) |> Enum.sort()

      assert ids == Enum.sort(expected),
             "vector #{inspect(name)} drifted: got #{inspect(ids)}, expected #{inspect(expected)}"
    end
  end

  defp load_vectors do
    @vectors_path
    |> File.read!()
    |> Jason.decode!()
  end

  defp write_row(row_id, group_id, actor_id, writer_name, fields, maps) do
    hlc = generate_hlc()

    leaf_updates =
      Enum.map(fields, fn {field, value} ->
        validated_component(row_id, "todo/#{field}", %{"value" => value, "hlc" => hlc})
      end)

    map_updates =
      Enum.map(maps, fn {field, entries} ->
        validated_component(
          row_id,
          "todo/#{field}",
          %{
            "map" =>
              Map.new(entries, fn {key, value} ->
                {key, %{"value" => value, "hlc" => hlc}}
              end)
          },
          method: :merge
        )
      end)

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: leaf_updates ++ map_updates
    }

    {:ok, _gsn_pair, []} = Writer.write_actions([action], writer_name)

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        validated_component(eg_id, "entityGroup/entity_id", %{
          "value" => row_id,
          "hlc" => eg_hlc
        }),
        validated_component(eg_id, "entityGroup/group_id", %{
          "value" => group_id,
          "hlc" => eg_hlc
        })
      ]
    }

    {:ok, _gsn_pair, []} = Writer.write_actions([eg_action], writer_name)
  end

  # The permission JOIN reads a live `entityGroup` row for the queried entity
  # and a `groupMember` row for the actor, with a non-empty permission list.
  defp bootstrap_group(group_id, actor_id, writer_name) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    gm_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        validated_component(gm_id, "groupMember/actor_id", %{"value" => actor_id, "hlc" => hlc}),
        validated_component(gm_id, "groupMember/group_id", %{
          "value" => group_id,
          "hlc" => hlc
        }),
        validated_component(gm_id, "groupMember/permissions", %{
          "value" => ["todo.read"],
          "hlc" => hlc
        })
      ]
    }

    {:ok, _gsn_pair, []} = Writer.write_actions([gm_action], writer_name)
  end
end
