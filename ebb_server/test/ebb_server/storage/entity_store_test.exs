defmodule EbbServer.Storage.EntityStoreTest do
  @moduledoc """
  Behavioral tests for EntityStore - the entity read layer.

  EntityStore provides read access to entities by combining:
  - SQLite: Cached/materialized entity state
  - RocksDB: Source-of-truth action log

  ## Key Behaviors Tested

  - On-demand materialization: dirty entities are reconstructed from RocksDB
  - LWW (Last-Writer-Wins) merge semantics using HLC timestamps
  - HLC tiebreaker: equal timestamps resolved by lexicographic update_id
  - Dirty tracking: entities marked dirty after write, clean after read
  - Incremental materialization: only replays actions after last known GSN
  - Delete handling: soft deletes, resurrects, not_found cases

  ## Architecture Context

  EntityStore is NOT a GenServer - it composes SQLite and RocksDB reads.
  It delegates writes to Writer, which updates both stores.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    DirtyTracker,
    EntityStore,
    SQLite,
    Writer
  }

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{name: writer_name} = start_writer(Map.put(cache, :rocks_name, rocks_name))

    Map.merge(cache, %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    })
  end

  describe "get/2" do
    test "materialize a PUT (first read)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = validated_update(%{subject_id: entity_id, subject_type: "todo"})
      action = validated_action(%{updates: [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.id == entity_id
      assert entity.type == "todo"
      assert entity.last_gsn == 1
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
      assert entity.data["fields"]["completed"]["value"] == false
    end

    test "entity is cached in SQLite after materialization", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = validated_update(%{subject_id: entity_id, subject_type: "todo"})
      action = validated_action(%{updates: [update]})

      Writer.write_actions([action], writer_name)

      EntityStore.get(entity_id, "a_test",
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )

      assert {:ok, cached} = SQLite.get_entity(entity_id, sqlite_name)
      assert cached.id == entity_id
      assert cached.type == "todo"
    end

    test "dirty bit is cleared after materialization", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = validated_update(%{"subject_id" => entity_id})
      action = validated_action(%{updates: [update]})

      Writer.write_actions([action], writer_name)
      assert DirtyTracker.dirty?(entity_id, dirty_set)

      EntityStore.get(entity_id, "a_test",
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )

      refute DirtyTracker.dirty?(entity_id, dirty_set)
    end

    test "materialize leaves a provisional mark in place", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_provisional"
      update = validated_update(%{subject_id: entity_id})

      Writer.write_actions([validated_action(%{updates: [update]})], writer_name)

      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

      assert {:ok, _entity} = EntityStore.get(entity_id, "a_test", opts)
      refute DirtyTracker.dirty?(entity_id, dirty_set)

      # A Writer writes this before its commit attempt and settles it once
      # the commit returns. Until then the read may materialize, but it must
      # not clear the mark and reopen the window it exists to close.
      DirtyTracker.mark_pending_batch([entity_id], dirty_set)

      assert {:ok, entity} = EntityStore.materialize(entity_id, opts)
      assert entity.last_gsn == 1
      assert DirtyTracker.pending?(DirtyTracker.dirty_generation(entity_id, dirty_set))

      :ok = DirtyTracker.mark_dirty_batch([entity_id], dirty_set)
      assert {:ok, _entity} = EntityStore.materialize(entity_id, opts)
      refute DirtyTracker.dirty?(entity_id, dirty_set)
    end

    test "materialize leaves a provisional mark in place for an unknown entity", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_unknown_provisional"
      DirtyTracker.mark_pending_batch([entity_id], dirty_set)

      assert :not_found =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert DirtyTracker.pending?(DirtyTracker.dirty_generation(entity_id, dirty_set))
    end

    test "second read is clean (no re-materialization)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = validated_update(%{"subject_id" => entity_id})
      action = validated_action(%{updates: [update]})

      Writer.write_actions([action], writer_name)

      assert {:ok, entity1} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert {:ok, entity2} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity1.id == entity2.id
      assert entity1.last_gsn == entity2.last_gsn
      refute DirtyTracker.dirty?(entity_id, dirty_set)
    end

    test "entity not found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      assert :not_found =
               EntityStore.get("nonexistent", "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )
    end

    test "LWW merge with PATCH — newer value wins", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "First", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      patch_action =
        validated_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_patch",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Second", "hlc" => hlc_from(2_000)}
                }
              }
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)
      Writer.write_actions([patch_action], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.data["fields"]["title"]["value"] == "Second"
    end

    test "LWW merge — older PATCH doesn't overwrite", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Newer", "hlc" => hlc_from(2_000)}
                }
              }
            })
          ]
        })

      patch_action =
        validated_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_patch",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Older", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)
      Writer.write_actions([patch_action], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.data["fields"]["title"]["value"] == "Newer"
    end

    test "incremental materialization", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "First", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      patch_action =
        validated_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_patch",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "description" => %{
                    "type" => "lww",
                    "value" => "Added later",
                    "hlc" => hlc_from(2_000)
                  }
                }
              }
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)

      assert {:ok, entity1} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity1.data["fields"]["title"]["value"] == "First"
      refute Map.has_key?(entity1.data["fields"], "description")

      Writer.write_actions([patch_action], writer_name)

      assert {:ok, entity2} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity2.data["fields"]["title"]["value"] == "First"
      assert entity2.data["fields"]["description"]["value"] == "Added later"
      assert entity2.last_gsn == 2
    end

    test "LWW tiebreaker — equal HLCs resolved by higher update ID wins", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"

      action1 =
        validated_action(%{
          "id" => "act_aaa",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_aaa",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Lower ID", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      action2 =
        validated_action(%{
          "id" => "act_zzz",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_zzz",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Higher ID", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      Writer.write_actions([action1], writer_name)
      Writer.write_actions([action2], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.data["fields"]["title"]["value"] == "Higher ID"
      assert entity.data["fields"]["title"]["update_id"] == "upd_zzz"
    end

    test "LWW tiebreaker — lower update ID does not overwrite", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"

      action1 =
        validated_action(%{
          "id" => "act_zzz",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_zzz",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Higher ID", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      action2 =
        validated_action(%{
          "id" => "act_aaa",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_aaa",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Lower ID", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      Writer.write_actions([action1], writer_name)
      Writer.write_actions([action2], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.data["fields"]["title"]["value"] == "Higher ID"
      assert entity.data["fields"]["title"]["update_id"] == "upd_zzz"
    end

    test "delete-only entity returns :not_found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_deleted_only"

      delete_update =
        validated_update(%{
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "delete"
        })

      action = validated_action(%{updates: [delete_update]})
      Writer.write_actions([action], writer_name)

      assert :not_found =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )
    end

    test "PUT followed by DELETE returns :not_found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_put_then_delete"

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{
                    "type" => "lww",
                    "value" => "To be deleted",
                    "hlc" => hlc_from(1_000)
                  }
                }
              }
            })
          ]
        })

      delete_update =
        validated_update(%{
          "id" => "upd_delete",
          "subject_id" => entity_id,
          "method" => "delete"
        })

      delete_action =
        validated_action(%{
          "id" => "act_delete",
          "hlc" => hlc_from(2_000),
          "updates" => [delete_update]
        })

      Writer.write_actions([put_action], writer_name)
      Writer.write_actions([delete_action], writer_name)

      assert :not_found =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert :not_found =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )
    end

    test "a second read after a delete returns :not_found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_delete_repro"

      opts = [
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      ]

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      delete_action =
        validated_action(%{
          "id" => "act_delete",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_delete",
              "subject_id" => entity_id,
              "method" => "delete"
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)

      assert {:ok, alive} = EntityStore.get(entity_id, "a_test", opts)
      assert alive.data["fields"]["title"]["value"] == "Buy milk"

      Writer.write_actions([delete_action], writer_name)

      # The delete materializes, then a second read must not resurrect it
      # by reading the old, un-tombstoned row back out of the cache.
      assert :not_found = EntityStore.get(entity_id, "a_test", opts)

      assert {:ok, tombstone} = SQLite.get_entity(entity_id, sqlite_name)
      assert tombstone.deleted_hlc != nil

      assert :not_found = EntityStore.get(entity_id, "a_test", opts)
    end

    test "a resurrect after the delete was materialized preserves prior fields", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_delete_then_resurrect"

      opts = [
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      ]

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      delete_action =
        validated_action(%{
          "id" => "act_delete",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_delete",
              "subject_id" => entity_id,
              "method" => "delete"
            })
          ]
        })

      patch_action =
        validated_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(3_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_patch",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "description" => %{
                    "type" => "lww",
                    "value" => "Updated",
                    "hlc" => hlc_from(3_000)
                  }
                }
              }
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)
      assert {:ok, _materialized} = EntityStore.get(entity_id, "a_test", opts)

      Writer.write_actions([delete_action], writer_name)
      assert :not_found = EntityStore.get(entity_id, "a_test", opts)
      assert :not_found = EntityStore.get(entity_id, "a_test", opts)

      # The patch resurrects over the tombstone row, so the title that only
      # lived in the tombstone's stored data must still be present.
      Writer.write_actions([patch_action], writer_name)
      assert {:ok, entity} = EntityStore.get(entity_id, "a_test", opts)

      assert entity.deleted_hlc == nil
      assert entity.deleted_by == nil
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
      assert entity.data["fields"]["description"]["value"] == "Updated"
    end

    test "PATCH resurrects deleted entity and clears deleted_hlc", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_resurrect"

      put_action =
        validated_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_put",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      delete_update =
        validated_update(%{
          "id" => "upd_delete",
          "subject_id" => entity_id,
          "method" => "delete"
        })

      delete_action =
        validated_action(%{
          "id" => "act_delete",
          "hlc" => hlc_from(2_000),
          "updates" => [delete_update]
        })

      patch_action =
        validated_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(3_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_patch",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "description" => %{
                    "type" => "lww",
                    "value" => "Updated",
                    "hlc" => hlc_from(3_000)
                  }
                }
              }
            })
          ]
        })

      Writer.write_actions([put_action], writer_name)
      Writer.write_actions([delete_action], writer_name)
      Writer.write_actions([patch_action], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity.deleted_hlc == nil
      assert entity.deleted_by == nil
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
      assert entity.data["fields"]["description"]["value"] == "Updated"
    end

    test "a mark landing during materialization survives the clear", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_race"

      action1 =
        validated_action(%{
          "id" => "act_1",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_1",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "First", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      action2 =
        validated_action(%{
          "id" => "act_2",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_2",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "description" => %{
                    "type" => "lww",
                    "value" => "Second",
                    "hlc" => hlc_from(2_000)
                  }
                }
              }
            })
          ]
        })

      action3 =
        validated_action(%{
          "id" => "act_3",
          "hlc" => hlc_from(3_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_3",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Third", "hlc" => hlc_from(3_000)}
                }
              }
            })
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action1], writer_name)

      assert {:ok, entity1} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity1.last_gsn == 1
      refute DirtyTracker.dirty?(entity_id, dirty_set)

      assert {:ok, {2, 2}, []} = Writer.write_actions([action2], writer_name)
      assert DirtyTracker.dirty?(entity_id, dirty_set)

      # action3 commits after the materializer scanned but before it clears.
      assert {:ok, mid_materialization} =
               EntityStore.materialize(entity_id,
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set,
                 after_scan: fn -> Writer.write_actions([action3], writer_name) end
               )

      assert mid_materialization.last_gsn == 2
      assert DirtyTracker.dirty?(entity_id, dirty_set)

      assert {:ok, entity2} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity2.data["fields"]["title"]["value"] == "Third"
      assert entity2.last_gsn == 3
      refute DirtyTracker.dirty?(entity_id, dirty_set)
    end

    test "a newer materialization is not regressed by an older one", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_m1m2"

      action1 =
        validated_action(%{
          "id" => "act_1",
          "hlc" => hlc_from(1_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_1",
              "subject_id" => entity_id,
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "First", "hlc" => hlc_from(1_000)}
                }
              }
            })
          ]
        })

      action2 =
        validated_action(%{
          "id" => "act_2",
          "hlc" => hlc_from(2_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_2",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Second", "hlc" => hlc_from(2_000)}
                }
              }
            })
          ]
        })

      action3 =
        validated_action(%{
          "id" => "act_3",
          "hlc" => hlc_from(3_000),
          "updates" => [
            validated_update(%{
              "id" => "upd_3",
              "subject_id" => entity_id,
              "method" => "patch",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => "Third", "hlc" => hlc_from(3_000)}
                }
              }
            })
          ]
        })

      assert {:ok, {1, 1}, []} = Writer.write_actions([action1], writer_name)

      # Materialize E at GSN 1 and leave it clean.
      assert {:ok, entity1} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name,
                 dirty_set: dirty_set
               )

      assert entity1.last_gsn == 1
      assert entity1.data["fields"]["title"]["value"] == "First"
      refute DirtyTracker.dirty?(entity_id, dirty_set)

      # GSN 2 makes E dirty; M1 observes this mark.
      assert {:ok, {2, 2}, []} = Writer.write_actions([action2], writer_name)
      assert DirtyTracker.dirty?(entity_id, dirty_set)

      opts = [
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      ]

      # M1 scans [gsn2] before the hook. The hook lands GSN 3 and lets a
      # second materializer M2 replay [gsn2, gsn3] and upsert last_gsn = 3.
      # M1 then resumes and upserts last_gsn = 2 over the newer row.
      hook = fn ->
        assert {:ok, {3, 3}, []} = Writer.write_actions([action3], writer_name)
        assert {:ok, entity_m2} = EntityStore.materialize(entity_id, opts)
        assert entity_m2.last_gsn == 3
        assert entity_m2.data["fields"]["title"]["value"] == "Third"
      end

      assert {:ok, m1_result} =
               EntityStore.materialize(entity_id, Keyword.put(opts, :after_scan, hook))

      # M1's stale write was rejected; it still returns its own snapshot.
      assert m1_result.last_gsn == 2

      # The entity is clean again, so every later read takes the cache path.
      refute DirtyTracker.dirty?(entity_id, dirty_set)

      # Permanent staleness: the clean read serves M1's GSN 2 row, not M2's GSN 3.
      assert {:ok, entity_final} = EntityStore.get(entity_id, "a_test", opts)
      assert entity_final.data["fields"]["title"]["value"] == "Third"

      # Root cause: M1's stale upsert regressed last_gsn from 3 back to 2.
      assert {:ok, row_after} = SQLite.get_entity(entity_id, sqlite_name)
      assert row_after.last_gsn == 3
    end
  end

  describe "durable commit and read ordering" do
    test "a read after the durable commit does not see stale SQLite", ctx do
      entity_id = "todo_after_commit"

      action =
        validated_action(%{
          id: "act_after_commit",
          updates: [validated_update(%{subject_id: entity_id, subject_type: "todo"})]
        })

      opts = [
        rocks_name: ctx.rocks_name,
        sqlite_name: ctx.sqlite_name,
        dirty_set: ctx.dirty_set
      ]

      test_pid = self()

      # Runs inside the Writer immediately after `commit_fn` returns durably
      # and before the mark is settled: the exact window #295 is about.
      after_commit = fn ->
        send(test_pid, {:read_after_commit, EntityStore.get(entity_id, "a_test", opts)})
      end

      %{name: writer_name} = start_writer(Map.put(ctx, :after_commit, after_commit))

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert_receive {:read_after_commit, result}
      assert {:ok, entity} = result
      assert entity.last_gsn == 1
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
    end
  end
end
