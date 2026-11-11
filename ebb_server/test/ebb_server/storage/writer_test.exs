defmodule EbbServer.Storage.WriterTest do
  @moduledoc """
  Behavioral tests for Writer - the action persistence layer.

  Writer receives validated actions and persists them to RocksDB,
  assigning GSNs (Global Sequence Numbers) for ordering.

  ## Key Behaviors Tested

  - GSN assignment: monotonic, gap-free sequence numbers
  - Column family population: all 5 RocksDB CFs written correctly
  - Dirty tracking: marks entities dirty for later materialization
  - System cache updates: GroupCache, RelationshipCache, and EntityGroupCache
    kept in sync
  - ETF serialization: actions encoded/decoded correctly
  - Durability: data survives restarts
  - Empty update filtering: actions with no updates are skipped

  ## Architecture Context

  Writer is a GenServer that receives pre-validated actions.
  It claims a GSN range from GsnCounter, writes to RocksDB,
  then updates DirtyTracker and system caches.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionFormat,
    ActionLog,
    ActionScope,
    ComponentEntityIndex,
    DirtyTracker,
    EntityGroupCache,
    EntityTypeCache,
    GroupCache,
    RelationshipCache,
    RocksDB,
    Writer
  }

  import EbbServer.TestHelpers

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    } = start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = start_rocks()

    %{name: writer_name} =
      start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: gsn_counter,
        group_members: group_members,
        group_members_by_id: group_members_by_id,
        entity_groups: entity_groups,
        entity_groups_by_id: entity_groups_by_id,
        entity_groups_by_group: entity_groups_by_group,
        relationships: relationships,
        relationships_by_id: relationships_by_id
      })

    %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      rocks_dir: rocks_dir,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    }
  end

  describe "committer pool lifecycle" do
    test "a normal Writer stop takes its Committer pool down", %{writer_name: writer_name} do
      pool = :sys.get_state(writer_name).committer_pool
      ref = Process.monitor(pool)

      :ok = GenServer.stop(Process.whereis(writer_name))

      assert_receive {:DOWN, ^ref, :process, ^pool, :normal}, 2_000
    end
  end

  describe "single action write" do
    test "returns correct GSN range and writes to cf_actions", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, binary} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      decoded = ActionFormat.decode(binary, 1)
      assert decoded["gsn"] == 1
    end
  end

  describe "GSN assignment is sequential" do
    test "assigns consecutive GSNs across multiple writes", %{
      writer_name: writer_name
    } do
      action1 = validated_action()
      action2 = validated_action()
      action3 = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action1], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([action2], writer_name)
      assert {:ok, {3, 3}, []} = Writer.write_actions([action3], writer_name)
    end
  end

  describe "the written column families are populated" do
    test "writes an action across the written column families", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update = validated_update(%{subject_id: "todo_test_123"})
      action = validated_action(%{updates: [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, stored_etf} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      decoded = ActionFormat.decode(stored_etf, 1)

      assert decoded["id"] == action.id
      assert decoded["actor_id"] == action.actor_id
      assert decoded["hlc"] == action.hlc
      assert decoded["gsn"] == 1

      # The Update is stored once, inside the cf_actions value.
      assert [%{"id" => stored_update_id}] = decoded["updates"]
      assert stored_update_id == update.id

      entity_gsn_key = RocksDB.encode_entity_flush_key("todo_test_123", 1)

      assert {:ok, entity_gsns} =
               RocksDB.get(RocksDB.cf_entity_actions(rocks_name), entity_gsn_key,
                 name: rocks_name
               )

      assert RocksDB.decode_gsn_list(entity_gsns) == [1]

      cf = RocksDB.cf_component_entities(rocks_name)
      model_key = RocksDB.encode_component_entity_key("todo", "todo_test_123")
      component_key = RocksDB.encode_component_entity_key("todo/title", "todo_test_123")

      assert {:ok, <<>>} = RocksDB.get(cf, model_key, name: rocks_name)
      assert {:ok, <<>>} = RocksDB.get(cf, component_key, name: rocks_name)

      assert {:ok, ^gsn_key} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action.id, name: rocks_name)
    end

    test "persists each Update's own scope and indexes the Action into their union", ctx do
      %{rocks_name: rocks_name, writer_name: writer_name} = ctx

      :ok =
        EntityGroupCache.put_entity_group(
          %{id: "eg_a", entity_id: "todo_a", group_id: "group_1"},
          entity_groups: ctx.entity_groups,
          entity_groups_by_id: ctx.entity_groups_by_id,
          entity_groups_by_group: ctx.entity_groups_by_group
        )

      update_a = validated_update(%{subject_id: "todo_a"})
      update_b = validated_update(%{subject_id: "todo_b"})

      update_eg_b = [
        validated_component("eg_b", "entityGroup/entity_id", %{"value" => "todo_b"}),
        validated_component("eg_b", "entityGroup/group_id", %{"value" => "group_2"})
      ]

      action = validated_action(%{updates: [update_a, update_b] ++ update_eg_b})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      {:ok, binary} =
        RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(1), name: rocks_name)

      # The Action spans group_1 (todo_a) and group_2 (the new todo_b and its
      # membership row); the stored per-Update scopes keep them apart.
      assert %{"update_scopes" => [["group_1"], ["group_2"], ["group_2"], ["group_2"]]} =
               ActionFormat.decode(binary, 1)

      for group_id <- ["group_1", "group_2"] do
        key = RocksDB.encode_group_action_key(group_id, 1)

        assert {:ok, action_id} =
                 RocksDB.get(RocksDB.cf_group_actions(rocks_name), key, name: rocks_name)

        assert action_id == action.id
      end
    end

    test "scopes a later write to a row its create committed in the same flush (#813)", ctx do
      %{rocks_name: rocks_name, writer_name: writer_name} = ctx

      # The create and the permissions-only write are two Actions of one
      # flush. The by-id cache only holds committed rows, so the second
      # Action's scope must come from the row the flush already folded — not
      # from a cache miss, which would commit it undeliverably.
      create =
        validated_action(%{
          id: "act_813_create",
          updates: [
            validated_component("eg_813", "entityGroup/entity_id", %{"value" => "todo_813"}),
            validated_component("eg_813", "entityGroup/group_id", %{"value" => "group_813"})
          ]
        })

      permissions =
        validated_action(%{
          id: "act_813_permissions",
          updates: [
            validated_component("eg_813", "entityGroup/permissions", %{
              "value" => ["todo.*"]
            })
          ]
        })

      assert {:ok, {1, 2}, []} = Writer.write_actions([create, permissions], writer_name)

      {:ok, binary} =
        RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(2), name: rocks_name)

      decoded = ActionFormat.decode(binary, 2)
      assert %{"update_scopes" => [["group_813"]]} = decoded

      # The same scope catch-up and live fan-out filter on.
      assert [%{"component" => "entityGroup/permissions"}] =
               ActionScope.updates_for_group(decoded, "group_813")

      key = RocksDB.encode_group_action_key("group_813", 2)

      assert {:ok, "act_813_permissions"} =
               RocksDB.get(RocksDB.cf_group_actions(rocks_name), key, name: rocks_name)
    end

    test "reads the candidate rows carrying a component in one index range", ctx do
      %{rocks_name: rocks_name, writer_name: writer_name} = ctx

      write =
        validated_action(%{
          id: "act_component_read",
          updates: [
            validated_component("todo_read_a", "todo/title", %{"value" => "a"}),
            validated_component("todo_read_b", "todo/title", %{"value" => "b"}),
            validated_component("todo_read_b", "todo/status", %{"value" => "open"})
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([write], writer_name)

      assert ComponentEntityIndex.component_entry_ids("todo/title", name: rocks_name) == [
               "todo_read_a",
               "todo_read_b"
             ]

      drop =
        validated_action(%{
          id: "act_component_drop",
          updates: [validated_component("todo_read_a", "todo/title", nil, method: :drop)]
        })

      assert {:ok, {2, 2}, []} = Writer.write_actions([drop], writer_name)

      assert ComponentEntityIndex.component_entry_ids("todo/title", name: rocks_name) == [
               "todo_read_b"
             ]

      # A delete names the row and cannot name the components to detach, so
      # its entries stay as candidates; the tombstone is the liveness filter.
      delete =
        validated_action(%{
          id: "act_component_delete",
          updates: [validated_update(%{subject_id: "todo_read_b", method: :delete})]
        })

      assert {:ok, {3, 3}, []} = Writer.write_actions([delete], writer_name)

      assert ComponentEntityIndex.component_entry_ids("todo/title", name: rocks_name) == [
               "todo_read_b"
             ]
    end

    test "dedups repeated index puts across the flush", ctx do
      %{name: writer_name} =
        start_writer(Map.put(ctx, :commit_fn, capturing_commit_fn(self())))

      action1 =
        validated_action(%{
          id: "act_index_1",
          updates: [
            validated_update(%{subject_id: "todo_shared"}),
            validated_update(%{subject_id: "todo_unique_1"})
          ]
        })

      action2 =
        validated_action(%{
          id: "act_index_2",
          updates: [
            validated_update(%{subject_id: "todo_shared"}),
            validated_update(%{subject_id: "todo_unique_2"})
          ]
        })

      assert {:ok, {1, 2}, []} = Writer.write_actions([action1, action2], writer_name)

      assert_receive {:captured_ops, ops}

      cf = RocksDB.cf_component_entities(ctx.rocks_name)
      puts = puts_to(ops, cf)

      # `todo_shared` repeats across both Actions; only its model entry and
      # component entry, plus the same pair for the two unique rows, are
      # written: 6 puts, one op per key.
      assert length(puts) == 6

      for subject_id <- ["todo_shared", "todo_unique_1", "todo_unique_2"] do
        assert {:ok, <<>>} =
                 RocksDB.get(cf, RocksDB.encode_component_entity_key("todo", subject_id),
                   name: ctx.rocks_name
                 )

        assert {:ok, <<>>} =
                 RocksDB.get(
                   cf,
                   RocksDB.encode_component_entity_key("todo/title", subject_id),
                   name: ctx.rocks_name
                 )
      end
    end

    test "a k-component write indexes k component entries plus one model entry", ctx do
      %{name: writer_name} =
        start_writer(Map.put(ctx, :commit_fn, capturing_commit_fn(self())))

      for k <- [1, 2, 3] do
        subject_id = "todo_k_#{k}"

        updates =
          Enum.map(1..k, fn i ->
            validated_component(subject_id, "todo/field_#{i}", %{"value" => i})
          end)

        action = validated_action(%{id: "act_k_#{k}", updates: updates})
        assert {:ok, {_start, _end}, []} = Writer.write_actions([action], writer_name)
        assert_receive {:captured_ops, ops}

        cf = RocksDB.cf_component_entities(ctx.rocks_name)
        puts = puts_to(ops, cf)

        # Write amplification is the pinned shape: k component entries plus
        # the constant model entry.
        assert length(puts) == k + 1

        for i <- 1..k do
          key = RocksDB.encode_component_entity_key("todo/field_#{i}", subject_id)
          assert {:ok, <<>>} = RocksDB.get(cf, key, name: ctx.rocks_name)
        end

        assert {:ok, <<>>} =
                 RocksDB.get(cf, RocksDB.encode_component_entity_key("todo", subject_id),
                   name: ctx.rocks_name
                 )
      end
    end

    test "a drop deletes the component entry and keeps the model entry", ctx do
      %{rocks_name: rocks_name, writer_name: writer_name} = ctx

      subject_id = "todo_dropped"

      write =
        validated_action(%{
          updates: [validated_component(subject_id, "todo/title", %{"value" => "x"})]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([write], writer_name)

      drop =
        validated_action(%{
          updates: [validated_update(%{subject_id: subject_id, method: :drop, data: nil})]
        })

      assert {:ok, {2, 2}, []} = Writer.write_actions([drop], writer_name)

      cf = RocksDB.cf_component_entities(rocks_name)

      assert :not_found =
               RocksDB.get(
                 cf,
                 RocksDB.encode_component_entity_key("todo/title", subject_id),
                 name: rocks_name
               )

      assert {:ok, <<>>} =
               RocksDB.get(cf, RocksDB.encode_component_entity_key("todo", subject_id),
                 name: rocks_name
               )
    end

    test "a delete leaves the model entry and the row's stale component entries", ctx do
      %{rocks_name: rocks_name, writer_name: writer_name} = ctx

      subject_id = "todo_deleted"

      write =
        validated_action(%{
          updates: [validated_component(subject_id, "todo/title", %{"value" => "x"})]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([write], writer_name)

      delete =
        validated_action(%{
          updates: [validated_update(%{subject_id: subject_id, method: :delete})]
        })

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete], writer_name)

      cf = RocksDB.cf_component_entities(rocks_name)

      # A delete names the row, not its components, so the component entries
      # stay behind. Existence is the model entry, which survives (#799).
      assert {:ok, <<>>} =
               RocksDB.get(cf, RocksDB.encode_component_entity_key("todo", subject_id),
                 name: rocks_name
               )

      assert {:ok, <<>>} =
               RocksDB.get(
                 cf,
                 RocksDB.encode_component_entity_key("todo/title", subject_id),
                 name: rocks_name
               )
    end
  end

  describe "ETF round-trip" do
    test "action survives encode/decode round-trip", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update =
        validated_component("todo_roundtrip", "todo/title", %{"value" => "Test", "hlc" => 12_345})

      action =
        validated_action(%{
          id: "act_roundtrip",
          updates: [update]
        })

      Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      {:ok, binary} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)
      decoded = ActionFormat.decode(binary, 1)

      assert decoded["id"] == action.id
      assert decoded["actor_id"] == action.actor_id
      assert decoded["gsn"] == 1
      assert length(decoded["updates"]) == 1
      assert hd(decoded["updates"])["subject_id"] == "todo_roundtrip"
    end
  end

  describe "stored value shape (#532/#552)" do
    test "writes a frame whose payload carries no gsn or update_scopes", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_frame"})]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      {:ok, value} =
        RocksDB.get(
          RocksDB.cf_actions(rocks_name),
          RocksDB.encode_gsn_key(1),
          name: rocks_name
        )

      # The frame is a version byte, the payload's length, the payload ETF,
      # and the scopes ETF — not one term, so the halves are read separately.
      assert <<size::32, payload_etf::binary-size(size), scopes_etf::binary>> = value
      assert :erlang.binary_to_term(scopes_etf, [:safe]) == [[]]

      payload = :erlang.binary_to_term(payload_etf, [:safe])

      assert payload["id"] == action.id
      refute Map.has_key?(payload, "gsn")
      refute Map.has_key?(payload, "update_scopes")
    end

    test "the new shape round-trips through ActionLog.read/3", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update = validated_update(%{subject_id: "todo_action_log"})
      action = validated_action(%{id: "act_action_log", updates: [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [stored] = ActionLog.read(1, 1, rocks_name: rocks_name)

      assert stored["id"] == action.id
      assert stored["gsn"] == 1
      assert stored["update_scopes"] == [[]]
      assert [%{"id" => update_id, "subject_id" => "todo_action_log"}] = stored["updates"]
      assert update_id == update.id
    end
  end

  describe "dirty set is updated" do
    test "marks entity dirty after write", %{
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_abc"})]})

      Writer.write_actions([action], writer_name)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
    end
  end

  describe "provisional dirty marks" do
    test "marks entities provisionally before the commit attempt", ctx do
      test_pid = self()

      commit_fn = fn ops, opts ->
        mark = DirtyTracker.dirty_generation("todo_pending", ctx.dirty_set)
        send(test_pid, {:mark_at_commit, mark})
        RocksDB.write_batch(ops, opts)
      end

      %{name: writer_name} = start_writer(Map.put(ctx, :commit_fn, commit_fn))

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_pending"})]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert_receive {:mark_at_commit, mark}
      assert DirtyTracker.pending?(mark)

      # The commit has returned, so the mark is settled by the time the call
      # replies.
      refute DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_pending", ctx.dirty_set))
    end

    test "startup settles provisional marks left by a crashed writer", ctx do
      DirtyTracker.mark_pending_batch([{"todo_orphan", "todo"}], ctx.dirty_set)

      %{name: _writer_name} = start_writer(ctx)

      assert DirtyTracker.dirty?("todo_orphan", ctx.dirty_set)
      refute DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_orphan", ctx.dirty_set))
    end
  end

  describe "durability" do
    test "data survives Writer and RocksDB restart", %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    } do
      dir =
        tmp_dir(%{module: __MODULE__, test: "durability_#{System.unique_integer([:positive])}"})

      action = validated_action()

      rocks_name1 = :"rocks_#{System.unique_integer([:positive])}"
      {:ok, _rocks_pid1} = RocksDB.start_link(data_dir: dir, name: rocks_name1)

      writer_name1 = :"writer_#{System.unique_integer([:positive])}"

      {:ok, _writer_pid1} =
        Writer.start_link(
          name: writer_name1,
          rocks_name: rocks_name1,
          dirty_set: dirty_set,
          gsn_counter: gsn_counter,
          group_members: group_members,
          group_members_by_id: group_members_by_id,
          entity_groups: entity_groups,
          entity_groups_by_id: entity_groups_by_id,
          entity_groups_by_group: entity_groups_by_group,
          relationships: relationships,
          relationships_by_id: relationships_by_id
        )

      Writer.write_actions([action], writer_name1)

      GenServer.stop(writer_name1)
      GenServer.stop(rocks_name1)

      rocks_name2 = :"rocks_#{System.unique_integer([:positive])}"
      {:ok, _rocks_pid2} = RocksDB.start_link(data_dir: dir, name: rocks_name2)

      writer_name2 = :"writer_#{System.unique_integer([:positive])}"

      {:ok, _writer_pid2} =
        Writer.start_link(
          name: writer_name2,
          rocks_name: rocks_name2,
          dirty_set: dirty_set,
          gsn_counter: gsn_counter,
          group_members: group_members,
          group_members_by_id: group_members_by_id,
          entity_groups: entity_groups,
          entity_groups_by_id: entity_groups_by_id,
          entity_groups_by_group: entity_groups_by_group,
          relationships: relationships,
          relationships_by_id: relationships_by_id
        )

      on_exit(fn ->
        if pid = Process.whereis(writer_name2), do: safe_stop(pid)
        if pid = Process.whereis(rocks_name2), do: safe_stop(pid)
      end)

      gsn_key = RocksDB.encode_gsn_key(1)

      assert {:ok, _binary} =
               RocksDB.get(RocksDB.cf_actions(rocks_name2), gsn_key, name: rocks_name2)
    end
  end

  describe "empty updates filtering" do
    test "actions with empty updates are filtered out", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action1 = validated_action(%{id: "act_valid", updates: [validated_update()]})
      action2 = validated_action(%{id: "act_empty", updates: []})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action1, action2], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      assert {:ok, _} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      gsn_key2 = RocksDB.encode_gsn_key(2)
      assert :not_found = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key2, name: rocks_name)
    end
  end

  describe "action dedup (#285)" do
    test "re-submitting a committed action_id is a silent no-op", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert {:ok, _} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action.id, name: rocks_name)

      assert {:ok, {0, 0}, []} = Writer.write_actions([action], writer_name)

      assert RocksDB.get_max_gsn(rocks_name) == 1

      assert :not_found =
               RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(2),
                 name: rocks_name
               )

      assert {:ok, gsn_binary} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action.id, name: rocks_name)

      assert gsn_binary == RocksDB.encode_gsn_key(1)
    end

    test "mixed batch writes only the uncommitted action", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action_a = validated_action()
      action_b = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action_a], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([action_a, action_b], writer_name)

      assert RocksDB.get_max_gsn(rocks_name) == 2

      assert {:ok, binary} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(2),
                 name: rocks_name
               )

      assert ActionFormat.decode(binary, 2)["id"] == action_b.id

      assert {:ok, gsn_binary} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action_a.id, name: rocks_name)

      assert gsn_binary == RocksDB.encode_gsn_key(1)
    end

    test "the same action_id twice in one batch is written once", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action, action], writer_name)
      assert RocksDB.get_max_gsn(rocks_name) == 1
    end
  end

  describe "system cache updates" do
    test "groupMember PUT updates ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table
         } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: group_member_updates(gm_id, "actor_1", "group_1", ["todo.create"], hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [%{group_id: "group_1", permissions: ["todo.create"]}] =
               GroupCache.get_actor_groups("actor_1", gm_table)

      assert ["todo.create"] = GroupCache.get_permissions("actor_1", "group_1", gm_table)
    end

    test "entityGroup PUT updates ETS",
         %{
           writer_name: writer_name,
           entity_groups: eg_table,
           entity_groups_by_group: eg_by_group
         } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates(eg_id, "todo_1", "group_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityGroupCache.entity_groups("todo_1", eg_table) == ["group_1"]
      assert EntityGroupCache.group_entities("group_1", eg_by_group) == ["todo_1"]
    end

    test "entityGroup PATCH merges the wire fields over the cached row",
         %{
           writer_name: writer_name,
           entity_groups: eg_table,
           entity_groups_by_id: eg_by_id
         } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates(eg_id, "todo_1", "group_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [entity_group_patch(eg_id, "group_2", hlc)]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([patch_action], writer_name)

      assert EntityGroupCache.entity_groups("todo_1", eg_table) == ["group_2"]
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id).entity_id == "todo_1"
    end

    test "entityGroup PATCH with no cached row is a no-op",
         %{
           writer_name: writer_name,
           entity_groups_by_id: eg_by_id
         } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: [entity_group_patch(eg_id, "group_1", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([patch_action], writer_name)
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == nil
    end

    test "groupMember PATCH merges the wire fields over the cached row",
         %{
           writer_name: writer_name,
           group_members: gm_table
         } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: group_member_updates(gm_id, "actor_1", "group_1", ["todo.create"], hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [group_member_patch(gm_id, ["todo.read"], hlc)]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([patch_action], writer_name)

      assert [%{group_id: "group_1", permissions: ["todo.read"]}] =
               GroupCache.get_actor_groups("actor_1", gm_table)
    end

    test "groupMember PATCH with no cached row is a no-op",
         %{
           writer_name: writer_name,
           group_members_by_id: gm_by_id
         } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: [group_member_patch(gm_id, ["todo.read"], hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([patch_action], writer_name)
      assert GroupCache.get_group_member(gm_id, gm_by_id) == nil
    end

    test "relationship PUT updates the domain edge indexes",
         %{
           writer_name: writer_name,
           relationships: rel_table,
           relationships_by_id: rbi_table
         } do
      hlc = generate_hlc()
      rel_id = "rel_" <> Nanoid.generate()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: relationship_updates(rel_id, "todo_1", "col_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert RelationshipCache.get_relationship(rel_id, rbi_table).target_id == "col_1"
      assert [{"todo_1", _entry}] = :ets.lookup(rel_table, "todo_1")
    end

    test "groupMember DELETE removes from ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table
         } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: group_member_updates(gm_id, "actor_1", "group_1", ["todo.create"], hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert [_] = GroupCache.get_actor_groups("actor_1", gm_table)

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [system_delete_update(gm_id)]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete_action], writer_name)
      assert [] = GroupCache.get_actor_groups("actor_1", gm_table)
    end

    test "entityGroup DELETE removes from ETS",
         %{
           writer_name: writer_name,
           entity_groups: eg_table,
           entity_groups_by_id: eg_by_id
         } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates(eg_id, "todo_1", "group_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert EntityGroupCache.entity_groups("todo_1", eg_table) == ["group_1"]
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) != nil

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [system_delete_update(eg_id)]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete_action], writer_name)
      assert EntityGroupCache.entity_groups("todo_1", eg_table) == []
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == nil
    end

    test "relationship DELETE removes from ETS",
         %{
           writer_name: writer_name,
           relationships: rel_table,
           relationships_by_id: rbi_table
         } do
      hlc = generate_hlc()
      rel_id = "rel_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: relationship_updates(rel_id, "todo_1", "col_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert RelationshipCache.get_relationship(rel_id, rbi_table) != nil

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [system_delete_update(rel_id)]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete_action], writer_name)
      assert RelationshipCache.get_relationship(rel_id, rbi_table) == nil
      assert :ets.lookup(rel_table, "todo_1") == []
    end

    test "non-system entity updates do not affect ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           entity_groups: eg_table
         } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [] = GroupCache.get_actor_groups("a_test", gm_table)
      assert EntityGroupCache.entity_groups("todo_test", eg_table) == []
    end

    test "mixed batch - system and user entities",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           entity_groups: eg_table
         } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          [todo_update("upd_" <> Nanoid.generate(), "todo_1", "Test", hlc)] ++
            group_member_updates(gm_id, "actor_1", "group_1", ["todo.create"], hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [%{group_id: "group_1"}] = GroupCache.get_actor_groups("actor_1", gm_table)
      assert EntityGroupCache.entity_groups("todo_1", eg_table) == []
    end

    # #264 Option A: the authorizer resolves an existing entity's type
    # from here, so every user-entity Update must populate the index.
    test "indexes the type of a user-entity update", %{
      writer_name: writer_name,
      entity_types: entity_types
    } do
      action =
        validated_action(%{
          id: "act_" <> Nanoid.generate(),
          actor_id: "actor_1",
          updates: [validated_update(%{subject_id: "todo_typed"})]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityTypeCache.get_type("todo_typed", entity_types) == "todo"
    end

    test "a same-flush entityGroup put then patch caches the merged row", %{
      writer_name: writer_name,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id
    } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      put = entity_group_updates(eg_id, "todo_merge", "group_1", hlc)
      patch = entity_group_patch(eg_id, "group_2", hlc)

      action = validated_action(%{id: "act_merge", updates: put ++ [patch]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityGroupCache.entity_groups("todo_merge", eg_table) == ["group_2"]

      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == %{
               id: eg_id,
               entity_id: "todo_merge",
               group_id: "group_2"
             }
    end

    test "a same-flush put then delete leaves the entityGroup row gone", %{
      writer_name: writer_name,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id
    } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      put = entity_group_updates(eg_id, "todo_pd", "group_1", hlc)
      delete = system_delete_update(eg_id)

      action = validated_action(%{id: "act_pd", updates: put ++ [delete]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == nil
      assert EntityGroupCache.entity_groups("todo_pd", eg_table) == []
    end

    # A delete names the row, not a component, so the fold collapses the row
    # to one delete however its component Updates are ordered: a delete in the
    # same Action cannot be undone by a put beside it.
    test "a same-flush delete then put leaves the entityGroup row deleted", %{
      writer_name: writer_name,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id
    } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      delete = system_delete_update(eg_id)
      put = entity_group_updates(eg_id, "todo_dp", "group_2", hlc)

      action = validated_action(%{id: "act_dp", updates: [delete] ++ put})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == nil
      assert EntityGroupCache.entity_groups("todo_dp", eg_table) == []
    end

    test "a same-flush entityGroup delete then patch does not resurrect the row", %{
      writer_name: writer_name,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id
    } do
      hlc = generate_hlc()
      eg_id = "eg_" <> Nanoid.generate()

      seed =
        validated_action(%{
          id: "act_resurrect_seed",
          updates: entity_group_updates(eg_id, "todo_resurrect", "group_1", hlc)
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([seed], writer_name)
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) != nil

      delete = system_delete_update(eg_id)
      patch = entity_group_patch(eg_id, "group_2", hlc)

      action = validated_action(%{id: "act_resurrect", updates: [delete, patch]})

      assert {:ok, {2, 2}, []} = Writer.write_actions([action], writer_name)

      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) == nil
      assert EntityGroupCache.entity_groups("todo_resurrect", eg_table) == []
    end

    test "a same-flush groupMember put then delete removes the membership", %{
      writer_name: writer_name,
      group_members: gm_table,
      group_members_by_id: gm_by_id
    } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      put = group_member_updates(gm_id, "actor_1", "group_1", ["todo.create"], hlc)
      delete = system_delete_update(gm_id)

      action = validated_action(%{id: "act_gm_pd", updates: put ++ [delete]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert GroupCache.get_group_member(gm_id, gm_by_id) == nil
      assert GroupCache.get_actor_groups("actor_1", gm_table) == []
    end

    # A membership id names one row with one actor. An actor change in a
    # single flush re-keys that row: the last put wins, and the previous
    # actor must not keep a primary entry for it (#625). Leaving the old
    # entry behind would grant a membership the durable row no longer has.
    test "a same-flush groupMember actor change leaves one row under the final actor", %{
      writer_name: writer_name,
      group_members: gm_table,
      group_members_by_id: gm_by_id
    } do
      hlc = generate_hlc()
      gm_id = "gm_" <> Nanoid.generate()

      put_a = group_member_updates(gm_id, "actor_a", "group_1", ["todo.create"], hlc)
      put_b = group_member_updates(gm_id, "actor_b", "group_1", ["todo.read"], hlc)

      action = validated_action(%{id: "act_gm_actor_swap", updates: put_a ++ put_b})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert GroupCache.get_actor_groups("actor_a", gm_table) == []

      assert [%{group_id: "group_1", permissions: ["todo.read"]}] =
               GroupCache.get_actor_groups("actor_b", gm_table)

      assert GroupCache.get_group_member(gm_id, gm_by_id).actor_id == "actor_b"
    end
  end

  describe "cf_group_actions index" do
    test "indexes a create into every group in its membership set", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      hlc = generate_hlc()

      action = %{
        id: "act_multi",
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          [todo_update("upd_todo", "todo_multi", "x", hlc)] ++
            entity_group_updates("eg_g1", "todo_multi", "g_1", hlc) ++
            entity_group_updates("eg_g2", "todo_multi", "g_2", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_multi"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert {:ok, "act_multi"} = RocksDB.get(cf, group_gsn_key("g_2", 1), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("g_3", 1), name: rocks_name)
    end

    test "emits one put per {group_id, gsn} when two updates resolve to the same group",
         ctx do
      %{name: writer_name} =
        start_writer(Map.put(ctx, :commit_fn, capturing_commit_fn(self())))

      hlc = generate_hlc()

      action = %{
        id: "act_same_group",
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          [todo_update("upd_todo", "todo_same_group", "x", hlc)] ++
            entity_group_updates("eg_same_group", "todo_same_group", "g_bench", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert_receive {:captured_ops, ops}

      cf = RocksDB.cf_group_actions(ctx.rocks_name)
      key = group_gsn_key("g_bench", 1)
      puts = puts_to(ops, cf)

      assert length(puts) == 1
      assert {:ok, "act_same_group"} = RocksDB.get(cf, key, name: ctx.rocks_name)
    end

    test "a domain link to a non-group target adds no group index", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      hlc = generate_hlc()

      action = %{
        id: "act_link",
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          [todo_update("upd_todo", "todo_link", "x", hlc)] ++
            entity_group_updates("eg_member", "todo_link", "g_1", hlc) ++
            relationship_updates("rel_domain", "todo_link", "doc_1", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_link"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("doc_1", 1), name: rocks_name)
    end

    test "a re-put moves the entity to the new group for later writes", %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      entity_groups: eg_table
    } do
      hlc = generate_hlc()

      first = %{
        id: "act_first",
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates("eg_1", "todo_move", "g_1", hlc)
      }

      second = %{
        id: "act_second",
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates("eg_1", "todo_move", "g_2", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([first], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([second], writer_name)

      assert EntityGroupCache.entity_groups("todo_move", eg_table) == ["g_2"]

      cf = RocksDB.cf_group_actions(rocks_name)
      assert {:ok, "act_first"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert {:ok, "act_second"} = RocksDB.get(cf, group_gsn_key("g_2", 2), name: rocks_name)
    end

    test "two Actions moving the same entity index their own intra-action membership", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      hlc = generate_hlc()

      first = %{
        id: "act_memo_first",
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          [todo_update("upd_memo_first", "todo_memo", "x", hlc)] ++
            entity_group_updates("eg_memo_a", "todo_memo", "g_a", hlc)
      }

      second = %{
        id: "act_memo_second",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates:
          [todo_update("upd_memo_second", "todo_memo", "x", hlc)] ++
            entity_group_updates("eg_memo_b", "todo_memo", "g_b", hlc)
      }

      # Both Actions build in one flush, against the pre-write cache. The
      # memo must not hand the second Action the first Action's set.
      assert {:ok, {1, 2}, []} = Writer.write_actions([first, second], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)
      assert {:ok, "act_memo_first"} = RocksDB.get(cf, group_gsn_key("g_a", 1), name: rocks_name)
      assert {:ok, "act_memo_second"} = RocksDB.get(cf, group_gsn_key("g_b", 2), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("g_b", 1), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("g_a", 2), name: rocks_name)
    end

    test "a memoized resolution is keyed by model, not just id", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      hlc = generate_hlc()

      seed = %{
        id: "act_shared_seed",
        actor_id: "actor_1",
        hlc: hlc,
        updates:
          entity_group_updates("shared", "todo_other", "g_membership", hlc) ++
            entity_group_updates("eg_user", "shared", "g_user", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([seed], writer_name)

      # `shared` is both a membership row id (entityGroup) and an entity
      # id (todo) with different group sets. Both are prepared in one flush,
      # so the memo must key them apart by model rather than by id alone.
      delete_membership = %{
        id: "act_shared_membership",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [system_delete_update("shared")]
      }

      write_shared_todo = %{
        id: "act_shared_todo",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [todo_update("upd_shared_todo", "shared", "x", hlc)]
      }

      assert {:ok, {2, 3}, []} =
               Writer.write_actions([delete_membership, write_shared_todo], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_shared_membership"} =
               RocksDB.get(cf, group_gsn_key("g_membership", 2), name: rocks_name)

      assert {:ok, "act_shared_todo"} =
               RocksDB.get(cf, group_gsn_key("g_user", 3), name: rocks_name)
    end
  end

  describe "batch_committed groups snapshot (#251)" do
    test "annotates the durable commit time as a native monotonic timestamp", ctx do
      router_name = :"fan_out_router_test_#{System.unique_integer([:positive])}"
      true = Process.register(self(), router_name)

      %{name: writer_name} =
        start_writer(%{
          rocks_name: ctx.rocks_name,
          dirty_set: ctx.dirty_set,
          gsn_counter: ctx.gsn_counter,
          group_members: ctx.group_members,
          group_members_by_id: ctx.group_members_by_id,
          entity_groups: ctx.entity_groups,
          entity_groups_by_id: ctx.entity_groups_by_id,
          entity_groups_by_group: ctx.entity_groups_by_group,
          relationships: ctx.relationships,
          relationships_by_id: ctx.relationships_by_id,
          fan_out_router: router_name
        })

      before = System.monotonic_time()

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_committed_at"})], writer_name)

      after_commit = System.monotonic_time()

      assert_receive {:batch_committed, 1, 1, _groups, committed_at, _payloads, _actors}
      assert is_integer(committed_at)
      assert committed_at >= before and committed_at <= after_commit
    end

    test "carries the actors whose group view the applied membership changed", ctx do
      router_name = :"fan_out_router_test_#{System.unique_integer([:positive])}"
      true = Process.register(self(), router_name)

      %{name: writer_name} =
        start_writer(%{
          rocks_name: ctx.rocks_name,
          dirty_set: ctx.dirty_set,
          gsn_counter: ctx.gsn_counter,
          group_members: ctx.group_members,
          group_members_by_id: ctx.group_members_by_id,
          entity_groups: ctx.entity_groups,
          entity_groups_by_id: ctx.entity_groups_by_id,
          entity_groups_by_group: ctx.entity_groups_by_group,
          relationships: ctx.relationships,
          relationships_by_id: ctx.relationships_by_id,
          fan_out_router: router_name
        })

      hlc = generate_hlc()

      member =
        validated_action(%{
          id: "act_member_actor",
          updates:
            group_member_updates("gm_member_actor", "a_member", "g_member", ["todo.read"], hlc)
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([member], writer_name)

      # A membership row changes its actor's group view; a batch that
      # touches none reports none.
      assert_receive {:batch_committed, 1, 1, _groups, _committed_at, _payloads, ["a_member"]}

      assert {:ok, {2, 2}, []} =
               Writer.write_actions([validated_action(%{id: "act_unrelated"})], writer_name)

      assert_receive {:batch_committed, 2, 2, _groups, _committed_at, _payloads, []}
    end

    test "carries the pre-update group set for an entityGroup delete", %{
      rocks_name: rocks_name,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    } do
      router_name = :"fan_out_router_test_#{System.unique_integer([:positive])}"
      true = Process.register(self(), router_name)

      %{name: writer_name} =
        start_writer(%{
          rocks_name: rocks_name,
          dirty_set: dirty_set,
          gsn_counter: gsn_counter,
          group_members: group_members,
          group_members_by_id: group_members_by_id,
          entity_groups: entity_groups,
          entity_groups_by_id: entity_groups_by_id,
          entity_groups_by_group: entity_groups_by_group,
          relationships: relationships,
          relationships_by_id: relationships_by_id,
          fan_out_router: router_name
        })

      hlc = generate_hlc()

      put = %{
        id: "act_snapshot_put",
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates("eg_snapshot", "todo_snapshot", "g_snapshot", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put], writer_name)

      assert_receive {:batch_committed, 1, 1, %{1 => ["g_snapshot"]}, _committed_at, _payloads,
                      _actors}

      delete = %{
        id: "act_snapshot_delete",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [system_delete_update("eg_snapshot")]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete], writer_name)

      # The by-id entry is gone once the caches update, so the delete's
      # group set must come from the same pre-update pass that built
      # cf_group_actions — not from a later re-resolution.
      assert EntityGroupCache.entity_groups("todo_snapshot", entity_groups) == []

      assert_receive {:batch_committed, 2, 2, %{2 => ["g_snapshot"]}, _committed_at, _payloads,
                      _actors}
    end

    test "a put+delete setGroups Action unions the old and new groups", %{
      rocks_name: rocks_name,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    } do
      router_name = :"fan_out_router_test_#{System.unique_integer([:positive])}"
      true = Process.register(self(), router_name)

      %{name: writer_name} =
        start_writer(%{
          rocks_name: rocks_name,
          dirty_set: dirty_set,
          gsn_counter: gsn_counter,
          group_members: group_members,
          group_members_by_id: group_members_by_id,
          entity_groups: entity_groups,
          entity_groups_by_id: entity_groups_by_id,
          entity_groups_by_group: entity_groups_by_group,
          entity_types: entity_types,
          relationships: relationships,
          relationships_by_id: relationships_by_id,
          fan_out_router: router_name
        })

      hlc = generate_hlc()

      seed = %{
        id: "act_setgroups_seed",
        actor_id: "actor_1",
        hlc: hlc,
        updates: entity_group_updates("eg_old", "todo_set", "g_old", hlc)
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([seed], writer_name)

      assert_receive {:batch_committed, 1, 1, %{1 => ["g_old"]}, _committed_at, _payloads,
                      _actors}

      swap = %{
        id: "act_setgroups_swap",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates:
          entity_group_updates("eg_new", "todo_set", "g_new", hlc) ++
            [system_delete_update("eg_old")]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([swap], writer_name)

      # The cache ends at the new set; the delete row is gone.
      assert EntityGroupCache.entity_groups("todo_set", entity_groups) == ["g_new"]
      assert EntityGroupCache.get_entity_group("eg_old", entity_groups_by_id) == nil

      # The delete is indexed under the group it left, the put under the
      # group it joined.
      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_setgroups_swap"} =
               RocksDB.get(cf, group_gsn_key("g_old", 2), name: rocks_name)

      assert {:ok, "act_setgroups_swap"} =
               RocksDB.get(cf, group_gsn_key("g_new", 2), name: rocks_name)

      assert_receive {:batch_committed, 2, 2, %{2 => groups}, _committed_at, _payloads, _actors}
      assert Enum.sort(groups) == ["g_new", "g_old"]
    end

    test "carries each Action's payload and scopes in GSN order", ctx do
      router_name = :"fan_out_router_test_#{System.unique_integer([:positive])}"
      true = Process.register(self(), router_name)

      %{name: writer_name} =
        start_writer(%{
          rocks_name: ctx.rocks_name,
          dirty_set: ctx.dirty_set,
          gsn_counter: ctx.gsn_counter,
          group_members: ctx.group_members,
          group_members_by_id: ctx.group_members_by_id,
          entity_groups: ctx.entity_groups,
          entity_groups_by_id: ctx.entity_groups_by_id,
          entity_groups_by_group: ctx.entity_groups_by_group,
          relationships: ctx.relationships,
          relationships_by_id: ctx.relationships_by_id,
          fan_out_router: router_name
        })

      first = validated_action(%{id: "act_carried_first"})
      second = validated_action(%{id: "act_carried_second"})

      assert {:ok, {1, 2}, []} = Writer.write_actions([first, second], writer_name)

      assert_receive {:batch_committed, 1, 2, _groups, _committed_at, payloads, _actors}
      assert [{first_etf, _first_scopes}, {second_etf, _second_scopes}] = payloads

      assert :erlang.binary_to_term(first_etf)["id"] == "act_carried_first"
      assert :erlang.binary_to_term(second_etf)["id"] == "act_carried_second"

      cf = RocksDB.cf_actions(ctx.rocks_name)

      for {{payload_etf, scopes}, gsn} <- Enum.with_index(payloads, 1) do
        assert {:ok, frame} =
                 RocksDB.get(cf, RocksDB.encode_gsn_key(gsn), name: ctx.rocks_name)

        carried = ActionFormat.decode_carried(payload_etf, scopes, gsn)
        assert carried == ActionFormat.decode(frame, gsn)
        assert carried["gsn"] == gsn
      end
    end
  end

  defp entity_group_updates(id, entity_id, group_id, hlc) do
    [
      validated_component(id, "entityGroup/entity_id", %{"value" => entity_id, "hlc" => hlc}),
      validated_component(id, "entityGroup/group_id", %{
        "value" => group_id,
        "hlc" => hlc
      })
    ]
  end

  defp entity_group_patch(id, group_id, hlc) do
    validated_component(id, "entityGroup/group_id", %{"value" => group_id, "hlc" => hlc},
      method: :merge
    )
  end

  defp todo_update(id, entity_id, value, hlc) do
    validated_component(entity_id, "todo/title", %{"value" => value, "hlc" => hlc}, id: id)
  end

  defp system_delete_update(subject_id) do
    validated_update(%{subject_id: subject_id, method: :delete})
  end

  defp group_member_updates(id, actor_id, group_id, permissions, hlc) do
    [
      validated_component(id, "groupMember/actor_id", %{"value" => actor_id, "hlc" => hlc}),
      validated_component(id, "groupMember/group_id", %{
        "value" => group_id,
        "hlc" => hlc
      }),
      validated_component(id, "groupMember/permissions", %{
        "value" => permissions,
        "hlc" => hlc
      })
    ]
  end

  defp group_member_patch(id, permissions, hlc) do
    validated_component(
      id,
      "groupMember/permissions",
      %{
        "value" => permissions,
        "hlc" => hlc
      },
      method: :merge
    )
  end

  defp relationship_updates(id, source_id, target_id, hlc) do
    [
      validated_component(id, "relationship/source_id", %{
        "value" => source_id,
        "hlc" => hlc
      }),
      validated_component(id, "relationship/target_id", %{
        "value" => target_id,
        "hlc" => hlc
      }),
      validated_component(id, "relationship/type", %{"value" => "todo", "hlc" => hlc}),
      validated_component(id, "relationship/field", %{"value" => "owns", "hlc" => hlc})
    ]
  end

  defp group_gsn_key(group_id, gsn) do
    RocksDB.encode_group_action_key(group_id, gsn)
  end

  defp capturing_commit_fn(test_pid) do
    fn ops, opts ->
      send(test_pid, {:captured_ops, ops})
      RocksDB.write_batch(ops, opts)
    end
  end

  defp puts_to(ops, cf) do
    for {:put, ^cf, _key, _value} <- ops, do: :ok
  end
end
