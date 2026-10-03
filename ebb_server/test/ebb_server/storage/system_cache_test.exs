defmodule EbbServer.Storage.SystemCacheTest do
  @moduledoc """
  Tests for SystemCache — specifically the startup `populate_system_caches`
  logic that rebuilds `GroupCache`, `EntityGroupCache`, and
  `RelationshipCache` from the persistent index, plus the
  `backfill_type_entities` step that reconciles the type-entities index
  against the action log.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    EntityGroupCache,
    RelationshipCache,
    RocksDB,
    SystemCache,
    Writer
  }

  alias EbbServer.TestHelpers

  setup do
    unique = System.unique_integer([:positive])

    %{
      dirty_set: dirty_set,
      group_members: gm_table,
      group_members_by_id: gm_by_id_table,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id_table,
      entity_groups_by_group: eg_by_group_table,
      relationships: rel_table,
      relationships_by_id: rbi_table
    } = TestHelpers.start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = TestHelpers.start_rocks(%{test: "sys_cache_#{unique}"})

    %{name: sqlite_name} = TestHelpers.start_sqlite(rocks_dir)

    %{name: writer_name} =
      TestHelpers.start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: :atomics.new(1, signed: false),
        group_members: gm_table,
        group_members_by_id: gm_by_id_table,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table,
        relationships: rel_table,
        relationships_by_id: rbi_table
      })

    %{
      dirty_set: dirty_set,
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      gm_by_id_table: gm_by_id_table,
      eg_table: eg_table,
      eg_by_id_table: eg_by_id_table,
      eg_by_group_table: eg_by_group_table,
      rel_table: rel_table,
      rbi_table: rbi_table
    }
  end

  defp populate_opts(ctx) do
    [
      rocks_name: ctx.rocks_name,
      sqlite_name: ctx.sqlite_name,
      dirty_set: ctx[:dirty_set],
      table: ctx.gm_table,
      entity_groups: ctx.eg_table,
      entity_groups_by_id: ctx.eg_by_id_table,
      entity_groups_by_group: ctx.eg_by_group_table,
      relationships: ctx.rel_table,
      relationships_by_id: ctx.rbi_table
    ]
  end

  describe "populate_system_caches/0" do
    # This is the regression test for the user-reported bug: when
    # cf_type_entities entries are missing (e.g. written by an older
    # version of the Writer, or wiped by a manual data fix-up), the
    # startup rebuild must still populate the membership cache so
    # subsequent writes to that entity index into the right group's
    # action stream.
    test "re-populates membership and relationship caches after cf_type_entities is wiped", %{
      dirty_set: dirty_set,
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      eg_table: eg_table,
      eg_by_id_table: eg_by_id_table,
      eg_by_group_table: eg_by_group_table,
      rel_table: rel_table,
      rbi_table: rbi_table
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
            subject_id: "eg_test",
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"value" => "doc_test", "update_id" => "u1"},
                "group_id" => %{"value" => "grp_test", "update_id" => "u1"}
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
                "target_id" => %{"value" => "author_1", "update_id" => "u1"},
                "type" => %{"value" => "text_document", "update_id" => "u1"},
                "field" => %{"value" => "author", "update_id" => "u1"}
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
      # groupMember, entityGroup, and relationship have been wiped, but
      # the action log still contains them.
      :ok = :rocksdb.delete(db_ref, cf_type, "groupMember\0gm_test", [])
      :ok = :rocksdb.delete(db_ref, cf_type, "entityGroup\0eg_test", [])
      :ok = :rocksdb.delete(db_ref, cf_type, "relationship\0rel_test", [])

      # Caches should also be empty now (simulating a fresh server start).
      RelationshipCache.reset(relationships: rel_table, relationships_by_id: rbi_table)
      EntityGroupCache.reset(entity_groups: eg_table, entity_groups_by_id: eg_by_id_table)

      assert EntityGroupCache.entity_groups("doc_test", eg_table) == []

      # Run the cache rebuild.
      :ok =
        SystemCache.populate_system_caches(
          populate_opts(%{
            rocks_name: rocks_name,
            sqlite_name: sqlite_name,
            dirty_set: dirty_set,
            gm_table: gm_table,
            eg_table: eg_table,
            eg_by_id_table: eg_by_id_table,
            eg_by_group_table: eg_by_group_table,
            rel_table: rel_table,
            rbi_table: rbi_table
          })
        )

      # The membership must be back in the cache. Subsequent writes to
      # doc_test will now index into grp_test's action stream.
      assert EntityGroupCache.entity_groups("doc_test", eg_table) == ["grp_test"]
      assert EntityGroupCache.get_entity_group("eg_test", eg_by_id_table).group_id == "grp_test"

      # And the relationship must be back too.
      assert RelationshipCache.get_relationship("rel_test", rbi_table).target_id == "author_1"

      # And the cf_type_entities index must be repaired too, so a
      # second restart (without further writes) still rebuilds
      # correctly.
      assert RocksDB.get(cf_type, "relationship\0rel_test", name: rocks_name) == {:ok, <<>>}
      assert RocksDB.get(cf_type, "groupMember\0gm_test", name: rocks_name) == {:ok, <<>>}
      assert RocksDB.get(cf_type, "entityGroup\0eg_test", name: rocks_name) == {:ok, <<>>}
    end

    test "is a no-op when cf_type_entities is already in sync", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      eg_table: eg_table,
      eg_by_id_table: eg_by_id_table,
      eg_by_group_table: eg_by_group_table,
      rel_table: rel_table,
      rbi_table: rbi_table
    } do
      # No actions written; cf_actions and cf_type_entities are both
      # empty. populate_system_caches should write nothing.
      :ok =
        SystemCache.populate_system_caches(
          populate_opts(%{
            rocks_name: rocks_name,
            sqlite_name: sqlite_name,
            gm_table: gm_table,
            eg_table: eg_table,
            eg_by_id_table: eg_by_id_table,
            eg_by_group_table: eg_by_group_table,
            rel_table: rel_table,
            rbi_table: rbi_table
          })
        )

      keys =
        RocksDB.cf_type_entities(rocks_name)
        |> RocksDB.full_iterator(name: rocks_name)
        |> Enum.map(fn {k, _v} -> k end)

      assert keys == []
    end

    test "rebuilds the caches from cf_type_entities", %{
      dirty_set: dirty_set,
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      eg_table: eg_table,
      eg_by_id_table: eg_by_id_table,
      eg_by_group_table: eg_by_group_table,
      rel_table: rel_table,
      rbi_table: rbi_table
    } do
      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "eg_demo",
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"value" => "doc_demo", "update_id" => "u1"},
                "group_id" => %{"value" => "grp_demo", "update_id" => "u1"}
              }
            }
          },
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "rel_demo",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "doc_demo", "update_id" => "u1"},
                "target_id" => %{"value" => "author_demo", "update_id" => "u1"},
                "type" => %{"value" => "text_document", "update_id" => "u1"},
                "field" => %{"value" => "author", "update_id" => "u1"}
              }
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      # Simulate fresh server start: clear the caches but leave the
      # persistent indexes alone.
      RelationshipCache.reset(relationships: rel_table, relationships_by_id: rbi_table)
      EntityGroupCache.reset(entity_groups: eg_table, entity_groups_by_id: eg_by_id_table)

      assert EntityGroupCache.entity_groups("doc_demo", eg_table) == []

      :ok =
        SystemCache.populate_system_caches(
          populate_opts(%{
            rocks_name: rocks_name,
            sqlite_name: sqlite_name,
            dirty_set: dirty_set,
            gm_table: gm_table,
            eg_table: eg_table,
            eg_by_id_table: eg_by_id_table,
            eg_by_group_table: eg_by_group_table,
            rel_table: rel_table,
            rbi_table: rbi_table
          })
        )

      assert EntityGroupCache.entity_groups("doc_demo", eg_table) == ["grp_demo"]
      assert RelationshipCache.get_relationship("rel_demo", rbi_table) != nil
    end
  end
end
