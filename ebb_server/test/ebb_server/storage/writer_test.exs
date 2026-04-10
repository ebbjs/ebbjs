defmodule EbbServer.Storage.WriterTest do
  @moduledoc """
  Behavioral tests for Writer - the action persistence layer.

  Writer receives validated actions and persists them to RocksDB,
  assigning GSNs (Global Sequence Numbers) for ordering.

  ## Key Behaviors Tested

  - GSN assignment: monotonic, gap-free sequence numbers
  - Column family population: all 5 RocksDB CFs written correctly
  - Dirty tracking: marks entities dirty for later materialization
  - System cache updates: GroupCache and RelationshipCache kept in sync
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
      relationships: relationships,
      relationships_by_group: relationships_by_group
    } = start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = start_rocks()

    %{name: writer_name} =
      start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: gsn_counter,
        group_members: group_members,
        relationships: relationships,
        relationships_by_group: relationships_by_group
      })

    %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      rocks_dir: rocks_dir,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      relationships: relationships,
      relationships_by_group: relationships_by_group
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

  describe "all 5 column families are populated" do
    test "writes to all column families for one action with one update", %{
      writer_name: writer_name,
      rocks_name: rocks_name
    } do
      update = validated_update(%{subject_id: "todo_test_123", subject_type: "todo"})
      action = validated_action(%{updates: [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      stored_action = to_storage_format(action, 1)
      action_etf = :erlang.term_to_binary(stored_action)

      assert {:ok, ^action_etf} =
               RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      update_key = RocksDB.encode_update_key(action.id, hd(action.updates).id)
      update_etf = :erlang.term_to_binary(update)

      assert {:ok, ^update_etf} =
               RocksDB.get(RocksDB.cf_updates(rocks_name), update_key, name: rocks_name)

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

  describe "durability" do
    test "data survives Writer and RocksDB restart", %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter
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
          gsn_counter: gsn_counter
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
          gsn_counter: gsn_counter
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

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([action1, action2], writer_name)

      gsn_key = RocksDB.encode_gsn_key(1)
      assert {:ok, _} = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key, name: rocks_name)

      gsn_key2 = RocksDB.encode_gsn_key(2)
      assert :not_found = RocksDB.get(RocksDB.cf_actions(rocks_name), gsn_key2, name: rocks_name)
    end
  end

  describe "system cache updates" do
    test "groupMember PUT updates ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           relationships: rel_table
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

    test "relationship PUT updates ETS",
         %{
           writer_name: writer_name,
           relationships: rel_table,
           relationships_by_group: rbg_table
         } do
      hlc = generate_hlc()
      rel_id = "rel_" <> Nanoid.generate()

      action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: rel_id,
            subject_type: "relationship",
            method: :put,
            data: %{
              "source_id" => "todo_1",
              "target_id" => "group_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert "group_1" = RelationshipCache.get_entity_group("todo_1", rel_table)
      assert ["todo_1"] = RelationshipCache.get_group_entities("group_1", rbg_table)
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

    test "relationship DELETE removes from ETS",
         %{
           writer_name: writer_name,
           relationships: rel_table,
           relationships_by_group: rbg_table
         } do
      hlc = generate_hlc()
      rel_id = "rel_" <> Nanoid.generate()

      put_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: "actor_1",
        hlc: hlc,
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: rel_id,
            subject_type: "relationship",
            method: :put,
            data: %{
              "source_id" => "todo_1",
              "target_id" => "group_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([put_action], writer_name)
      assert "group_1" = RelationshipCache.get_entity_group("todo_1", rel_table)

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
      assert nil == RelationshipCache.get_entity_group("todo_1", rel_table)
    end

    test "non-system entity updates do not affect ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           relationships: rel_table
         } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [] = GroupCache.get_actor_groups("a_test", gm_table)
      assert nil == RelationshipCache.get_entity_group("todo_test", rel_table)
    end

    test "mixed batch - system and user entities",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           relationships: rel_table
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
      assert nil == RelationshipCache.get_entity_group("todo_1", rel_table)
    end
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
