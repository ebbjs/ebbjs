defmodule EbbServer.Storage.EntityStoreQueryTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.{EntityStore, RocksDB, SQLite, SystemCache, Writer}
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
      if pid = Process.whereis(cache_name), do: safe_stop(pid)
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

  defp start_sqlite(dir) do
    name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, pid} = SQLite.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      safe_stop(pid)
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

    rel_id = "rel_" <> Nanoid.generate()

    rel_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "source_id" => group_id,
            "target_id" => group_id,
            "type" => group_id,
            "field" => "group"
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([rel_action], writer_name)
    %{gm_id: gm_id, rel_id: rel_id, gsn: gsn2}
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

    rel_id = "rel_" <> Nanoid.generate()

    rel_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "source_id" => todo_id,
            "target_id" => group_id,
            "type" => "todo",
            "field" => "group"
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([rel_action], writer_name)
    %{todo_id: todo_id, rel_id: rel_id, gsn: gsn2}
  end

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: gm_table,
      relationships: rel_table,
      relationships_by_group: rbg_table
    } = start_isolated_cache()

    %{name: rocks_name, dir: rocks_dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(rocks_dir)

    %{name: writer_name} =
      start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: gsn_counter,
        group_members: gm_table,
        relationships: rel_table,
        relationships_by_group: rbg_table
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

      assert SystemCache.dirty?("todo_dirty", dirty_set)

      {:ok, [_]} =
        EntityStore.query("todo", nil, actor_id,
          rocks_name: rocks_name,
          sqlite_name: sqlite_name,
          dirty_set: dirty_set
        )

      refute SystemCache.dirty?("todo_dirty", dirty_set)
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

    rel_id = "rel_" <> Nanoid.generate()

    rel_action = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: actor_id,
      hlc: generate_hlc(),
      updates: [
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: rel_id,
          subject_type: "relationship",
          method: :put,
          data: %{
            "source_id" => post_id,
            "target_id" => group_id,
            "type" => "post",
            "field" => "group"
          }
        }
      ]
    }

    {:ok, {gsn2, gsn2}, []} = Writer.write_actions([rel_action], writer_name)
    %{post_id: post_id, rel_id: rel_id, gsn: gsn2}
  end
end
