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

      decoded = :erlang.binary_to_term(binary, [:safe])
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
      update = validated_update(%{subject_id: "todo_test_123", subject_type: "todo"})
      action = validated_action(%{updates: [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      stored_action = to_storage_format(action, 1)
      action_etf = :erlang.term_to_binary(stored_action)

      assert {:ok, stored_etf} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      assert stored_etf == action_etf

      # The Update is stored once, inside the cf_actions value.
      assert [%{"id" => stored_update_id}] =
               :erlang.binary_to_term(stored_etf, [:safe])["updates"]

      assert stored_update_id == update.id

      entity_gsn_key = RocksDB.encode_entity_gsn_key("todo_test_123", 1)

      assert {:ok, action_id} =
               RocksDB.get(RocksDB.cf_entity_actions(rocks_name), entity_gsn_key,
                 name: rocks_name
               )

      assert action_id == action.id

      type_entity_key = RocksDB.encode_type_entity_key("todo", "todo_test_123")

      assert {:ok, <<>>} =
               RocksDB.get(RocksDB.cf_type_entities(rocks_name), type_entity_key,
                 name: rocks_name
               )

      assert {:ok, ^gsn_key} =
               RocksDB.get(RocksDB.cf_action_dedup(rocks_name), action.id, name: rocks_name)
    end

    test "dedups repeated (subject_type, subject_id) index puts across the flush", ctx do
      %{name: writer_name} =
        start_writer(Map.put(ctx, :commit_fn, capturing_commit_fn(self())))

      action1 =
        validated_action(%{
          id: "act_type_1",
          updates: [
            validated_update(%{subject_id: "todo_shared", subject_type: "todo"}),
            validated_update(%{subject_id: "todo_unique_1", subject_type: "todo"})
          ]
        })

      action2 =
        validated_action(%{
          id: "act_type_2",
          updates: [
            validated_update(%{subject_id: "todo_shared", subject_type: "todo"}),
            validated_update(%{subject_id: "todo_unique_2", subject_type: "todo"})
          ]
        })

      assert {:ok, {1, 2}, []} = Writer.write_actions([action1, action2], writer_name)

      assert_receive {:captured_ops, ops}

      cf = RocksDB.cf_type_entities(ctx.rocks_name)
      puts = puts_to(ops, cf)

      # `todo_shared` repeats across both Actions; only the three unique
      # keys are written.
      assert length(puts) == 3

      for subject_id <- ["todo_shared", "todo_unique_1", "todo_unique_2"] do
        key = RocksDB.encode_type_entity_key("todo", subject_id)
        assert {:ok, <<>>} = RocksDB.get(cf, key, name: ctx.rocks_name)
      end
    end
  end

  describe "ETF round-trip" do
    test "action survives encode/decode round-trip", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update =
        validated_update(%{
          subject_id: "todo_roundtrip",
          data: %{
            "fields" => %{"title" => %{"type" => "lww", "value" => "Test", "hlc" => 12_345}}
          }
        })

      action =
        validated_action(%{
          id: "act_roundtrip",
          updates: [update]
        })

      Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      {:ok, binary} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)
      decoded = :erlang.binary_to_term(binary, [:safe])

      assert decoded["id"] == action.id
      assert decoded["actor_id"] == action.actor_id
      assert decoded["gsn"] == 1
      assert length(decoded["updates"]) == 1
      assert hd(decoded["updates"])["subject_id"] == "todo_roundtrip"
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
      DirtyTracker.mark_pending_batch(["todo_orphan"], ctx.dirty_set)

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
        if pid = Process.whereis(writer_name2),
          do: if(Process.alive?(pid), do: GenServer.stop(pid))

        if pid = Process.whereis(rocks_name2),
          do: if(Process.alive?(pid), do: GenServer.stop(pid))
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

      assert :erlang.binary_to_term(binary, [:safe])["id"] == action_b.id

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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :put,
            data: %{
              "fields" => %{
                "actor_id" => %{"type" => "lww", "value" => "actor_1", "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "permissions" => %{"type" => "lww", "value" => ["todo.create"], "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: eg_id,
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"type" => "lww", "value" => "todo_1", "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [entity_group_update(eg_id, "todo_1", "group_1", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: eg_id,
            subject_type: "entityGroup",
            method: :patch,
            data: %{
              "fields" => %{
                "group_id" => %{"type" => "lww", "value" => "group_2", "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: eg_id,
            subject_type: "entityGroup",
            method: :patch,
            data: %{
              "fields" => %{
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [group_member_update(gm_id, "actor_1", "group_1", ["todo.create"], hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)

      patch_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :patch,
            data: %{
              "fields" => %{
                "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :patch,
            data: %{
              "fields" => %{
                "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
              }
            }
          }
        ]
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
        updates: [relationship_update(rel_id, "todo_1", "col_1", hlc)]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :put,
            data: %{
              "fields" => %{
                "actor_id" => %{"type" => "lww", "value" => "actor_1", "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "permissions" => %{"type" => "lww", "value" => ["todo.create"], "hlc" => hlc}
              }
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert [_] = GroupCache.get_actor_groups("actor_1", gm_table)

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :delete,
            data: %{}
          }
        ]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: eg_id,
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"type" => "lww", "value" => "todo_1", "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc}
              }
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert EntityGroupCache.entity_groups("todo_1", eg_table) == ["group_1"]
      assert EntityGroupCache.get_entity_group(eg_id, eg_by_id) != nil

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: eg_id,
            subject_type: "entityGroup",
            method: :delete,
            data: %{}
          }
        ]
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
        updates: [relationship_update(rel_id, "todo_1", "col_1", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert RelationshipCache.get_relationship(rel_id, rbi_table) != nil

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: rel_id,
            subject_type: "relationship",
            method: :delete,
            data: %{}
          }
        ]
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
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Test", "hlc" => hlc}
              }
            }
          },
          %{
            id: "upd_gm_" <> Nanoid.generate(),
            subject_id: gm_id,
            subject_type: "groupMember",
            method: :put,
            data: %{
              "fields" => %{
                "actor_id" => %{"type" => "lww", "value" => "actor_1", "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "permissions" => %{"type" => "lww", "value" => ["todo.create"], "hlc" => hlc}
              }
            }
          }
        ]
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
      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: "todo_typed",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{}}
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert EntityTypeCache.get_type("todo_typed", entity_types) == "todo"
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
        updates: [
          %{
            id: "upd_todo",
            subject_id: "todo_multi",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
            }
          },
          entity_group_update("eg_g1", "todo_multi", "g_1", hlc),
          entity_group_update("eg_g2", "todo_multi", "g_2", hlc)
        ]
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
        updates: [
          %{
            id: "upd_todo",
            subject_id: "todo_same_group",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
            }
          },
          entity_group_update("eg_same_group", "todo_same_group", "g_bench", hlc)
        ]
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
        updates: [
          %{
            id: "upd_todo",
            subject_id: "todo_link",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
            }
          },
          entity_group_update("eg_member", "todo_link", "g_1", hlc),
          relationship_update("rel_domain", "todo_link", "doc_1", hlc)
        ]
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
        updates: [entity_group_update("eg_1", "todo_move", "g_1", hlc)]
      }

      second = %{
        id: "act_second",
        actor_id: "actor_1",
        hlc: hlc,
        updates: [entity_group_update("eg_1", "todo_move", "g_2", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([first], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([second], writer_name)

      assert EntityGroupCache.entity_groups("todo_move", eg_table) == ["g_2"]

      cf = RocksDB.cf_group_actions(rocks_name)
      assert {:ok, "act_first"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert {:ok, "act_second"} = RocksDB.get(cf, group_gsn_key("g_2", 2), name: rocks_name)
    end
  end

  describe "batch_committed groups snapshot (#251)" do
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
        updates: [entity_group_update("eg_snapshot", "todo_snapshot", "g_snapshot", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put], writer_name)
      assert_receive {:batch_committed, 1, 1, %{1 => ["g_snapshot"]}}

      delete = %{
        id: "act_snapshot_delete",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_snapshot_delete",
            subject_id: "eg_snapshot",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete], writer_name)

      # The by-id entry is gone once the caches update, so the delete's
      # group set must come from the same pre-update pass that built
      # cf_group_actions — not from a later re-resolution.
      assert EntityGroupCache.entity_groups("todo_snapshot", entity_groups) == []
      assert_receive {:batch_committed, 2, 2, %{2 => ["g_snapshot"]}}
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
        updates: [entity_group_update("eg_old", "todo_set", "g_old", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([seed], writer_name)
      assert_receive {:batch_committed, 1, 1, %{1 => ["g_old"]}}

      swap = %{
        id: "act_setgroups_swap",
        actor_id: "actor_1",
        hlc: generate_hlc(),
        updates: [
          entity_group_update("eg_new", "todo_set", "g_new", hlc),
          %{
            id: "upd_setgroups_delete",
            subject_id: "eg_old",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ]
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

      assert_receive {:batch_committed, 2, 2, %{2 => groups}}
      assert Enum.sort(groups) == ["g_new", "g_old"]
    end
  end

  defp entity_group_update(id, entity_id, group_id, hlc) do
    %{
      id: id,
      subject_id: id,
      subject_type: "entityGroup",
      method: :put,
      data: %{
        "fields" => %{
          "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
        }
      }
    }
  end

  defp group_member_update(id, actor_id, group_id, permissions, hlc) do
    %{
      id: id,
      subject_id: id,
      subject_type: "groupMember",
      method: :put,
      data: %{
        "fields" => %{
          "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
          "permissions" => %{"type" => "lww", "value" => permissions, "hlc" => hlc}
        }
      }
    }
  end

  defp relationship_update(id, source_id, target_id, hlc) do
    %{
      id: id,
      subject_id: id,
      subject_type: "relationship",
      method: :put,
      data: %{
        "fields" => %{
          "source_id" => %{"type" => "lww", "value" => source_id, "hlc" => hlc},
          "target_id" => %{"type" => "lww", "value" => target_id, "hlc" => hlc},
          "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
          "field" => %{"type" => "lww", "value" => "owns", "hlc" => hlc}
        }
      }
    }
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

  defp to_storage_format(action, gsn) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "gsn" => gsn,
      "updates" =>
        Enum.map(action.updates, fn update ->
          %{
            "id" => update.id,
            "subject_id" => update.subject_id,
            "subject_type" => update.subject_type,
            "method" => Atom.to_string(update.method),
            "data" => update.data
          }
        end)
    }
  end
end
