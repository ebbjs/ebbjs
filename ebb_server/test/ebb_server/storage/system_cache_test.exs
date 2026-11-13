defmodule EbbServer.Storage.SystemCacheTest do
  @moduledoc """
  Tests for SystemCache — specifically the startup `populate_system_caches`
  logic that rebuilds the derived component existence index and the
  `GroupCache`, `EntityGroupCache`, and `RelationshipCache` contents from the
  action log.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionFormat,
    ComponentEntityIndex,
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
      component_index: component_index_table,
      component_entity_labels: component_entity_labels_table,
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
        component_index: component_index_table,
        component_entity_labels: component_entity_labels_table,
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
      component_index: component_index_table,
      component_entity_labels: component_entity_labels_table,
      group_apps_table: group_apps_table,
      rel_table: rel_table,
      rbi_table: rbi_table
    }
  end

  defp index_opts(ctx) do
    [
      component_index: ctx.component_index,
      component_entity_labels: ctx.component_entity_labels
    ]
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
      component_index: ctx[:component_index],
      component_entity_labels: ctx[:component_entity_labels],
      group_apps: ctx[:group_apps_table],
      relationships: ctx.rel_table,
      relationships_by_id: ctx.rbi_table
    ]
  end

  describe "populate_system_caches/0" do
    # The action log is the source of truth for the derived index, so a boot
    # that starts with empty in-memory state still rebuilds the membership and
    # relationship caches from it (#564, #849).
    test "rebuilds membership and relationship caches from the action log", ctx do
      %{writer_name: writer_name, eg_table: eg_table} = ctx

      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          TestHelpers.validated_component("grp_test", "ebb/group", %{
            "value" => %{"name" => "Test"},
            "update_id" => "u1"
          }),
          TestHelpers.validated_component("gm_test", "ebb/grant", %{
            "value" => %{
              "actor_id" => "demo-seeder",
              "group_id" => "grp_test",
              "permissions" => ["ebb/group.*"]
            },
            "update_id" => "u1"
          }),
          TestHelpers.validated_component("eg_test", "ebb/membership", %{
            "value" => %{"entity_id" => "doc_test", "group_id" => "grp_test"},
            "update_id" => "u1"
          }),
          TestHelpers.validated_component("rel_test", "ebb/link", %{
            "value" => %{
              "source_id" => "doc_test",
              "target_id" => "author_1",
              "type" => "text_document",
              "field" => "author"
            },
            "update_id" => "u1"
          })
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      # A restart loses every derived cache but keeps the action log.
      RelationshipCache.reset(
        relationships: ctx.rel_table,
        relationships_by_id: ctx.rbi_table
      )

      EntityGroupCache.reset(
        entity_groups: ctx.eg_table,
        entity_groups_by_id: ctx.eg_by_id_table
      )

      ComponentEntityIndex.reset(index_opts(ctx))
      EntityTypeCache.reset(entity_types: ctx.entity_types_table)

      assert EntityGroupCache.entity_groups("doc_test", eg_table) == []

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      # The membership is back in the cache. Subsequent writes to doc_test
      # will now index into grp_test's action stream.
      assert EntityGroupCache.entity_groups("doc_test", eg_table) == ["grp_test"]

      assert EntityGroupCache.get_entity_group("eg_test", ctx.eg_by_id_table).group_id ==
               "grp_test"

      assert RelationshipCache.get_relationship("rel_test", ctx.rbi_table).target_id == "author_1"

      # The seed reconstructed both key kinds, so a second restart without
      # further writes still rebuilds correctly.
      opts = index_opts(ctx)
      # Every platform row commits under the model `ebb`; the component entry
      # is what distinguishes the four kinds.
      assert ComponentEntityIndex.component_entry_ids("ebb", opts) == [
               "eg_test",
               "gm_test",
               "grp_test",
               "rel_test"
             ]

      assert ComponentEntityIndex.component_entry_ids("ebb/grant", opts) == ["gm_test"]
      assert ComponentEntityIndex.component_entry_ids("ebb/membership", opts) == ["eg_test"]
      assert ComponentEntityIndex.component_entry_ids("ebb/link", opts) == ["rel_test"]
      assert ComponentEntityIndex.component_entry_ids("ebb/group", opts) == ["grp_test"]
    end

    test "fills GroupAppsCache from the group rows on boot",
         %{writer_name: writer_name, group_apps_table: group_apps_table} = ctx do
      hlc = TestHelpers.generate_hlc()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "demo-seeder",
        hlc: hlc,
        updates: [
          TestHelpers.validated_component("grp_apps", "ebb/group", %{
            "value" => %{"name" => "Scoped", "apps" => ["notes"]},
            "update_id" => "u1",
            "hlc" => hlc
          })
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

    test "leaves an empty action log with an empty index and no marker", ctx do
      # No actions written, so the seed has nothing to rebuild.
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert ComponentEntityIndex.size(index_opts(ctx)) == 0

      # The index is derived state, so there is no durable completion marker.
      assert :not_found =
               RocksDB.get(
                 RocksDB.cf_default(ctx.rocks_name),
                 "system_cache:component_entities_backfill",
                 name: ctx.rocks_name
               )
    end

    test "repopulates the entity-type cache from the action log", ctx do
      %{writer_name: writer_name, entity_types_table: entity_types_table} = ctx

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
      ComponentEntityIndex.reset(index_opts(ctx))
      assert EntityTypeCache.get_type("todo_typed", entity_types_table) == nil

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert EntityTypeCache.get_type("todo_typed", entity_types_table) == "todo"
      assert EntityTypeCache.get_type("eg_typed", entity_types_table) == "entityGroup"
    end

    test "a second boot rebuilds the index identically from the log", ctx do
      %{writer_name: writer_name} = ctx
      subject_id = "todo_component_entry_#{System.unique_integer([:positive])}"

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(subject_id, "todo/title", %{"value" => "Title"}),
            TestHelpers.validated_component(subject_id, "todo/body", %{"value" => "Body"})
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      names = ["todo", "todo/title", "todo/body"]
      first_boot = Enum.map(names, &ComponentEntityIndex.component_entry_ids(&1, index_opts(ctx)))
      assert EntityTypeCache.get_type(subject_id, ctx.entity_types_table) == "todo"

      # A restart loses the derived state, not the log the seed reads.
      ComponentEntityIndex.reset(index_opts(ctx))
      EntityTypeCache.reset(entity_types: ctx.entity_types_table)
      assert ComponentEntityIndex.size(index_opts(ctx)) == 0

      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      second_boot =
        Enum.map(names, &ComponentEntityIndex.component_entry_ids(&1, index_opts(ctx)))

      assert second_boot == first_boot
      assert EntityTypeCache.get_type(subject_id, ctx.entity_types_table) == "todo"

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      # The seed counts modeled rows as it discovers them in the log.
      assert measurements.entity_types == 1
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
    end

    test "reports the counts reached and outcome :error when the action log cannot be decoded",
         ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      # The corrupt Action detonates `binary_to_term/2` while the seed reads
      # the log, so the `:entity_types` phase fails before it counts a row.
      # The old code rescued that and still reported healthy.
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
      assert measurements.entity_types == 0
      assert measurements.group_members == 0
    end

    test "reports the failing phase's progress, not just completed phases", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      grant_data =
        Jason.encode!(%{
          "fields" => %{
            "grant" => %{
              "value" => %{
                "actor_id" => "a_partial",
                "group_id" => "g_partial",
                "permissions" => ["ebb/group.read"]
              }
            }
          }
        })

      membership_data =
        Jason.encode!(%{
          "fields" => %{
            "membership" => %{
              "value" => %{"entity_id" => "todo_partial", "group_id" => "g_partial"}
            }
          }
        })

      :ok = SQLite.upsert_entity(entity_row("gm_partial_aaa_valid", grant_data), ctx.sqlite_name)

      :ok =
        SQLite.upsert_entity(entity_row("eg_partial_zzz_valid", membership_data), ctx.sqlite_name)

      # The seed discovers both rows in the action log; no entity actions
      # exist, so materialization falls back to the SQLite snapshot. Both
      # phases get past the component index, and the membership phase raises
      # on its first cache write because its by-group table is gone — after
      # the entity-type and grant phases already reported progress.
      for {id, component, gsn} <- [
            {"gm_partial_aaa_valid", "ebb/grant", 1},
            {"eg_partial_zzz_valid", "ebb/membership", 2}
          ] do
        frame =
          TestHelpers.validated_action(%{
            updates: [TestHelpers.validated_component(id, component, %{"value" => %{}})]
          })
          |> ActionFormat.build()
          |> ActionFormat.encode()
          |> then(&ActionFormat.frame(&1, [[]]))

        :ok =
          RocksDB.write_batch(
            [{:put, RocksDB.cf_actions(ctx.rocks_name), RocksDB.encode_gsn_key(gsn), frame}],
            name: ctx.rocks_name
          )
      end

      # A cache table that disappears mid-boot must not be reported as a
      # healthy boot, and the phases that already ran stay observable.
      :ets.delete(ctx.eg_by_group_table)

      assert_raise ArgumentError, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: reason}}
             ] = TestHelpers.telemetry_events(ref)

      assert reason == ArgumentError
      assert measurements.entity_types == 2
      assert measurements.group_members == 1
      assert measurements.entity_groups == 0
    end

    test "emits outcome :error when the action log cannot be read", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      # No RocksDB is registered under this name, so reading the action log
      # raises in the first phase. The failure must still be observable.
      opts = Keyword.put(populate_opts(ctx), :rocks_name, :ebb_421_missing_rocks)

      assert_raise ArgumentError, fn -> SystemCache.populate_system_caches(opts) end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: reason}}
             ] = TestHelpers.telemetry_events(ref)

      assert reason == ArgumentError
      assert measurements.entity_types == 0
    end

    test "reports an exit as a safe failure class, not the exit term", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component("gm_exit", "ebb/grant", %{
              "value" => %{
                "actor_id" => "a_exit",
                "group_id" => "g_exit",
                "permissions" => ["ebb/group.read"]
              }
            })
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

      :ok = GenServer.stop(Process.whereis(ctx.sqlite_name))

      assert catch_exit(SystemCache.populate_system_caches(populate_opts(ctx)))

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: :exit}}
             ] = TestHelpers.telemetry_events(ref)

      assert measurements.group_members == 0
    end
  end

  describe "boot seed from the action log" do
    # #564: derived state is lost on a restart while the action log survives,
    # so a row that only the log knows must be re-indexed and marked dirty —
    # otherwise the boot re-indexes it but still serves it as missing.
    test "marks seeded rows dirty so a row only the log knows is served", ctx do
      entity_id = "todo_boot_#{System.unique_integer([:positive])}"
      hlc = TestHelpers.generate_hlc()

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(
              entity_id,
              "todo/title",
              %{"value" => "Bootstrapped", "hlc" => hlc}
            )
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], ctx.writer_name)

      # A restart loses the derived index; only the action log remains.
      ComponentEntityIndex.reset(index_opts(ctx))

      DirtyTracker.reset(ctx.dirty_set)
      refute DirtyTracker.dirty?(entity_id, ctx.dirty_set)
      assert EntityStore.get(entity_id, "a_test", entity_store_opts(ctx)) == :not_found

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      opts = index_opts(ctx)
      assert ComponentEntityIndex.component_entry_ids("todo", opts) == [entity_id]
      assert ComponentEntityIndex.component_entry_ids("todo/title", opts) == [entity_id]

      assert DirtyTracker.dirty?(entity_id, ctx.dirty_set)

      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", entity_store_opts(ctx))
      assert entity.last_gsn == 1
      assert entity.data["fields"]["title"]["value"] == "Bootstrapped"
    end

    test "does not restore a component the log dropped", ctx do
      entity_id = "todo_dropped_boot_#{System.unique_integer([:positive])}"
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

      ComponentEntityIndex.reset(index_opts(ctx))
      EntityTypeCache.reset(entity_types: ctx.entity_types_table)
      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      # The model entry is existence; the dropped component stays absent.
      opts = index_opts(ctx)
      assert ComponentEntityIndex.component_entry_ids("todo", opts) == [entity_id]
      assert ComponentEntityIndex.component_entry_ids("todo/title", opts) == []
    end

    test "a row delete leaves its model entry and stale component entries", ctx do
      entity_id = "todo_deleted_boot_#{System.unique_integer([:positive])}"
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

      delete =
        TestHelpers.validated_action(%{
          updates: [TestHelpers.validated_update(%{subject_id: entity_id, method: :delete})]
        })

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete], ctx.writer_name)

      ComponentEntityIndex.reset(index_opts(ctx))
      EntityTypeCache.reset(entity_types: ctx.entity_types_table)
      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      # A delete names the row, not its components, so the seed reproduces
      # the Writer's shape: model entry present, component entries stale.
      opts = index_opts(ctx)
      assert ComponentEntityIndex.component_entry_ids("todo", opts) == [entity_id]
      assert ComponentEntityIndex.component_entry_ids("todo/title", opts) == [entity_id]
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
