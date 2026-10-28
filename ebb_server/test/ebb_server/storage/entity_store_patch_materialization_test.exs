defmodule EbbServer.Storage.EntityStorePatchMaterializationTest do
  @moduledoc """
  The corners of `EntityStore`'s map-field patch write-back that only run when
  the cached base and the incoming patch disagree about shape.

  A dirty materialization replays patches into the cached row and then writes
  back either the touched JSON paths (`json_set`) or the whole field. The two
  are only interchangeable while the path exists in the merged value, so these
  tests pin the choice for an empty map field, a missing ancestor, an ancestor
  that changed kind, and a path the merge no longer contains. They also pin
  the two read failures around the same write-back: a cached row carrying no
  data, and a query the cache refuses.

  Every materialization here is driven from the action log the way the Writer
  leaves it — crafted `cf_actions` frames plus a matching `cf_entity_actions`
  GSN list — because the update shapes that reach these branches are ones the
  write-path validator never has to admit.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionFormat, DirtyTracker, EntityStore, RocksDB, SQLite}
  alias Exqlite.Sqlite3

  import EbbServer.TestHelpers

  defp leaf(value, hlc), do: %{"value" => value, "hlc" => hlc}
  defp map_field(entries), do: %{"map" => entries}

  defp store_opts(ctx) do
    [
      rocks_name: ctx.rocks_name,
      sqlite_name: ctx.sqlite_name,
      dirty_set: ctx.dirty_set
    ]
  end

  # Seeds the row the way a previous materialization would have left it.
  defp seed_row(entity_id, fields, sqlite_name) do
    upsert_row(entity_id, Jason.encode!(%{"fields" => fields}), sqlite_name)
  end

  defp upsert_row(entity_id, data, sqlite_name) do
    hlc = hlc_from(1_000)

    :ok =
      SQLite.upsert_entity(
        %{
          id: entity_id,
          type: "todo",
          data: data,
          created_hlc: hlc,
          updated_hlc: hlc,
          deleted_hlc: nil,
          deleted_by: nil,
          last_gsn: 0
        },
        sqlite_name
      )
  end

  defp update_action(entity_id, gsn, method, fields, hlc, subject_type \\ "todo") do
    %{
      gsn: gsn,
      action: %{
        id: "act_#{entity_id}_#{gsn}",
        actor_id: "a_test",
        hlc: hlc,
        updates: [
          %{
            id: "upd_#{entity_id}_#{gsn}",
            subject_id: entity_id,
            subject_type: subject_type,
            method: method,
            data: %{"fields" => fields}
          }
        ]
      }
    }
  end

  defp store_actions(entity_id, actions, ctx) do
    max_gsn = actions |> Enum.map(& &1.gsn) |> Enum.max()
    gsns = Enum.map(actions, & &1.gsn)

    puts =
      Enum.map(actions, fn %{gsn: gsn, action: action} ->
        {:put, RocksDB.cf_actions(ctx.rocks_name), RocksDB.encode_gsn_key(gsn), frame(action)}
      end)

    :ok =
      RocksDB.write_batch(
        puts ++
          [
            {:put, RocksDB.cf_entity_actions(ctx.rocks_name),
             RocksDB.encode_entity_flush_key(entity_id, max_gsn), RocksDB.encode_gsn_list(gsns)}
          ],
        name: ctx.rocks_name
      )

    :ok = DirtyTracker.mark_dirty_batch([{entity_id, "todo"}], ctx.dirty_set)
  end

  defp frame(action) do
    action
    |> ActionFormat.build()
    |> ActionFormat.encode()
    |> ActionFormat.frame([[]])
  end

  setup do
    %{dirty_set: dirty_set} = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{
      rocks_name: rocks_name,
      rocks_dir: rocks_dir,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    }
  end

  describe "an update method materialization does not know" do
    test "is ignored: it changes neither the entity nor its type", ctx do
      entity_id = "todo_pm_unknown_method"

      store_actions(
        entity_id,
        [
          update_action(
            entity_id,
            1,
            "put",
            %{"title" => leaf("Kept", hlc_from(1_000))},
            hlc_from(1_000)
          ),
          # A verb this build does not materialize — a newer one on the wire,
          # or a corrupt record — must not fail the read or half-apply its
          # payload.
          update_action(
            entity_id,
            2,
            "archive",
            %{
              "title" => leaf("Ignored", hlc_from(2_000)),
              "archived_at" => leaf("now", hlc_from(2_000))
            },
            hlc_from(2_000),
            "post"
          )
        ],
        ctx
      )

      assert {:ok, entity} = EntityStore.materialize(entity_id, store_opts(ctx))
      assert entity.type == "todo"
      assert entity.last_gsn == 1
      assert entity.data["fields"]["title"]["value"] == "Kept"
      refute Map.has_key?(entity.data["fields"], "archived_at")

      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert cached.type == "todo"
      assert cached.data["fields"]["title"]["value"] == "Kept"
    end
  end

  describe "a patch onto a cached row with empty data" do
    test "builds the fields map instead of failing the read", ctx do
      entity_id = "todo_pm_empty_cached_data"

      # A row whose blob carries no `fields` key at all.
      upsert_row(entity_id, "{}", ctx.sqlite_name)

      store_actions(
        entity_id,
        [
          update_action(
            entity_id,
            1,
            "patch",
            %{"title" => leaf("Hello", hlc_from(1_000))},
            hlc_from(1_000)
          )
        ],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert entity.data["fields"]["title"]["value"] == "Hello"

      assert {:ok, cached} = SQLite.get_entity(entity_id, ctx.sqlite_name)
      assert Jason.decode!(cached.data)["fields"]["title"]["value"] == "Hello"
    end
  end

  describe "an empty-map field patch" do
    test "writes the field, so the next clean read agrees with this one", ctx do
      entity_id = "todo_pm_empty_map_patch"
      seed_row(entity_id, %{"title" => leaf("Kept", hlc_from(1_000))}, ctx.sqlite_name)

      store_actions(
        entity_id,
        [
          update_action(
            entity_id,
            1,
            "patch",
            %{"content" => map_field(%{})},
            hlc_from(2_000)
          )
        ],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert entity.data["fields"]["content"] == %{"map" => %{}}

      # A patch carrying no map keys still names the field, so the row has to
      # gain it; otherwise the read that materialized it and every clean read
      # after disagree.
      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert cached.data["fields"]["content"] == %{"map" => %{}}
      assert cached.data["fields"]["title"]["value"] == "Kept"
    end
  end

  describe "a nested map patch whose ancestor is missing" do
    test "creates the path and leaves the cached siblings in place", ctx do
      entity_id = "todo_pm_missing_ancestor"

      seed_row(
        entity_id,
        %{"content" => map_field(%{"kept" => leaf(7, hlc_from(1_000))})},
        ctx.sqlite_name
      )

      nested =
        map_field(%{
          "a" => map_field(%{"b" => map_field(%{"c" => leaf("deep", hlc_from(2_000))})})
        })

      store_actions(
        entity_id,
        [update_action(entity_id, 1, "patch", %{"content" => nested}, hlc_from(2_000))],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      content = entity.data["fields"]["content"]

      assert content["map"]["kept"]["value"] == 7
      assert get_in(content, ["map", "a", "map", "b", "map", "c", "value"]) == "deep"

      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert cached.data["fields"]["content"] == content
    end
  end

  describe "a nested map patch whose ancestor is a leaf" do
    test "rewrites the whole field rather than nesting inside the old leaf", ctx do
      entity_id = "todo_pm_blocked_ancestor"

      seed_row(
        entity_id,
        %{"content" => map_field(%{"a" => leaf(9, hlc_from(1_000))})},
        ctx.sqlite_name
      )

      nested =
        map_field(%{
          "a" => map_field(%{"b" => map_field(%{"c" => leaf("deep", hlc_from(2_000))})})
        })

      store_actions(
        entity_id,
        [update_action(entity_id, 1, "patch", %{"content" => nested}, hlc_from(2_000))],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      stored = cached.data["fields"]["content"]

      assert stored == entity.data["fields"]["content"]
      assert get_in(stored, ["map", "a", "map", "b", "map", "c", "value"]) == "deep"

      # A nested `json_set` would have kept the replaced leaf's own keys
      # beside the new map; their absence is what proves the whole field was
      # written.
      refute Map.has_key?(stored["map"]["a"], "value")
      refute Map.has_key?(stored["map"]["a"], "hlc")
    end
  end

  describe "a nested path the merge no longer contains" do
    test "falls back to the whole field instead of writing through a leaf", ctx do
      entity_id = "todo_pm_navigation_miss"

      seed_row(
        entity_id,
        %{
          "content" =>
            map_field(%{
              "a" => map_field(%{"b" => map_field(%{"d" => leaf(1, hlc_from(1_000))})})
            })
        },
        ctx.sqlite_name
      )

      deeper =
        map_field(%{
          "a" => map_field(%{"b" => map_field(%{"c" => leaf("deep", hlc_from(2_000))})})
        })

      replacement = map_field(%{"a" => leaf("scalar", hlc_from(3_000))})

      store_actions(
        entity_id,
        [
          update_action(entity_id, 1, "patch", %{"content" => deeper}, hlc_from(2_000)),
          # The newer patch turns `a` into a leaf, so the path the earlier
          # patch contributed is gone from the merged field.
          update_action(entity_id, 2, "patch", %{"content" => replacement}, hlc_from(3_000))
        ],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      stored = cached.data["fields"]["content"]

      assert stored == entity.data["fields"]["content"]
      assert stored["map"]["a"]["value"] == "scalar"
      refute Map.has_key?(stored["map"]["a"], "map")
    end

    test "falls back when a map replaced an intervening leaf, dropping the old keys", ctx do
      entity_id = "todo_pm_navigation_miss_map"

      seed_row(
        entity_id,
        %{
          "content" =>
            map_field(%{
              "a" => map_field(%{"b" => map_field(%{"d" => leaf(1, hlc_from(1_000))})})
            })
        },
        ctx.sqlite_name
      )

      deeper =
        map_field(%{
          "a" => map_field(%{"b" => map_field(%{"c" => leaf("deep", hlc_from(2_000))})})
        })

      # Two kind changes at `a` — a leaf, then a map with disjoint keys. The
      # map that arrives last replaces the leaf without inheriting the older
      # patch's `b`, so the merged field is a map that no longer holds the
      # path.
      replacement = map_field(%{"a" => map_field(%{"z" => leaf("z", hlc_from(4_000))})})

      store_actions(
        entity_id,
        [
          update_action(entity_id, 1, "patch", %{"content" => deeper}, hlc_from(2_000)),
          update_action(
            entity_id,
            2,
            "patch",
            %{"content" => map_field(%{"a" => leaf("scalar", hlc_from(3_000))})},
            hlc_from(3_000)
          ),
          update_action(entity_id, 3, "patch", %{"content" => replacement}, hlc_from(4_000))
        ],
        ctx
      )

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      assert {:ok, cached} = EntityStore.get(entity_id, "a_test", store_opts(ctx))
      stored = cached.data["fields"]["content"]

      assert stored == entity.data["fields"]["content"]
      assert get_in(stored, ["map", "a", "map", "z", "value"]) == "z"
      refute Map.has_key?(stored["map"]["a"]["map"], "b")
    end
  end

  describe "a cached row with no data" do
    test "fails the read with a message naming the entity", ctx do
      entity_id = "todo_pm_nil_data"
      upsert_row(entity_id, nil, ctx.sqlite_name)

      assert_raise RuntimeError, ~r/Unexpected nil data for entity "todo_pm_nil_data"/, fn ->
        EntityStore.get(entity_id, "a_test", store_opts(ctx))
      end
    end
  end

  describe "a query the cache refuses" do
    test "returns the SQLite error instead of raising or taking the cache down", ctx do
      sqlite_pid = Process.whereis(ctx.sqlite_name)

      # A real refusal, not a stub: the read path's query prepares against
      # `entities`, so the table is renamed out from under the shared process.
      {:ok, db} = Sqlite3.open(Path.join(ctx.rocks_dir, "ebb.db"))
      :ok = Sqlite3.execute(db, "ALTER TABLE entities RENAME TO entities_unavailable")
      :ok = Sqlite3.close(db)

      assert {:error, message} = EntityStore.query("todo", nil, "a_test", store_opts(ctx))

      assert is_binary(message)
      assert message =~ "no such table: entities"
      assert Process.whereis(ctx.sqlite_name) == sqlite_pid
    end
  end
end
