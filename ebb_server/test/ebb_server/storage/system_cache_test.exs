defmodule EbbServer.Storage.SystemCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.SystemCache

  defp start_isolated_cache(initial_gsn \\ 0) do
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
        initial_gsn: initial_gsn
      )

    on_exit(fn ->
      if pid = Process.whereis(cache_name), do: if(Process.alive?(pid), do: GenServer.stop(pid))
      :persistent_term.erase(gsn_counter_name)
    end)

    %{dirty_set: dirty_set_name, gsn_counter: counter, cache_name: cache_name}
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
end
