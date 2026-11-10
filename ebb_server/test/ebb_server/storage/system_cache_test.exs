defmodule EbbServer.Storage.SystemCacheTest do
  @moduledoc """
  Tests for SystemCache — specifically the startup `populate_system_caches`
  logic that rebuilds `GroupCache`, `EntityGroupCache`, and
  `RelationshipCache` from the persistent index, plus the
  `backfill_component_entities` step that reconciles the component-entities
  index against the action log.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionFormat,
    DirtyTracker,
    EntityGroupCache,
    EntityStore,
    EntityTypeCache,
    GroupAppsCache,
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
      group_members_by_id: gm_by_id_table,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id_table,
      entity_groups_by_group: eg_by_group_table,
      entity_types: entity_types_table,
      group_apps: group_apps_table,
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
      entity_types_table: entity_types_table,
      group_apps_table: group_apps_table,
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
      entity_types: ctx[:entity_types_table],
      group_apps: ctx[:group_apps_table],
      relationships: ctx.rel_table,
      relationships_by_id: ctx.rbi_table
    ]
  end

  describe "populate_system_caches/0" do
    # This is the regression test for the user-reported bug: when
    # cf_component_entities model entries are missing (e.g. written by an older
    # version of the Writer, or wiped by a manual data fix-up), the
    # startup rebuild must still populate the membership cache so
    # subsequent writes to that entity index into the right group's
    # action stream.
    test "re-populates membership and relationship caches after the model entries are wiped", %{
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
        updates:
          [
            TestHelpers.validated_component("grp_test", "group/name", %{
              "value" => "Test",
              "update_id" => "u1"
            })
          ] ++
            [
              TestHelpers.validated_component("gm_test", "groupMember/actor_id", %{
                "value" => "demo-seeder",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("gm_test", "groupMember/group_id", %{
                "value" => "grp_test",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("gm_test", "groupMember/permissions", %{
                "value" => ["group.*"],
                "update_id" => "u1"
              })
            ] ++
            [
              TestHelpers.validated_component("eg_test", "entityGroup/entity_id", %{
                "value" => "doc_test",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("eg_test", "entityGroup/group_id", %{
                "value" => "grp_test",
                "update_id" => "u1"
              })
            ] ++
            [
              TestHelpers.validated_component("rel_test", "relationship/source_id", %{
                "value" => "doc_test",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_test", "relationship/target_id", %{
                "value" => "author_1",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_test", "relationship/type", %{
                "value" => "text_document",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_test", "relationship/field", %{
                "value" => "author",
                "update_id" => "u1"
              })
            ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf = RocksDB.cf_component_entities(rocks_name)
      db_ref = RocksDB.db_ref(rocks_name)

      # Confirm writer populated cf_component_entities.
      assert RocksDB.get(cf, "relationship\0rel_test", name: rocks_name) == {:ok, <<>>}

      # Simulate the broken state: the model entries for the groupMember,
      # entityGroup, and relationship have been wiped, but the action log
      # still contains them.
      :ok = :rocksdb.delete(db_ref, cf, "groupMember\0gm_test", [])
      :ok = :rocksdb.delete(db_ref, cf, "entityGroup\0eg_test", [])
      :ok = :rocksdb.delete(db_ref, cf, "relationship\0rel_test", [])

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

      # And the index must be repaired too, so a second restart (without
      # further writes) still rebuilds correctly.
      assert RocksDB.get(cf, "relationship\0rel_test", name: rocks_name) == {:ok, <<>>}
      assert RocksDB.get(cf, "groupMember\0gm_test", name: rocks_name) == {:ok, <<>>}
      assert RocksDB.get(cf, "entityGroup\0eg_test", name: rocks_name) == {:ok, <<>>}
    end

    test "fills GroupAppsCache from the group rows on boot",
         %{writer_name: writer_name, group_apps_table: group_apps_table} = ctx do
      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          TestHelpers.validated_component("grp_apps", "group/name", %{
            "value" => "Scoped",
            "update_id" => "u1",
            "hlc" => hlc
          }),
          TestHelpers.validated_component(
            "grp_apps",
            "group/apps",
            %{
              "map" => %{
                "notes" => %{"value" => true, "update_id" => "u1", "hlc" => hlc}
              }
            },
            method: :merge
          )
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      GroupAppsCache.reset(group_apps: group_apps_table)
      assert GroupAppsCache.get_apps("grp_apps", group_apps_table) == :unscoped
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert GroupAppsCache.get_apps("grp_apps", group_apps_table) == MapSet.new(["notes"])

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.group_apps == 1
    end

    test "is a no-op when cf_component_entities is already in sync", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      gm_table: gm_table,
      eg_table: eg_table,
      eg_by_id_table: eg_by_id_table,
      eg_by_group_table: eg_by_group_table,
      rel_table: rel_table,
      rbi_table: rbi_table
    } do
      # No actions written; cf_actions and cf_component_entities are both
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
        RocksDB.cf_component_entities(rocks_name)
        |> RocksDB.full_iterator(name: rocks_name)
        |> Enum.map(fn {k, _v} -> k end)

      assert keys == []
    end

    test "rebuilds the caches from cf_component_entities", %{
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
        updates:
          [
            TestHelpers.validated_component("eg_demo", "entityGroup/entity_id", %{
              "value" => "doc_demo",
              "update_id" => "u1"
            }),
            TestHelpers.validated_component("eg_demo", "entityGroup/group_id", %{
              "value" => "grp_demo",
              "update_id" => "u1"
            })
          ] ++
            [
              TestHelpers.validated_component("rel_demo", "relationship/source_id", %{
                "value" => "doc_demo",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_demo", "relationship/target_id", %{
                "value" => "author_demo",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_demo", "relationship/type", %{
                "value" => "text_document",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("rel_demo", "relationship/field", %{
                "value" => "author",
                "update_id" => "u1"
              })
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

    # #264 Option A: every existing entity's type must be resolvable after
    # a restart, otherwise the authorizer fails closed on membership adds.
    test "repopulates the entity-type cache from the model entries", %{
      dirty_set: dirty_set,
      writer_name: writer_name,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      entity_types_table: entity_types_table,
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
        updates:
          [
            TestHelpers.validated_component(
              "todo_typed",
              "todo/title",
              %{"value" => "Typed", "hlc" => hlc},
              id: "upd_typed"
            )
          ] ++
            [
              TestHelpers.validated_component("eg_typed", "entityGroup/entity_id", %{
                "value" => "todo_typed",
                "update_id" => "u1"
              }),
              TestHelpers.validated_component("eg_typed", "entityGroup/group_id", %{
                "value" => "grp_typed",
                "update_id" => "u1"
              })
            ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      EntityTypeCache.reset(entity_types: entity_types_table)
      assert EntityTypeCache.get_type("todo_typed", entity_types_table) == nil

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
            entity_types_table: entity_types_table,
            rel_table: rel_table,
            rbi_table: rbi_table
          })
        )

      assert EntityTypeCache.get_type("todo_typed", entity_types_table) == "todo"
      assert EntityTypeCache.get_type("eg_typed", entity_types_table) == "entityGroup"
    end

    test "the boot walk reads model entries and ignores component entries",
         %{
           writer_name: writer_name,
           rocks_name: rocks_name,
           entity_types_table: entity_types_table
         } = ctx do
      subject_id = "todo_component_entry_#{System.unique_integer([:positive])}"

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(subject_id, "todo/title", %{"value" => "Title"}),
            TestHelpers.validated_component(subject_id, "todo/body", %{"value" => "Body"})
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      # The first boot completes the migration, so the second boot only walks
      # the index and cannot fall back to the action log.
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))
      EntityTypeCache.reset(entity_types: entity_types_table)

      :ok =
        :rocksdb.delete(
          RocksDB.db_ref(rocks_name),
          RocksDB.cf_component_entities(rocks_name),
          RocksDB.encode_component_entity_key("todo", subject_id),
          []
        )

      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      # The row's component entries are still there; only a model entry names
      # the committed model, so nothing is indexed from them.
      assert EntityTypeCache.get_type(subject_id, entity_types_table) == nil

      for field <- ["title", "body"] do
        assert {:ok, <<>>} =
                 RocksDB.get(
                   RocksDB.cf_component_entities(rocks_name),
                   RocksDB.encode_component_entity_key("todo/#{field}", subject_id),
                   name: rocks_name
                 )
      end

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.entity_types == 0
      assert measurements.backfilled == 0
    end
  end

  describe "startup telemetry" do
    test "emits per-cache counts, a duration, and outcome :ok", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert is_integer(measurements.duration)
      assert measurements.entity_types == 0
      assert measurements.group_members == 0
      assert measurements.entity_groups == 0
      assert measurements.group_apps == 0
      assert measurements.relationships == 0
      assert measurements.backfilled == 0
    end

    test "reports the counts reached and outcome :error when the action log cannot be decoded",
         ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      # One indexed entity clears the entity-type phase; the corrupt Action
      # then detonates `binary_to_term/2` during the backfill. The old code
      # rescued that and still reported healthy.
      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_component_entities(ctx.rocks_name),
          RocksDB.encode_component_entity_key("todo", "todo_partial"),
          <<>>,
          []
        )

      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_actions(ctx.rocks_name),
          RocksDB.encode_gsn_key(1),
          <<0, 1, 2>>,
          []
        )

      assert_raise ArgumentError, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: reason}}
             ] = TestHelpers.telemetry_events(ref)

      assert reason == ArgumentError
      assert is_integer(measurements.duration)
      assert measurements.entity_types == 1
      assert measurements.group_members == 0
      assert measurements.backfilled == 0
    end

    test "reports the failing phase's progress, not just completed phases", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])
      cf = RocksDB.cf_component_entities(ctx.rocks_name)
      db = RocksDB.db_ref(ctx.rocks_name)

      valid_data =
        Jason.encode!(%{
          "fields" => %{
            "actor_id" => %{"value" => "a_partial"},
            "group_id" => %{"value" => "g_partial"},
            "permissions" => %{"value" => ["group.read"]}
          }
        })

      :ok = SQLite.upsert_entity(entity_row("gm_partial_aaa_valid", valid_data), ctx.sqlite_name)
      # A non-map JSON payload survives materialization but breaks
      # `Fields.get/2` in the groupMember insert, aborting the phase after
      # the first row is cached.
      :ok = SQLite.upsert_entity(entity_row("gm_partial_zzz_bad", "[1,2,3]"), ctx.sqlite_name)

      for id <- ["gm_partial_aaa_valid", "gm_partial_zzz_bad"] do
        :ok =
          :rocksdb.put(db, cf, RocksDB.encode_component_entity_key("groupMember", id), <<>>, [])
      end

      assert_raise FunctionClauseError, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: reason}}
             ] = TestHelpers.telemetry_events(ref)

      assert reason == FunctionClauseError
      assert measurements.entity_types == 2
      assert measurements.group_members == 1
      assert measurements.entity_groups == 0
    end

    test "emits outcome :error when the rebuild fails before the first phase", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      # No RocksDB is registered under this name, so the marker read raises
      # before any phase runs. The failure must still be observable.
      opts = Keyword.put(populate_opts(ctx), :rocks_name, :ebb_421_missing_rocks)

      assert_raise ArgumentError, fn -> SystemCache.populate_system_caches(opts) end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: reason}}
             ] = TestHelpers.telemetry_events(ref)

      assert reason == ArgumentError
      assert measurements.entity_types == 0
      assert measurements.backfilled == 0
    end

    test "reports an exit as a safe failure class, not the exit term", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_component_entities(ctx.rocks_name),
          RocksDB.encode_component_entity_key("groupMember", "gm_exit"),
          <<>>,
          []
        )

      :ok = GenServer.stop(Process.whereis(ctx.sqlite_name))

      assert catch_exit(SystemCache.populate_system_caches(populate_opts(ctx)))

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: :exit}}
             ] = TestHelpers.telemetry_events(ref)

      assert measurements.group_members == 0
    end
  end

  describe "component-entities backfill migration" do
    # #564: the backfill can add index keys the earlier walk never saw, so
    # those rows must be marked dirty too — otherwise the migration boot
    # re-indexes the entity but still serves it as missing.
    test "marks a backfill-added index key dirty so its row is served", ctx do
      entity_id = "todo_backfill_#{System.unique_integer([:positive])}"
      hlc = TestHelpers.generate_hlc()

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(
              entity_id,
              "todo/title",
              %{"value" => "Backfilled", "hlc" => hlc}
            )
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

      # Simulate an index entry the Writer never wrote: the walk cannot see
      # it, only the backfill can restore it.
      :ok =
        :rocksdb.delete(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_component_entities(ctx.rocks_name),
          RocksDB.encode_component_entity_key("todo", entity_id),
          []
        )

      DirtyTracker.reset(ctx.dirty_set)
      refute DirtyTracker.dirty?(entity_id, ctx.dirty_set)
      assert EntityStore.get(entity_id, "a_test", entity_store_opts(ctx)) == :not_found

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert {:ok, <<>>} =
               RocksDB.get(
                 RocksDB.cf_component_entities(ctx.rocks_name),
                 RocksDB.encode_component_entity_key("todo", entity_id),
                 name: ctx.rocks_name
               )

      assert DirtyTracker.dirty?(entity_id, ctx.dirty_set)

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", entity_store_opts(ctx))
      assert entity.last_gsn == 1
      assert entity.data["fields"]["title"]["value"] == "Backfilled"
    end

    test "reconstructs both model and component entries from cf_actions", ctx do
      entity_id = "todo_rebuild_#{System.unique_integer([:positive])}"
      hlc = TestHelpers.generate_hlc()

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(entity_id, "todo/title", %{
              "value" => "Title",
              "hlc" => hlc
            }),
            TestHelpers.validated_component(entity_id, "todo/body", %{
              "value" => "Body",
              "hlc" => hlc
            })
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

      cf = RocksDB.cf_component_entities(ctx.rocks_name)

      # Simulate an index written before components were indexed: the model
      # entry and every component entry are missing.
      for name <- ["todo", "todo/title", "todo/body"] do
        :ok =
          :rocksdb.delete(
            RocksDB.db_ref(ctx.rocks_name),
            cf,
            RocksDB.encode_component_entity_key(name, entity_id),
            []
          )
      end

      EntityTypeCache.reset(entity_types: ctx.entity_types_table)

      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])
      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      for name <- ["todo", "todo/title", "todo/body"] do
        assert {:ok, <<>>} =
                 RocksDB.get(cf, RocksDB.encode_component_entity_key(name, entity_id),
                   name: ctx.rocks_name
                 )
      end

      assert EntityTypeCache.get_type(entity_id, ctx.entity_types_table) == "todo"

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.backfilled == 3
    end

    test "does not restore a component the log dropped", ctx do
      entity_id = "todo_dropped_backfill_#{System.unique_integer([:positive])}"
      hlc = TestHelpers.generate_hlc()

      write =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(entity_id, "todo/title", %{
              "value" => "Title",
              "hlc" => hlc
            })
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([write], ctx.writer_name)

      drop =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_update(%{subject_id: entity_id, method: :drop, data: nil})
          ]
        })

      assert {:ok, {2, 2}, []} = Writer.write_actions([drop], ctx.writer_name)

      cf = RocksDB.cf_component_entities(ctx.rocks_name)

      :ok =
        :rocksdb.delete(
          RocksDB.db_ref(ctx.rocks_name),
          cf,
          RocksDB.encode_component_entity_key("todo", entity_id),
          []
        )

      EntityTypeCache.reset(entity_types: ctx.entity_types_table)
      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      # The model entry is existence; the dropped component stays absent.
      assert {:ok, <<>>} =
               RocksDB.get(cf, RocksDB.encode_component_entity_key("todo", entity_id),
                 name: ctx.rocks_name
               )

      assert :not_found =
               RocksDB.get(cf, RocksDB.encode_component_entity_key("todo/title", entity_id),
                 name: ctx.rocks_name
               )
    end

    test "backfills from an Action stored in a frame", ctx do
      entity_id = "todo_frame_#{:erlang.unique_integer([:positive])}"
      action_id = "act_frame_#{:erlang.unique_integer([:positive])}"

      payload =
        %{
          id: action_id,
          actor_id: "demo-seeder",
          hlc: TestHelpers.generate_hlc(),
          updates: [
            TestHelpers.validated_component(
              entity_id,
              "todo/title",
              %{"value" => "Framed"},
              id: "upd_frame_#{:erlang.unique_integer([:positive])}"
            )
          ]
        }
        |> ActionFormat.build()
        |> ActionFormat.encode()

      frame = ActionFormat.frame(payload, [[]])

      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_actions(ctx.rocks_name), RocksDB.encode_gsn_key(1), frame}],
          name: ctx.rocks_name
        )

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert {:ok, <<>>} =
               RocksDB.get(
                 RocksDB.cf_component_entities(ctx.rocks_name),
                 RocksDB.encode_component_entity_key("todo", entity_id),
                 name: ctx.rocks_name
               )

      assert EntityTypeCache.get_type(entity_id, ctx.entity_types_table) == "todo"
    end

    test "writes a durable marker and skips the action-log scan on later boots", ctx do
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert {:ok, "v2"} =
               RocksDB.get(
                 RocksDB.cf_default(ctx.rocks_name),
                 "system_cache:component_entities_backfill",
                 name: ctx.rocks_name
               )

      # A corrupt action would raise if the second populate still walked
      # cf_actions. It does not, so the migration was skipped.
      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_actions(ctx.rocks_name),
          RocksDB.encode_gsn_key(1),
          <<0, 1, 2>>,
          []
        )

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))
    end

    test "a stale marker version forces the backfill to run again", ctx do
      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_default(ctx.rocks_name),
          "system_cache:component_entities_backfill",
          "v1",
          []
        )

      # The stale version means the backfill is not skipped, so the
      # corrupt Action is decoded and raises.
      :ok =
        :rocksdb.put(
          RocksDB.db_ref(ctx.rocks_name),
          RocksDB.cf_actions(ctx.rocks_name),
          RocksDB.encode_gsn_key(1),
          <<0, 1, 2>>,
          []
        )

      assert_raise ArgumentError, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end
    end
  end

  defp entity_store_opts(ctx) do
    [rocks_name: ctx.rocks_name, sqlite_name: ctx.sqlite_name, dirty_set: ctx.dirty_set]
  end

  defp entity_row(id, data) do
    %{
      id: id,
      type: "groupMember",
      data: data,
      created_hlc: 0,
      updated_hlc: 0,
      deleted_hlc: nil,
      deleted_by: nil,
      last_gsn: 0
    }
  end
end
