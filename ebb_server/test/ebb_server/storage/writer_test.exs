defmodule EbbServer.Storage.WriterTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{RocksDB, SystemCache, Writer}
  import EbbServer.TestHelpers

  defp start_isolated_cache do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    cache_name = :"ebb_cache_#{unique_id}"
    gm_table = :"ebb_gm_#{unique_id}"
    rel_table = :"ebb_rel_#{unique_id}"
    rbg_table = :"ebb_rbg_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)

    {:ok, _pid} =
      SystemCache.start_link(
        name: cache_name,
        dirty_set: dirty_set_name,
        gsn_counter: counter,
        gsn_counter_name: gsn_counter_name,
        initial_gsn: 0,
        group_members: gm_table,
        relationships: rel_table,
        relationships_by_group: rbg_table
      )

    on_exit(fn ->
      if pid = Process.whereis(cache_name), do: GenServer.stop(pid)
      :persistent_term.erase(gsn_counter_name)
    end)

    %{
      dirty_set: dirty_set_name,
      gsn_counter: counter,
      group_members: gm_table,
      relationships: rel_table,
      relationships_by_group: rbg_table
    }
  end

  defp start_rocks do
    unique_id = System.unique_integer([:positive])
    dir = tmp_dir(%{module: __MODULE__, test: "rocks_#{unique_id}"})
    name = :"rocks_#{unique_id}"
    {:ok, pid} = RocksDB.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid, dir: dir}
  end

  defp start_writer(opts) do
    name = :"writer_#{System.unique_integer([:positive])}"

    {:ok, pid} =
      Writer.start_link(
        name: name,
        rocks_name: opts.rocks_name,
        dirty_set: opts.dirty_set,
        gsn_counter: opts.gsn_counter,
        group_members: opts.group_members,
        relationships: opts.relationships,
        relationships_by_group: opts.relationships_by_group
      )

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid}
  end

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

      assert SystemCache.dirty?("todo_abc", dirty_set)
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
               SystemCache.get_actor_groups("actor_1", gm_table)

      assert ["todo.create"] = SystemCache.get_permissions("actor_1", "group_1", gm_table)
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

      assert "group_1" = SystemCache.get_entity_group("todo_1", rel_table)
      assert ["todo_1"] = SystemCache.get_group_entities("group_1", rbg_table)
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
      assert [_] = SystemCache.get_actor_groups("actor_1", gm_table)

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
      assert [] = SystemCache.get_actor_groups("actor_1", gm_table)
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
      assert "group_1" = SystemCache.get_entity_group("todo_1", rel_table)

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
      assert nil == SystemCache.get_entity_group("todo_1", rel_table)
    end

    test "non-system entity updates do not affect ETS",
         %{
           writer_name: writer_name,
           group_members: gm_table,
           relationships: rel_table
         } do
      action = validated_action()

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert [] = SystemCache.get_actor_groups("a_test", gm_table)
      assert nil == SystemCache.get_entity_group("todo_test", rel_table)
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

      assert [%{group_id: "group_1"}] = SystemCache.get_actor_groups("actor_1", gm_table)
      assert nil == SystemCache.get_entity_group("todo_1", rel_table)
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
