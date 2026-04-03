defmodule EbbServer.Storage.SystemCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.SystemCache

  defp start_isolated_cache(initial_gsn \\ 0) do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    cache_name = :"ebb_cache_#{unique_id}"
    group_members_name = :"ebb_gm_#{unique_id}"
    relationships_name = :"ebb_rel_#{unique_id}"
    relationships_by_group_name = :"ebb_rbg_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)

    :ets.new(group_members_name, [:bag, :public, :named_table])
    :ets.new(relationships_name, [:set, :public, :named_table])
    :ets.new(relationships_by_group_name, [:bag, :public, :named_table])

    {:ok, _pid} =
      SystemCache.start_link(
        name: cache_name,
        dirty_set: dirty_set_name,
        gsn_counter: counter,
        gsn_counter_name: gsn_counter_name,
        initial_gsn: initial_gsn,
        group_members: group_members_name,
        relationships: relationships_name,
        relationships_by_group: relationships_by_group_name
      )

    on_exit(fn ->
      if pid = Process.whereis(cache_name), do: if(Process.alive?(pid), do: GenServer.stop(pid))
      :persistent_term.erase(gsn_counter_name)
      for t <- [group_members_name, relationships_name, relationships_by_group_name] do
        try do :ets.delete(t) rescue _ -> :ok end
      end
    end)

    %{dirty_set: dirty_set_name, gsn_counter: counter, cache_name: cache_name,
      group_members: group_members_name, relationships: relationships_name,
      relationships_by_group: relationships_by_group_name}
  end

  describe "GSN claiming" do
    test "produces monotonically increasing, gap-free ranges" do
      %{gsn_counter: counter} = start_isolated_cache()

      assert {1, 1} = SystemCache.claim_gsn_range(1, counter)
      assert {2, 4} = SystemCache.claim_gsn_range(3, counter)
      assert {5, 5} = SystemCache.claim_gsn_range(1, counter)
    end
  end

  describe "GSN claiming with initial_gsn" do
    test "starts from the provided offset" do
      %{gsn_counter: counter} = start_isolated_cache(100)

      assert {101, 101} = SystemCache.claim_gsn_range(1, counter)
    end
  end

  describe "dirty set operations" do
    test "mark, check, and clear lifecycle" do
      %{dirty_set: dirty_set, gsn_counter: _counter} = start_isolated_cache()

      refute SystemCache.is_dirty?("todo_abc", dirty_set)
      refute SystemCache.is_dirty?("todo_xyz", dirty_set)

      :ok = SystemCache.mark_dirty_batch(["todo_abc", "todo_xyz"], dirty_set)

      assert SystemCache.is_dirty?("todo_abc", dirty_set)
      assert SystemCache.is_dirty?("todo_xyz", dirty_set)

      SystemCache.clear_dirty("todo_abc", dirty_set)

      refute SystemCache.is_dirty?("todo_abc", dirty_set)
      assert SystemCache.is_dirty?("todo_xyz", dirty_set)
    end
  end

  describe "concurrent GSN claiming" do
    test "10 concurrent tasks produce unique, complete GSN set" do
      %{dirty_set: _dirty_set, gsn_counter: counter} = start_isolated_cache()

      tasks =
        for _ <- 1..10 do
          Task.async(fn -> SystemCache.claim_gsn_range(1, counter) end)
        end

      results = Task.await_many(tasks)
      gsns = Enum.map(results, fn {start, start} -> start end)

      assert length(Enum.uniq(gsns)) == 10
      assert Enum.sort(gsns) == Enum.to_list(1..10)
    end
  end

  describe "reset/2" do
    test "clears all entries from dirty set" do
      %{dirty_set: dirty_set} = start_isolated_cache()

      :ok = SystemCache.mark_dirty_batch(["todo_1", "todo_2", "todo_3"], dirty_set)
      assert SystemCache.is_dirty?("todo_1", dirty_set)
      assert SystemCache.is_dirty?("todo_2", dirty_set)
      assert SystemCache.is_dirty?("todo_3", dirty_set)

      :ok = SystemCache.reset(dirty_set)

      refute SystemCache.is_dirty?("todo_1", dirty_set)
      refute SystemCache.is_dirty?("todo_2", dirty_set)
      refute SystemCache.is_dirty?("todo_3", dirty_set)
    end

    test "resets GSN counter to 0" do
      %{gsn_counter: counter} = start_isolated_cache()

      assert {1, 5} = SystemCache.claim_gsn_range(5, counter)
      assert {6, 10} = SystemCache.claim_gsn_range(5, counter)

      :ok = SystemCache.reset(:not_used, counter)

      assert {1, 1} = SystemCache.claim_gsn_range(1, counter)
    end

    test "creates dirty set if it does not exist" do
      unique_name = :"test_reset_new_#{System.unique_integer([:positive])}"

      :ok = SystemCache.reset(unique_name)

      refute SystemCache.is_dirty?("todo_x", unique_name)
      :ok = SystemCache.mark_dirty_batch(["todo_x"], unique_name)
      assert SystemCache.is_dirty?("todo_x", unique_name)
    end
  end

  describe "get_resources/0" do
    test "returns dirty_set and gsn_counter keys" do
      resources = SystemCache.get_resources()

      assert Map.has_key?(resources, :dirty_set)
      assert Map.has_key?(resources, :gsn_counter)
      assert is_atom(resources.dirty_set)
    end
  end

  describe "permission APIs - group members" do
    test "put_group_member and get_actor_groups" do
      %{group_members: gm} = start_isolated_cache()

      :ok = SystemCache.put_group_member(
        %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
        gm
      )

      assert SystemCache.get_actor_groups("a_1", gm) == [
        %{group_id: "g_1", permissions: ["todo.create"]}
      ]
    end

    test "get_actor_groups with multiple groups" do
      %{group_members: gm} = start_isolated_cache()

      :ok = SystemCache.put_group_member(
        %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
        gm
      )
      :ok = SystemCache.put_group_member(
        %{id: "gm_2", actor_id: "a_1", group_id: "g_2", permissions: ["post.create"]},
        gm
      )

      groups = SystemCache.get_actor_groups("a_1", gm)
      assert length(groups) == 2
    end

    test "get_permissions returns permissions for matching group" do
      %{group_members: gm} = start_isolated_cache()

      :ok = SystemCache.put_group_member(
        %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]},
        gm
      )

      assert SystemCache.get_permissions("a_1", "g_1", gm) == ["todo.create", "todo.update"]
    end

    test "get_permissions returns nil for non-member" do
      %{group_members: gm} = start_isolated_cache()

      assert SystemCache.get_permissions("a_1", "g_nonexistent", gm) == nil
    end

    test "delete_group_member removes entry" do
      %{group_members: gm} = start_isolated_cache()

      :ok = SystemCache.put_group_member(
        %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
        gm
      )

      :ok = SystemCache.delete_group_member("gm_1", gm)

      assert SystemCache.get_actor_groups("a_1", gm) == []
    end
  end

  describe "permission APIs - relationships" do
    test "put_relationship and get_entity_group" do
      %{relationships: rel, relationships_by_group: rbg} = start_isolated_cache()

      :ok = SystemCache.put_relationship(
        %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
        relationships: rel, relationships_by_group: rbg
      )

      assert SystemCache.get_entity_group("todo_1", rel) == "g_1"
    end

    test "get_entity_group returns nil for unknown entity" do
      %{relationships: rel} = start_isolated_cache()

      assert SystemCache.get_entity_group("unknown", rel) == nil
    end

    test "get_group_entities" do
      %{relationships: rel, relationships_by_group: rbg} = start_isolated_cache()

      :ok = SystemCache.put_relationship(
        %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
        relationships: rel, relationships_by_group: rbg
      )
      :ok = SystemCache.put_relationship(
        %{id: "rel_2", source_id: "todo_2", target_id: "g_1", type: "todo", field: "group"},
        relationships: rel, relationships_by_group: rbg
      )

      entities = SystemCache.get_group_entities("g_1", rbg)
      assert length(entities) == 2
      assert "todo_1" in entities
      assert "todo_2" in entities
    end

    test "delete_relationship removes from both tables" do
      %{relationships: rel, relationships_by_group: rbg} = start_isolated_cache()

      :ok = SystemCache.put_relationship(
        %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
        relationships: rel, relationships_by_group: rbg
      )

      :ok = SystemCache.delete_relationship("rel_1", relationships: rel, relationships_by_group: rbg)

      assert SystemCache.get_entity_group("todo_1", rel) == nil
      assert SystemCache.get_group_entities("g_1", rbg) == []
    end
  end

  describe "dirty_entity_ids_for_type/1" do
    test "returns entity IDs matching type prefix" do
      %{dirty_set: ds} = start_isolated_cache()

      :ok = SystemCache.mark_dirty_batch(["todo_abc", "todo_xyz", "post_123"], ds)

      todo_ids = SystemCache.dirty_entity_ids_for_type("todo", ds)
      assert length(todo_ids) == 2
      assert "todo_abc" in todo_ids
      assert "todo_xyz" in todo_ids

      post_ids = SystemCache.dirty_entity_ids_for_type("post", ds)
      assert post_ids == ["post_123"]
    end
  end
end
