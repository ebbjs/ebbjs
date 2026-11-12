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
      assert ComponentEntityIndex.component_entry_ids("groupMember", opts) == ["gm_test"]
      assert ComponentEntityIndex.component_entry_ids("groupMember/actor_id", opts) == ["gm_test"]
      assert ComponentEntityIndex.component_entry_ids("entityGroup", opts) == ["eg_test"]
      assert ComponentEntityIndex.component_entry_ids("relationship", opts) == ["rel_test"]

      assert ComponentEntityIndex.component_entry_ids("relationship/target_id", opts) == [
               "rel_test"
             ]
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

    test "rebuilds the caches from the action log", ctx do
      %{writer_name: writer_name, eg_table: eg_table} = ctx

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

      # Simulate fresh server start: the caches and the derived index are
      # empty, but the action log is intact.
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

      assert EntityGroupCache.entity_groups("doc_demo", eg_table) == []

      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert EntityGroupCache.entity_groups("doc_demo", eg_table) == ["grp_demo"]
      assert RelationshipCache.get_relationship("rel_demo", ctx.rbi_table) != nil

      opts = index_opts(ctx)
      assert ComponentEntityIndex.component_entry_ids("entityGroup", opts) == ["eg_demo"]
      assert ComponentEntityIndex.component_entry_ids("entityGroup/group_id", opts) == ["eg_demo"]
      assert ComponentEntityIndex.component_entry_ids("relationship", opts) == ["rel_demo"]
    end

    # #264 Option A: every existing entity's type must be resolvable after
    # a restart, otherwise the authorizer fails closed on membership adds.
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

      # The seed discovers both rows in the action log; no entity actions
      # exist, so materialization falls back to the SQLite snapshot.
      for {id, gsn} <- Enum.with_index(["gm_partial_aaa_valid", "gm_partial_zzz_bad"], 1) do
        frame =
          TestHelpers.validated_action(%{
            updates: [
              TestHelpers.validated_component(id, "groupMember/actor_id", %{
                "value" => "a_partial"
              })
            ]
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
            TestHelpers.validated_component("gm_exit", "groupMember/actor_id", %{
              "value" => "a_exit"
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

      # The index is derived state; a boot starts without it.
      ComponentEntityIndex.reset(index_opts(ctx))
      EntityTypeCache.reset(entity_types: ctx.entity_types_table)

      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])
      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      opts = index_opts(ctx)

      for name <- ["todo", "todo/title", "todo/body"] do
        assert ComponentEntityIndex.component_entry_ids(name, opts) == [entity_id]
      end

      assert EntityTypeCache.get_type(entity_id, ctx.entity_types_table) == "todo"

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      # One modeled row discovered during the `:entity_types` phase.
      assert measurements.entity_types == 1
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

    test "seeds from an Action stored in a frame", ctx do
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

      opts = index_opts(ctx)
      assert ComponentEntityIndex.component_entry_ids("todo", opts) == [entity_id]
      assert ComponentEntityIndex.component_entry_ids("todo/title", opts) == [entity_id]
      assert EntityTypeCache.get_type(entity_id, ctx.entity_types_table) == "todo"
    end

    test "re-reads the action log on every boot (no marker skip)", ctx do
      :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert :not_found =
               RocksDB.get(
                 RocksDB.cf_default(ctx.rocks_name),
                 "system_cache:component_entities_backfill",
                 name: ctx.rocks_name
               )

      # A corrupt Action in the log must fail the second boot too: the seed
      # is the index's constructor, not a migration to skip.
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
