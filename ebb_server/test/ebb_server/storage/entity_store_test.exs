defmodule EbbServer.Storage.EntityStoreTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, RocksDB, SQLite, SystemCache, Writer}
  import EbbServer.TestHelpers

  defp start_isolated_cache do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    cache_name = :"ebb_cache_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)

    {:ok, _pid} =
      SystemCache.start_link(
        name: cache_name,
        dirty_set: dirty_set_name,
        gsn_counter: counter,
        gsn_counter_name: gsn_counter_name,
        initial_gsn: 0
      )

    on_exit(fn ->
      if pid = Process.whereis(cache_name), do: GenServer.stop(pid)
      :persistent_term.erase(gsn_counter_name)
    end)

    %{dirty_set: dirty_set_name, gsn_counter: counter}
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

  defp start_sqlite(dir) do
    name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, pid} = SQLite.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid}
  end

  defp start_writer(opts) do
    name = :"writer_#{System.unique_integer([:positive])}"

    {:ok, pid} =
      Writer.start_link(
        name: name,
        rocks_name: opts.rocks_name,
        dirty_set: opts.dirty_set,
        gsn_counter: opts.gsn_counter
      )

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    %{name: name, pid: pid}
  end

  setup do
    %{dirty_set: dirty_set, gsn_counter: gsn_counter} = start_isolated_cache()
    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{name: writer_name} =
      start_writer(%{rocks_name: rocks_name, dirty_set: dirty_set, gsn_counter: gsn_counter})

    %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    }
  end

  describe "get/2" do
    test "materialize a PUT (first read)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id, "subject_type" => "todo"})
      action = sample_action(%{"updates" => [update]})

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
      update = sample_update(%{"subject_id" => entity_id, "subject_type" => "todo"})
      action = sample_action(%{"updates" => [update]})

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
      update = sample_update(%{"subject_id" => entity_id})
      action = sample_action(%{"updates" => [update]})

      Writer.write_actions([action], writer_name)
      assert SystemCache.is_dirty?(entity_id, dirty_set)

      EntityStore.get(entity_id, "a_test",
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )

      refute SystemCache.is_dirty?(entity_id, dirty_set)
    end

    test "second read is clean (no re-materialization)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id})
      action = sample_action(%{"updates" => [update]})

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
      refute SystemCache.is_dirty?(entity_id, dirty_set)
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
        sample_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(2_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(2_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(2_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_aaa",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_zzz",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_zzz",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_action(%{
          "id" => "act_aaa",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_update(%{
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "delete"
        })

      action = sample_action(%{"updates" => [delete_update]})
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
        sample_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_update(%{
          "id" => "upd_delete",
          "subject_id" => entity_id,
          "method" => "delete"
        })

      delete_action =
        sample_action(%{
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
    end

    test "PATCH resurrects deleted entity and clears deleted_hlc", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      entity_id = "todo_resurrect"

      put_action =
        sample_action(%{
          "id" => "act_put",
          "hlc" => hlc_from(1_000),
          "updates" => [
            sample_update(%{
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
        sample_update(%{
          "id" => "upd_delete",
          "subject_id" => entity_id,
          "method" => "delete"
        })

      delete_action =
        sample_action(%{
          "id" => "act_delete",
          "hlc" => hlc_from(2_000),
          "updates" => [delete_update]
        })

      patch_action =
        sample_action(%{
          "id" => "act_patch",
          "hlc" => hlc_from(3_000),
          "updates" => [
            sample_update(%{
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
  end
end
