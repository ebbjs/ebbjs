defmodule EbbServer.Storage.SystemCacheTest do
  # Named ETS table (:ebb_dirty_set) and named persistent_term (:ebb_gsn_counter)
  # prevent concurrent test instances — must run sequentially.
  use ExUnit.Case, async: false

  alias EbbServer.Storage.SystemCache

  setup do
    {:ok, pid} = SystemCache.start_link()

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    :ok
  end

  describe "GSN claiming" do
    test "produces monotonically increasing, gap-free ranges" do
      assert {1, 1} = SystemCache.claim_gsn_range(1)
      assert {2, 4} = SystemCache.claim_gsn_range(3)
      assert {5, 5} = SystemCache.claim_gsn_range(1)
    end
  end

  describe "GSN claiming with initial_gsn" do
    # Need a fresh SystemCache with initial_gsn set, so stop the one from setup
    test "starts from the provided offset" do
      GenServer.stop(SystemCache)

      {:ok, pid} = SystemCache.start_link(initial_gsn: 100)

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
      end)

      assert {101, 101} = SystemCache.claim_gsn_range(1)
    end
  end

  describe "dirty set operations" do
    test "mark, check, and clear lifecycle" do
      refute SystemCache.is_dirty?("todo_abc")
      refute SystemCache.is_dirty?("todo_xyz")

      :ok = SystemCache.mark_dirty_batch(["todo_abc", "todo_xyz"])

      assert SystemCache.is_dirty?("todo_abc")
      assert SystemCache.is_dirty?("todo_xyz")

      SystemCache.clear_dirty("todo_abc")

      refute SystemCache.is_dirty?("todo_abc")
      assert SystemCache.is_dirty?("todo_xyz")
    end
  end

  describe "concurrent GSN claiming" do
    test "10 concurrent tasks produce unique, complete GSN set" do
      tasks =
        for _ <- 1..10 do
          Task.async(fn -> SystemCache.claim_gsn_range(1) end)
        end

      results = Task.await_many(tasks)
      gsns = Enum.map(results, fn {start, start} -> start end)

      assert length(Enum.uniq(gsns)) == 10
      assert Enum.sort(gsns) == Enum.to_list(1..10)
    end
  end
end
