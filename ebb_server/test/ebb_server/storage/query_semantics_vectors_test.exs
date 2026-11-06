defmodule EbbServer.Storage.QuerySemanticsVectorsTest do
  @moduledoc """
  Cross-language conformance for query semantics.

  `EbbServer.Storage.SQLite`'s filter SQL and `packages/client`'s plan executor
  must reproduce `fixtures/query_semantics_vectors.json`, so the two
  hand-mirrored implementations of one predicate language cannot drift.

  Fixture rows are written through the real write path (one `put` per row plus
  its `entityGroup` row) so the query also runs the permission JOINs a caller
  reaches through `EntityStore.query/4`.
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

    envelopes =
      Map.new(fields, fn {field, value} ->
        {field, %{"type" => "lww", "value" => value, "hlc" => hlc}}
      end)

    map_envelopes =
      Map.new(maps, fn {field, entries} ->
        {field,
         %{
           "map" =>
             Map.new(entries, fn {key, value} ->
               {key, %{"type" => "lww", "value" => value, "hlc" => hlc}}
             end)
         }}
      end)

    envelopes = Map.merge(envelopes, map_envelopes)

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: row_id,
          subject_type: "todo",
          method: :put,
          data: %{"fields" => envelopes}
        }
      ]
    }

    {:ok, _gsn_pair, []} = Writer.write_actions([action], writer_name)

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => row_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
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
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: gm_id,
          subject_type: "groupMember",
          method: :put,
          data: %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, _gsn_pair, []} = Writer.write_actions([gm_action], writer_name)
  end
end
