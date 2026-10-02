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
      group_members_by_id: group_members_by_id,
      relationships: relationships,
      relationships_by_group: relationships_by_group,
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
        relationships: relationships,
        relationships_by_group: relationships_by_group,
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
      relationships: relationships,
      relationships_by_group: relationships_by_group,
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
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      relationships: relationships,
      relationships_by_group: relationships_by_group,
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
          relationships: relationships,
          relationships_by_group: relationships_by_group,
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
          relationships: relationships,
          relationships_by_group: relationships_by_group,
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
              "fields" => %{
                "source_id" => %{"type" => "lww", "value" => "todo_1", "hlc" => hlc},
                "target_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
                "field" => %{"type" => "lww", "value" => "group", "hlc" => hlc},
                "kind" => %{"type" => "lww", "value" => "member", "hlc" => hlc}
              }
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
              "fields" => %{
                "source_id" => %{"type" => "lww", "value" => "todo_1", "hlc" => hlc},
                "target_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
                "field" => %{"type" => "lww", "value" => "group", "hlc" => hlc},
                "kind" => %{"type" => "lww", "value" => "member", "hlc" => hlc}
              }
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
          relationship_update("rel_g1", "todo_multi", "g_1", "member", hlc),
          relationship_update("rel_g2", "todo_multi", "g_2", "member", hlc)
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_multi"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert {:ok, "act_multi"} = RocksDB.get(cf, group_gsn_key("g_2", 1), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("g_3", 1), name: rocks_name)
    end

    test "a link edge to a non-group target adds no group index", %{
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
          relationship_update("rel_member", "todo_link", "g_1", "member", hlc),
          relationship_update("rel_domain", "todo_link", "doc_1", "link", hlc)
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      cf = RocksDB.cf_group_actions(rocks_name)

      assert {:ok, "act_link"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert :not_found = RocksDB.get(cf, group_gsn_key("doc_1", 1), name: rocks_name)
    end

    test "a re-put moves the source to the new group for later writes", %{
      writer_name: writer_name,
      rocks_name: rocks_name,
      relationships: rel_table
    } do
      hlc = generate_hlc()

      first = %{
        id: "act_first",
        actor_id: "actor_1",
        hlc: hlc,
        updates: [relationship_update("rel_1", "todo_move", "g_1", "member", hlc)]
      }

      second = %{
        id: "act_second",
        actor_id: "actor_1",
        hlc: hlc,
        updates: [relationship_update("rel_1", "todo_move", "g_2", "member", hlc)]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([first], writer_name)
      assert {:ok, {2, 2}, []} = Writer.write_actions([second], writer_name)

      assert RelationshipCache.membership_groups("todo_move", rel_table) == ["g_2"]

      cf = RocksDB.cf_group_actions(rocks_name)
      assert {:ok, "act_first"} = RocksDB.get(cf, group_gsn_key("g_1", 1), name: rocks_name)
      assert {:ok, "act_second"} = RocksDB.get(cf, group_gsn_key("g_2", 2), name: rocks_name)
    end
  end

  describe "batch_committed groups snapshot (#251)" do
    test "carries the pre-update group set for a relationship delete", %{
      rocks_name: rocks_name,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      relationships: relationships,
      relationships_by_group: relationships_by_group,
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
          relationships: relationships,
          relationships_by_group: relationships_by_group,
          relationships_by_id: relationships_by_id,
          fan_out_router: router_name
        })

      hlc = generate_hlc()

      put = %{
        id: "act_snapshot_put",
        actor_id: "actor_1",
        hlc: hlc,
        updates: [
          relationship_update("rel_snapshot", "todo_snapshot", "g_snapshot", "member", hlc)
        ]
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
            subject_id: "rel_snapshot",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:ok, {2, 2}, []} = Writer.write_actions([delete], writer_name)

      # The by-id entry is gone once the caches update, so the delete's
      # group set must come from the same pre-update pass that built
      # cf_group_actions — not from a later re-resolution.
      assert RelationshipCache.membership_groups("todo_snapshot", relationships) == []
      assert_receive {:batch_committed, 2, 2, %{2 => ["g_snapshot"]}}
    end
  end

  defp relationship_update(id, source_id, target_id, kind, hlc) do
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
          "field" => %{"type" => "lww", "value" => "group", "hlc" => hlc},
          "kind" => %{"type" => "lww", "value" => kind, "hlc" => hlc}
        }
      }
    }
  end

  defp group_gsn_key(group_id, gsn) do
    <<group_id::binary, gsn::unsigned-big-integer-size(64)>>
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
