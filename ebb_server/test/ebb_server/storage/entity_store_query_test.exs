defmodule EbbServer.Storage.EntityStoreQueryTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{DirtyTracker, EntityStore, SQLite, Writer}

  import EbbServer.TestHelpers

  defp bootstrap_group(group_id, actor_id, writer_name) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    gm_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: gm_id,
          subject_type: "groupMember",
          method: :put,
          data: %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => ["todo.create"], "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn1, gsn1}, []} = Writer.write_actions([gm_action], writer_name)

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([eg_action], writer_name)
    %{gm_id: gm_id, eg_id: eg_id, gsn: gsn2}
  end

  defp write_todo(todo_id, group_id, actor_id, writer_name, opts \\ []) do
    title = Keyword.get(opts, :title, "Test todo")
    completed = Keyword.get(opts, :completed, false)
    hlc = generate_hlc()

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: todo_id,
          subject_type: "todo",
          method: :put,
          data: %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => title, "hlc" => hlc},
              "completed" => %{"type" => "lww", "value" => completed, "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn, gsn}, []} = Writer.write_actions([action], writer_name)

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => todo_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([eg_action], writer_name)
    %{todo_id: todo_id, eg_id: eg_id, gsn: gsn2}
  end

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: gm_table,
      group_members_by_id: gm_by_id_table,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id_table,
      entity_groups_by_group: eg_by_group_table,
      relationships: rel_table,
      relationships_by_id: rbi_table
    } = start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{name: writer_name} =
      start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: gsn_counter,
        group_members: gm_table,
        group_members_by_id: gm_by_id_table,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table,
        relationships: rel_table,
        relationships_by_id: rbi_table
      })

    %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set,
      gm_table: gm_table,
      rel_table: rel_table
    }
  end

  describe "EntityStore.query/3" do
    test "query returns entities of the correct type", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_query_type_#{System.unique_integer([:positive])}"
      actor_id = "a_query_type_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_id, writer_name)

      write_todo("todo_type_1", group_id, actor_id, writer_name)
      write_todo("todo_type_2", group_id, actor_id, writer_name)
      write_post("post_type_1", group_id, actor_id, writer_name)

      {:ok, todos} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(todos) == 2
      assert Enum.all?(todos, fn e -> e.type == "todo" end)

      {:ok, posts} =
        EntityStore.query("post", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(posts) == 1
      assert hd(posts).type == "post"
    end

    test "query emits one decode sample with the row count and summed blob size", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_query_read_#{System.unique_integer([:positive])}"
      actor_id = "a_query_read_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_id, writer_name)
      write_todo("todo_read_1", group_id, actor_id, writer_name)
      write_todo("todo_read_2", group_id, actor_id, writer_name)

      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

      # Materialize the rows and the system entities first, so the sampled
      # query decodes only and does not fold materialization into the sample.
      assert {:ok, _} = EntityStore.query("todo", nil, actor_id, opts)

      ref = attach_telemetry([[:ebb, :entity_store, :read_latency_ms]])
      assert {:ok, rows} = EntityStore.query("todo", nil, actor_id, opts)
      assert length(rows) == 2

      assert [
               {[:ebb, :entity_store, :read_latency_ms],
                %{duration: duration, byte_size: byte_size, row_count: 2}, %{path: :query}}
             ] = telemetry_events(ref)

      assert is_integer(duration) and duration >= 0
      assert byte_size > 0
    end

    test "query respects permissions (only returns entities in actor's groups)", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      g1 = "g1_#{System.unique_integer([:positive])}"
      g2 = "g2_#{System.unique_integer([:positive])}"
      a1 = "a1_#{System.unique_integer([:positive])}"
      a2 = "a2_#{System.unique_integer([:positive])}"

      bootstrap_group(g1, a1, writer_name)
      bootstrap_group(g2, a2, writer_name)

      write_todo("todo_g1", g1, a1, writer_name)
      write_todo("todo_g2", g2, a2, writer_name)

      {:ok, a1_todos} =
        EntityStore.query("todo", nil, a1,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(a1_todos) == 1
      assert hd(a1_todos).id == "todo_g1"

      {:ok, a2_todos} =
        EntityStore.query("todo", nil, a2,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(a2_todos) == 1
      assert hd(a2_todos).id == "todo_g2"
    end

    test "query paginates a fixed set without repeats or gaps", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_page_#{System.unique_integer([:positive])}"
      actor_id = "a_page_#{System.unique_integer([:positive])}"
      ids = for i <- 1..5, do: "todo_page_#{i}"

      bootstrap_group(group_id, actor_id, writer_name)
      Enum.each(ids, fn id -> write_todo(id, group_id, actor_id, writer_name) end)

      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

      pages =
        for offset <- [0, 2, 4] do
          {:ok, page} =
            EntityStore.query("todo", nil, actor_id, opts ++ [limit: 2, offset: offset])

          Enum.map(page, & &1.id)
        end

      page_ids = List.flatten(pages)

      assert length(page_ids) == length(ids)
      assert page_ids == Enum.uniq(page_ids)
      assert Enum.sort(page_ids) == Enum.sort(ids)
      assert Enum.all?(pages, &(length(&1) <= 2))
    end

    test "query returns an entity once when it belongs to several of the actor's groups", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      g1 = "g_shared_1_#{System.unique_integer([:positive])}"
      g2 = "g_shared_2_#{System.unique_integer([:positive])}"
      actor_id = "a_shared_#{System.unique_integer([:positive])}"
      todo_id = "todo_shared_#{System.unique_integer([:positive])}"

      bootstrap_group(g1, actor_id, writer_name)
      bootstrap_group(g2, actor_id, writer_name)
      write_todo(todo_id, g1, actor_id, writer_name)
      write_todo(todo_id, g2, actor_id, writer_name)

      {:ok, todos} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert Enum.map(todos, & &1.id) == [todo_id]
    end

    test "pagination counts an entity once when several of the actor's groups contain it", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      g1 = "g_page_shared_1_#{System.unique_integer([:positive])}"
      g2 = "g_page_shared_2_#{System.unique_integer([:positive])}"
      actor_id = "a_page_shared_#{System.unique_integer([:positive])}"
      shared_id = "todo_page_shared_#{System.unique_integer([:positive])}"
      other_ids = ["todo_page_other_1", "todo_page_other_2"]

      bootstrap_group(g1, actor_id, writer_name)
      bootstrap_group(g2, actor_id, writer_name)
      write_todo(shared_id, g1, actor_id, writer_name)
      write_todo(shared_id, g2, actor_id, writer_name)
      Enum.each(other_ids, fn id -> write_todo(id, g1, actor_id, writer_name) end)

      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

      pages =
        for offset <- [0, 1, 2, 3] do
          {:ok, page} =
            EntityStore.query("todo", nil, actor_id, opts ++ [limit: 1, offset: offset])

          Enum.map(page, & &1.id)
        end

      page_ids = List.flatten(pages)
      expected = [shared_id | other_ids]

      assert length(page_ids) == length(expected)
      assert page_ids == Enum.uniq(page_ids)
      assert Enum.sort(page_ids) == Enum.sort(expected)
    end

    test "query with filter", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_filter_#{System.unique_integer([:positive])}"
      actor_id = "a_filter_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_id, writer_name)

      write_todo("todo_completed", group_id, actor_id, writer_name, completed: true)
      write_todo("todo_incomplete", group_id, actor_id, writer_name, completed: false)

      {:ok, completed} =
        EntityStore.query("todo", %{"completed" => true}, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(completed) == 1
      completed_entity = hd(completed)
      actual_value = get_in(completed_entity.data, ["fields", "completed", "value"])
      assert actual_value == true

      {:ok, incomplete} =
        EntityStore.query("todo", %{"completed" => false}, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert length(incomplete) == 1
      incomplete_entity = hd(incomplete)
      actual_incomplete_value = get_in(incomplete_entity.data, ["fields", "completed", "value"])
      assert actual_incomplete_value == false
    end

    test "query materializes dirty entities first", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_dirty_#{System.unique_integer([:positive])}"
      actor_id = "a_dirty_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_id, writer_name)
      write_todo("todo_dirty", group_id, actor_id, writer_name)

      assert DirtyTracker.dirty?("todo_dirty", dirty_set)

      {:ok, [_]} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      refute DirtyTracker.dirty?("todo_dirty", dirty_set)
    end

    test "query materializes an SDK-shaped e_ entity by its recorded type", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_sdk_#{System.unique_integer([:positive])}"
      actor_id = "a_sdk_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_id, writer_name)

      # The client SDK generates user-entity IDs as `e_<nanoid>`, so the ID
      # prefix carries no type information.
      sdk_id = "e_" <> Nanoid.generate()
      write_todo(sdk_id, group_id, actor_id, writer_name)

      {:ok, todos} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert Enum.any?(todos, fn todo -> todo.id == sdk_id end)
    end

    test "a cross-type query materializes dirty system entities", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_cross_#{System.unique_integer([:positive])}"
      actor_id = "a_cross_#{System.unique_integer([:positive])}"

      %{gm_id: gm_id, eg_id: eg_id} = bootstrap_group(group_id, actor_id, writer_name)

      rel_id = "rel_" <> Nanoid.generate()
      write_relationship(rel_id, "todo_cross_a", "todo_cross_b", actor_id, writer_name)

      assert :not_found = SQLite.get_entity(gm_id, sqlite_name)
      assert :not_found = SQLite.get_entity(eg_id, sqlite_name)
      assert :not_found = SQLite.get_entity(rel_id, sqlite_name)

      {:ok, _posts} =
        EntityStore.query("post", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert {:ok, _} = SQLite.get_entity(gm_id, sqlite_name)
      assert {:ok, _} = SQLite.get_entity(eg_id, sqlite_name)
      assert {:ok, _} = SQLite.get_entity(rel_id, sqlite_name)
    end

    test "a cross-type query materializes a dirty group entity", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "grp_" <> Nanoid.generate()
      actor_id = "a_group_#{System.unique_integer([:positive])}"

      write_group(group_id, actor_id, writer_name)

      assert :not_found = SQLite.get_entity(group_id, sqlite_name)

      {:ok, _posts} =
        EntityStore.query("post", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert {:ok, _} = SQLite.get_entity(group_id, sqlite_name)
    end

    test "query returns empty list when no entities match", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      actor_id = "a_nonexistent_#{System.unique_integer([:positive])}"

      {:ok, []} =
        EntityStore.query("nonexistent_type", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )
    end

    test "query returns empty list when actor has no group access", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_no_access_#{System.unique_integer([:positive])}"
      actor_in_group = "a_in_group_#{System.unique_integer([:positive])}"
      actor_no_group = "a_no_group_#{System.unique_integer([:positive])}"

      bootstrap_group(group_id, actor_in_group, writer_name)
      write_todo("todo_no_access", group_id, actor_in_group, writer_name)

      {:ok, []} =
        EntityStore.query("todo", nil, actor_no_group,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )
    end

    test "query excludes an entity once its delete is materialized", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name,
      dirty_set: dirty_set
    } do
      group_id = "g_deleted_#{System.unique_integer([:positive])}"
      actor_id = "a_deleted_#{System.unique_integer([:positive])}"
      todo_id = "todo_deleted_#{System.unique_integer([:positive])}"

      opts = [
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      ]

      bootstrap_group(group_id, actor_id, writer_name)
      write_todo(todo_id, group_id, actor_id, writer_name)

      # Materialize the entity while it is still alive.
      assert {:ok, _alive} = EntityStore.get(todo_id, actor_id, opts)

      delete_action = %{
        id: "act_" <> Nanoid.generate(),
        actor_id: actor_id,
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_" <> Nanoid.generate(),
            subject_id: todo_id,
            subject_type: "todo",
            method: :delete,
            data: %{"fields" => %{}}
          }
        ]
      }

      {:ok, _gsns, []} = Writer.write_actions([delete_action], writer_name)

      # Materialize the delete so the cache holds a tombstone, then query.
      assert :not_found = EntityStore.get(todo_id, actor_id, opts)

      {:ok, todos} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      refute Enum.any?(todos, fn todo -> todo.id == todo_id end)
    end
  end

  describe "EntityStore.query/4 filter validation" do
    test "returns the filter error instead of forwarding it", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]
      pid = Process.whereis(sqlite_name)

      for filter <- malformed_query_filters() do
        assert {:error, :invalid_filter} = EntityStore.query("todo", filter, "a_filter", opts)
        assert Process.whereis(sqlite_name) == pid
      end
    end
  end

  describe "EntityStore.query/4 pagination bounds" do
    test "an omitted window becomes the default page" do
      assert EntityStore.normalize_pagination(nil, nil) == {:ok, 200, nil}
    end

    test "the largest allowed page is kept as asked" do
      assert EntityStore.normalize_pagination(1000, 0) == {:ok, 1000, 0}
    end

    test "a limit outside 1..1000 is rejected, whatever its type" do
      for limit <- [0, -1, 1.5, "10", 1001, %{}, []] do
        assert EntityStore.normalize_pagination(limit, nil) == {:error, :invalid_limit},
               "expected #{inspect(limit)} to be rejected"
      end
    end

    test "a negative, non-integer or unbindable offset is rejected" do
      for offset <- [-1, 1.5, "0", 9_223_372_036_854_775_808] do
        assert EntityStore.normalize_pagination(nil, offset) == {:error, :invalid_offset},
               "expected #{inspect(offset)} to be rejected"
      end
    end

    test "query returns the window error instead of forwarding it", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      opts = [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set]

      assert {:error, :invalid_limit} =
               EntityStore.query("todo", nil, "a_window", [limit: -1] ++ opts)

      assert {:error, :invalid_limit} =
               EntityStore.query("todo", nil, "a_window", [limit: 0] ++ opts)

      assert {:error, :invalid_offset} =
               EntityStore.query("todo", nil, "a_window", [offset: -1] ++ opts)
    end

    test "a query without a limit returns at most the default page", %{
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: dirty_set
    } do
      group_id = "g_default_page_#{System.unique_integer([:positive])}"
      actor_id = "a_default_page_#{System.unique_integer([:positive])}"

      seed_queryable_todos(group_id, actor_id, 205, sqlite_name)

      {:ok, todos} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      assert Enum.map(todos, & &1.id) == Enum.map(1..200, &"todo_seed_#{&1}")
    end
  end

  defp write_relationship(rel_id, source_id, target_id, actor_id, writer_name) do
    hlc = generate_hlc()

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "fields" => %{
              "source_id" => %{"type" => "lww", "value" => source_id, "hlc" => hlc},
              "target_id" => %{"type" => "lww", "value" => target_id, "hlc" => hlc},
              "type" => %{"type" => "lww", "value" => "assignedTo", "hlc" => hlc},
              "field" => %{"type" => "lww", "value" => "assignee", "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn, gsn}, []} = Writer.write_actions([action], writer_name)
    %{rel_id: rel_id, gsn: gsn}
  end

  defp write_group(group_id, actor_id, writer_name) do
    hlc = generate_hlc()

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: group_id,
          subject_type: "group",
          method: :put,
          data: %{
            "fields" => %{
              "name" => %{"type" => "lww", "value" => "Test group", "hlc" => hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn, gsn}, []} = Writer.write_actions([action], writer_name)
    %{group_id: group_id, gsn: gsn}
  end

  defp write_post(post_id, group_id, actor_id, writer_name, opts \\ []) do
    title = Keyword.get(opts, :title, "Test post")

    action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: post_id,
          subject_type: "post",
          method: :put,
          data: %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => title, "hlc" => generate_hlc()}
            }
          }
        }
      ]
    }

    {:ok, {gsn, gsn}, []} = Writer.write_actions([action], writer_name)

    eg_id = "eg_" <> Nanoid.generate()
    eg_hlc = generate_hlc()

    eg_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: eg_hlc,
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: eg_id,
          subject_type: "entityGroup",
          method: :put,
          data: %{
            "fields" => %{
              "entity_id" => %{"type" => "lww", "value" => post_id, "hlc" => eg_hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => eg_hlc}
            }
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([eg_action], writer_name)
    %{post_id: post_id, eg_id: eg_id, gsn: gsn2}
  end

  # Seeds the read model directly so a page-bound test does not pay for one
  # Action per row. Seeded rows are not dirty, so a query reads them as-is.
  defp seed_queryable_todos(group_id, actor_id, count, sqlite_name) do
    :ok =
      SQLite.upsert_entity(
        lww_row("gm_seed", "groupMember", %{
          "actor_id" => actor_id,
          "group_id" => group_id,
          "permissions" => ["todo.read"]
        }),
        sqlite_name
      )

    for i <- 1..count do
      todo_id = "todo_seed_#{i}"

      :ok =
        SQLite.upsert_entity(
          lww_row(todo_id, "todo", %{"title" => "seed #{i}"}, 1000 + i),
          sqlite_name
        )

      :ok =
        SQLite.upsert_entity(
          lww_row("eg_seed_#{i}", "entityGroup", %{
            "entity_id" => todo_id,
            "group_id" => group_id
          }),
          sqlite_name
        )
    end

    :ok
  end

  defp lww_row(id, type, fields, created_hlc \\ 1000) do
    %{
      id: id,
      type: type,
      data:
        Jason.encode!(%{
          "fields" => Map.new(fields, fn {field, value} -> {field, lww(value)} end)
        }),
      created_hlc: created_hlc,
      updated_hlc: created_hlc,
      deleted_hlc: nil,
      deleted_by: nil,
      last_gsn: 1
    }
  end

  defp lww(value), do: %{"type" => "lww", "value" => value, "hlc" => 1}
end
