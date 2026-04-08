defmodule EbbServer.Storage.DirtyTrackerTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.DirtyTracker

  defp with_isolated_tracker do
    dirty_set_name = :"test_dirty_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      DirtyTracker.start_link(
        name: :"test_dt_#{System.unique_integer([:positive])}",
        dirty_set: dirty_set_name
      )

    on_exit(fn ->
      DirtyTracker.reset(dirty_set_name)
    end)

    %{dirty_set: dirty_set_name}
  end

  describe "mark_dirty_batch/2" do
    test "marks multiple entities as dirty" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      refute DirtyTracker.dirty?("todo_abc", dirty_set)
      refute DirtyTracker.dirty?("todo_xyz", dirty_set)

      :ok = DirtyTracker.mark_dirty_batch(["todo_abc", "todo_xyz"], dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)
    end
  end

  describe "dirty?/2" do
    test "returns false for clean entity" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      refute DirtyTracker.dirty?("todo_abc", dirty_set)
    end

    test "returns true for dirty entity" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["todo_abc"], dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
    end
  end

  describe "clear_dirty/2" do
    test "clears dirty flag for entity" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["todo_abc", "todo_xyz"], dirty_set)
      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)

      DirtyTracker.clear_dirty("todo_abc", dirty_set)

      refute DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)
    end
  end

  describe "reset/1" do
    test "clears all entries from dirty set" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["todo_1", "todo_2", "todo_3"], dirty_set)
      assert DirtyTracker.dirty?("todo_1", dirty_set)
      assert DirtyTracker.dirty?("todo_2", dirty_set)
      assert DirtyTracker.dirty?("todo_3", dirty_set)

      :ok = DirtyTracker.reset(dirty_set)

      refute DirtyTracker.dirty?("todo_1", dirty_set)
      refute DirtyTracker.dirty?("todo_2", dirty_set)
      refute DirtyTracker.dirty?("todo_3", dirty_set)
    end

    test "creates dirty set if it does not exist" do
      unique_name = :"test_reset_new_#{System.unique_integer([:positive])}"

      :ok = DirtyTracker.reset(unique_name)

      refute DirtyTracker.dirty?("todo_x", unique_name)
      :ok = DirtyTracker.mark_dirty_batch(["todo_x"], unique_name)
      assert DirtyTracker.dirty?("todo_x", unique_name)
    end
  end

  describe "dirty_entity_ids_for_type/2" do
    test "returns entity IDs matching type prefix" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["todo_abc", "todo_xyz", "post_123"], dirty_set)

      todo_ids = DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set)
      assert length(todo_ids) == 2
      assert "todo_abc" in todo_ids
      assert "todo_xyz" in todo_ids

      post_ids = DirtyTracker.dirty_entity_ids_for_type("post", dirty_set)
      assert post_ids == ["post_123"]
    end

    test "handles groupMember type prefix" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["gm_abc", "groupMember_xyz"], dirty_set)

      ids = DirtyTracker.dirty_entity_ids_for_type("groupMember", dirty_set)
      assert length(ids) == 2
      assert "gm_abc" in ids
      assert "groupMember_xyz" in ids
    end

    test "handles relationship type prefix" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch(["rel_abc", "relationship_xyz"], dirty_set)

      ids = DirtyTracker.dirty_entity_ids_for_type("relationship", dirty_set)
      assert length(ids) == 2
      assert "rel_abc" in ids
      assert "relationship_xyz" in ids
    end
  end
end
