defmodule EbbServer.Storage.EntityStoreTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, RocksDB, SQLite, SystemCache, Writer}
  import EbbServer.TestHelpers

  setup do
    {:ok, _} = SystemCache.start_link()

    dir = tmp_dir(%{module: __MODULE__, test: "setup"})

    rocks_name = :"rocks_#{System.unique_integer([:positive])}"
    {:ok, rocks_pid} = RocksDB.start_link(data_dir: dir, name: rocks_name)

    sqlite_name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, sqlite_pid} = SQLite.start_link(data_dir: dir, name: sqlite_name)

    writer_name = :"writer_#{System.unique_integer([:positive])}"
    {:ok, writer_pid} = Writer.start_link(name: writer_name, rocks_name: rocks_name)

    on_exit(fn ->
      if Process.alive?(writer_pid), do: GenServer.stop(writer_pid)
      if Process.alive?(sqlite_pid), do: GenServer.stop(sqlite_pid)
      if Process.alive?(rocks_pid), do: GenServer.stop(rocks_pid)
      if pid = Process.whereis(SystemCache), do: GenServer.stop(pid)
    end)

    %{dir: dir, rocks_name: rocks_name, sqlite_name: sqlite_name, writer_name: writer_name}
  end

  describe "get/2" do
    test "materialize a PUT (first read)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id, "subject_type" => "todo"})
      action = sample_action(%{"updates" => [update]})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert {:ok, entity} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name
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
      writer_name: writer_name
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id, "subject_type" => "todo"})
      action = sample_action(%{"updates" => [update]})

      Writer.write_actions([action], writer_name)
      EntityStore.get(entity_id, "a_test", rocks_name: rocks_name, sqlite_name: sqlite_name)

      assert {:ok, cached} = SQLite.get_entity(entity_id, sqlite_name)
      assert cached.id == entity_id
      assert cached.type == "todo"
    end

    test "dirty bit is cleared after materialization", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id})
      action = sample_action(%{"updates" => [update]})

      Writer.write_actions([action], writer_name)
      assert SystemCache.is_dirty?(entity_id)

      EntityStore.get(entity_id, "a_test", rocks_name: rocks_name, sqlite_name: sqlite_name)

      refute SystemCache.is_dirty?(entity_id)
    end

    test "second read is clean (no re-materialization)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    } do
      entity_id = "todo_abc"
      update = sample_update(%{"subject_id" => entity_id})
      action = sample_action(%{"updates" => [update]})

      Writer.write_actions([action], writer_name)

      assert {:ok, entity1} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name
               )

      assert {:ok, entity2} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name
               )

      assert entity1.id == entity2.id
      assert entity1.last_gsn == entity2.last_gsn
      refute SystemCache.is_dirty?(entity_id)
    end

    test "entity not found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name
    } do
      assert :not_found =
               EntityStore.get("nonexistent", "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name
               )
    end

    test "LWW merge with PATCH — newer value wins", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity.data["fields"]["title"]["value"] == "Second"
    end

    test "LWW merge — older PATCH doesn't overwrite", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity.data["fields"]["title"]["value"] == "Newer"
    end

    test "incremental materialization", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity1.data["fields"]["title"]["value"] == "First"
      refute Map.has_key?(entity1.data["fields"], "description")

      Writer.write_actions([patch_action], writer_name)

      assert {:ok, entity2} =
               EntityStore.get(entity_id, "a_test",
                 rocks_name: rocks_name,
                 sqlite_name: sqlite_name
               )

      assert entity2.data["fields"]["title"]["value"] == "First"
      assert entity2.data["fields"]["description"]["value"] == "Added later"
      assert entity2.last_gsn == 2
    end

    test "LWW tiebreaker — equal HLCs resolved by higher update ID wins", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity.data["fields"]["title"]["value"] == "Higher ID"
      assert entity.data["fields"]["title"]["update_id"] == "upd_zzz"
    end

    test "LWW tiebreaker — lower update ID does not overwrite", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity.data["fields"]["title"]["value"] == "Higher ID"
      assert entity.data["fields"]["title"]["update_id"] == "upd_zzz"
    end

    test "delete-only entity returns :not_found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )
    end

    test "PUT followed by DELETE returns :not_found", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )
    end

    test "PATCH resurrects deleted entity and clears deleted_hlc", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
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
                 sqlite_name: sqlite_name
               )

      assert entity.deleted_hlc == nil
      assert entity.deleted_by == nil
      assert entity.data["fields"]["title"]["value"] == "Buy milk"
      assert entity.data["fields"]["description"]["value"] == "Updated"
    end
  end
end
