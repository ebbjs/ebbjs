defmodule EbbServer.Storage.SystemCacheTest do
  @moduledoc """
  Tests for SystemCache — specifically the startup `populate_system_caches`
  logic that rebuilds `GroupCache` and `RelationshipCache` from the
  persistent index, plus the `backfill_type_entities` step that
  reconciles the type-entities index against the action log.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    GroupCache,
    RelationshipCache,
    RocksDB,
    SQLite,
    SystemCache,
    Writer
  }

  alias EbbServer.TestHelpers

  setup do
    unique = System.unique_integer([:positive])

    %{
      dirty_set: dirty_set,
      group_members: gm_table,
      relationships: rel_table,
      relationships_by_group: rbg_table
    } = TestHelpers.start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = TestHelpers.start_rocks(%{test: "sys_cache_#{unique}"})

    %{name: sqlite_name} = TestHelpers.start_sqlite(rocks_dir)

    %{name: writer_name} =
      TestHelpers.start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: :atomics.new(1, signed: false),
        group_members: gm_table,
        relationships: rel_table,
        relationships_by_group: rbg_table
      })

    %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      rel_table: rel_table,
      rbg_table: rbg_table
    }
  end

  describe "populate_system_caches/0" do
    # This is the regression test for the user-reported bug: when
    # cf_type_entities entries are missing (e.g. written by an older
    # version of the Writer, or wiped by a manual data fix-up), the
    # startup rebuild must still populate RelationshipCache so
    # subsequent writes to that entity index into the right group's
    # action stream.
    test "re-populates RelationshipCache after cf_type_entities is wiped", %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      rel_table: rel_table,
      rbg_table: rbg_table
    } do
      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "grp_test",
            subject_type: "group",
            method: :put,
            data: %{"name" => "Test"}
          },
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "gm_test",
            subject_type: "groupMember",
            method: :put,
            data: %{
              "fields" => %{
                "actor_id" => %{"value" => "demo-seeder", "update_id" => "u1"},
                "group_id" => %{"value" => "grp_test", "update_id" => "u1"},
                "permissions" => %{"value" => ["group.*"], "update_id" => "u1"}
              }
            }
          },
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "rel_test",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "doc_test", "update_id" => "u1"},
                "target_id" => %{"value" => "grp_test", "update_id" => "u1"},
                "type" => %{"value" => "text_document", "update_id" => "u1"},
                "field" => %{"value" => "ownedBy", "update_id" => "u1"}
              }
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf_type = RocksDB.cf_type_entities(rocks_name)
      db_ref = RocksDB.db_ref(rocks_name)

      # Confirm writer populated cf_type_entities.
      assert RocksDB.get(cf_type, "relationship\0rel_test", name: rocks_name) == {:ok, <<>>}

      # Simulate the broken state: cf_type_entities entries for the
      # groupMember and relationship have been wiped, but the action
      # log still contains them.
      :ok = :rocksdb.delete(db_ref, cf_type, "groupMember\0gm_test", [])
      :ok = :rocksdb.delete(db_ref, cf_type, "relationship\0rel_test", [])

      # RelationshipCache should also be empty now (simulating a fresh
      # server start).
      RelationshipCache.reset(relationships: rel_table, relationships_by_group: rbg_table)

      assert RelationshipCache.get_entity_group("doc_test", rel_table) == nil

      # Run the cache rebuild.
      :ok =
        SystemCache.populate_system_caches(
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          table: gm_table,
          relationships: rel_table,
          relationships_by_group: rbg_table
        )

      # The relationship must be back in the cache. Subsequent writes
      # to doc_test will now index into grp_test's action stream.
      assert RelationshipCache.get_entity_group("doc_test", rel_table) == "grp_test"

      # And the cf_type_entities index must be repaired too, so a
      # second restart (without further writes) still rebuilds
      # correctly.
      assert RocksDB.get(cf_type, "relationship\0rel_test", name: rocks_name) == {:ok, <<>>}
      assert RocksDB.get(cf_type, "groupMember\0gm_test", name: rocks_name) == {:ok, <<>>}
    end

    test "is a no-op when cf_type_entities is already in sync", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      rel_table: rel_table,
      rbg_table: rbg_table
    } do
      # No actions written; cf_actions and cf_type_entities are both
      # empty. populate_system_caches should write nothing.
      :ok =
        SystemCache.populate_system_caches(
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          table: gm_table,
          relationships: rel_table,
          relationships_by_group: rbg_table
        )

      keys =
        RocksDB.cf_type_entities(rocks_name)
        |> RocksDB.full_iterator(name: rocks_name)
        |> Enum.map(fn {k, _v} -> k end)

      assert keys == []
    end

    test "rebuilds RelationshipCache from cf_actions + cf_type_entities", %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      rel_table: rel_table,
      rbg_table: rbg_table
    } do
      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "rel_demo",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "doc_demo", "update_id" => "u1"},
                "target_id" => %{"value" => "grp_demo", "update_id" => "u1"},
                "type" => %{"value" => "text_document", "update_id" => "u1"},
                "field" => %{"value" => "ownedBy", "update_id" => "u1"}
              }
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      # Simulate fresh server start: clear the cache but leave the
      # persistent indexes alone.
      RelationshipCache.reset(relationships: rel_table, relationships_by_group: rbg_table)

      assert RelationshipCache.get_entity_group("doc_demo", rel_table) == nil

      :ok =
        SystemCache.populate_system_caches(
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          table: gm_table,
          relationships: rel_table,
          relationships_by_group: rbg_table
        )

      assert RelationshipCache.get_entity_group("doc_demo", rel_table) == "grp_demo"
      assert RelationshipCache.get_group_entities("grp_demo", rbg_table) == ["doc_demo"]
    end
  end
end
