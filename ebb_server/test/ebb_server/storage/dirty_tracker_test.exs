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

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}, {"todo_xyz", "todo"}], dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)
    end

    test "consecutive batches yield different generations" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)
      first = DirtyTracker.dirty_generation("todo_abc", dirty_set)

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)
      second = DirtyTracker.dirty_generation("todo_abc", dirty_set)

      refute first == second
    end

    test "ids in one batch share the batch generation" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}, {"todo_xyz", "todo"}], dirty_set)

      assert DirtyTracker.dirty_generation("todo_abc", dirty_set) ==
               DirtyTracker.dirty_generation("todo_xyz", dirty_set)
    end
  end

  describe "dirty_generation/2" do
    test "is nil before a mark and a value after" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      assert DirtyTracker.dirty_generation("todo_abc", dirty_set) == nil

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)

      refute DirtyTracker.dirty_generation("todo_abc", dirty_set) == nil
    end
  end

  describe "dirty?/2" do
    test "returns false for clean entity" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      refute DirtyTracker.dirty?("todo_abc", dirty_set)
    end

    test "returns true for dirty entity" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
    end
  end

  describe "provisional marks" do
    test "mark_pending_batch/2 makes entities dirty before a commit lands" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      refute DirtyTracker.dirty?("todo_abc", dirty_set)

      generation =
        DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}, {"todo_xyz", "todo"}], dirty_set)

      assert is_integer(generation)
      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)
      assert DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_abc", dirty_set))
    end

    test "settling a provisional mark replaces it with a settled one" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}], dirty_set)
      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      refute DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_abc", dirty_set))
    end

    test "clear_pending_batch/3 clears only the exact provisional generation" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      generation = DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}], dirty_set)

      :ok = DirtyTracker.clear_pending_batch([{"todo_abc", "todo"}], generation + 1, dirty_set)
      assert DirtyTracker.dirty?("todo_abc", dirty_set)

      :ok = DirtyTracker.clear_pending_batch([{"todo_abc", "todo"}], generation, dirty_set)
      refute DirtyTracker.dirty?("todo_abc", dirty_set)
    end

    test "clear_pending_batch/3 leaves a settled mark in place" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      generation = DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}], dirty_set)
      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)

      :ok = DirtyTracker.clear_pending_batch([{"todo_abc", "todo"}], generation, dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      refute DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_abc", dirty_set))
    end

    test "clear_pending_batch/3 does not clear a different type with the same id" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      generation = DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}], dirty_set)

      :ok = DirtyTracker.clear_pending_batch([{"todo_abc", "post"}], generation, dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_abc", dirty_set))
    end

    test "settle_all_pending/1 converts surviving provisional marks without touching settled ones" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      DirtyTracker.mark_pending_batch([{"todo_abc", "todo"}], dirty_set)
      :ok = DirtyTracker.mark_dirty_batch([{"todo_xyz", "todo"}], dirty_set)
      settled_xyz = DirtyTracker.dirty_generation("todo_xyz", dirty_set)

      :ok = DirtyTracker.settle_all_pending(dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      refute DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_abc", dirty_set))
      assert DirtyTracker.dirty_generation("todo_xyz", dirty_set) == settled_xyz
    end

    test "settle_all_pending/1 preserves each mark's recorded type" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      DirtyTracker.mark_pending_batch([{"e_abc", "todo"}, {"gm_xyz", "groupMember"}], dirty_set)

      :ok = DirtyTracker.settle_all_pending(dirty_set)

      assert DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set) == ["e_abc"]

      assert DirtyTracker.dirty_entity_ids_for_type("groupMember", dirty_set) == ["gm_xyz"]
    end
  end

  describe "clear_dirty/3" do
    test "clears when the observed generation matches" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}, {"todo_xyz", "todo"}], dirty_set)
      observed = DirtyTracker.dirty_generation("todo_abc", dirty_set)

      DirtyTracker.clear_dirty("todo_abc", observed, dirty_set)

      refute DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty?("todo_xyz", dirty_set)
    end

    test "does not clear when a newer mark landed after the observation" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)
      observed = DirtyTracker.dirty_generation("todo_abc", dirty_set)

      # A writer commits and re-marks while materialization is in flight.
      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)
      newer = DirtyTracker.dirty_generation("todo_abc", dirty_set)
      refute observed == newer

      DirtyTracker.clear_dirty("todo_abc", observed, dirty_set)

      assert DirtyTracker.dirty?("todo_abc", dirty_set)
      assert DirtyTracker.dirty_generation("todo_abc", dirty_set) == newer
    end

    test "does not delete a live mark with a stale or nil observation" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_abc", "todo"}], dirty_set)
      live = DirtyTracker.dirty_generation("todo_abc", dirty_set)

      DirtyTracker.clear_dirty("todo_abc", live + 1, dirty_set)
      assert DirtyTracker.dirty?("todo_abc", dirty_set)

      DirtyTracker.clear_dirty("todo_abc", nil, dirty_set)
      assert DirtyTracker.dirty?("todo_abc", dirty_set)
    end
  end

  describe "reset/1" do
    test "clears all entries from dirty set" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok =
        DirtyTracker.mark_dirty_batch(
          [{"todo_1", "todo"}, {"todo_2", "todo"}, {"todo_3", "todo"}],
          dirty_set
        )

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
      :ok = DirtyTracker.mark_dirty_batch([{"todo_x", "todo"}], unique_name)
      assert DirtyTracker.dirty?("todo_x", unique_name)
    end
  end

  describe "dirty_entity_ids_for_type/2" do
    test "classifies an SDK-shaped entity by its recorded type, not its ID prefix" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      # The client SDK generates user-entity IDs as `e_<nanoid>`, so the ID
      # prefix carries no type information.
      :ok = DirtyTracker.mark_dirty_batch([{"e_abc", "todo"}], dirty_set)

      assert DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set) == ["e_abc"]
    end

    test "does not classify by ID prefix" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_1", "post"}], dirty_set)

      assert DirtyTracker.dirty_entity_ids_for_type("post", dirty_set) == ["todo_1"]
      assert DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set) == []
    end

    test "returns only the requested type" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok =
        DirtyTracker.mark_dirty_batch(
          [{"todo_abc", "todo"}, {"todo_xyz", "todo"}, {"post_123", "post"}],
          dirty_set
        )

      todo_ids = DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set)
      assert Enum.sort(todo_ids) == ["todo_abc", "todo_xyz"]

      assert DirtyTracker.dirty_entity_ids_for_type("post", dirty_set) == ["post_123"]
    end

    test "handles groupMember type regardless of ID shape" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok =
        DirtyTracker.mark_dirty_batch(
          [{"gm_abc", "groupMember"}, {"groupMember_xyz", "groupMember"}],
          dirty_set
        )

      ids = DirtyTracker.dirty_entity_ids_for_type("groupMember", dirty_set)
      assert Enum.sort(ids) == ["gm_abc", "groupMember_xyz"]
    end

    test "handles relationship type regardless of ID shape" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok =
        DirtyTracker.mark_dirty_batch(
          [{"rel_abc", "relationship"}, {"relationship_xyz", "relationship"}],
          dirty_set
        )

      ids = DirtyTracker.dirty_entity_ids_for_type("relationship", dirty_set)
      assert Enum.sort(ids) == ["rel_abc", "relationship_xyz"]
    end
  end

  describe "dirty_entity_ids_for_types/2" do
    test "returns the dirty IDs recorded under any of the given types" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok =
        DirtyTracker.mark_dirty_batch(
          [
            {"gm_abc", "groupMember"},
            {"eg_xyz", "entityGroup"},
            {"rel_1", "relationship"},
            {"grp_1", "group"},
            {"todo_1", "todo"}
          ],
          dirty_set
        )

      ids =
        DirtyTracker.dirty_entity_ids_for_types(
          ["group", "groupMember", "relationship", "entityGroup"],
          dirty_set
        )

      assert Enum.sort(ids) == ["eg_xyz", "gm_abc", "grp_1", "rel_1"]
    end

    test "deduplicates repeated types" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_1", "todo"}], dirty_set)

      assert DirtyTracker.dirty_entity_ids_for_types(["todo", "todo"], dirty_set) == ["todo_1"]
    end

    test "returns an empty list for no types" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      :ok = DirtyTracker.mark_dirty_batch([{"todo_1", "todo"}], dirty_set)

      assert DirtyTracker.dirty_entity_ids_for_types([], dirty_set) == []
    end
  end

  describe "size/1" do
    test "returns the number of marked entities" do
      %{dirty_set: dirty_set} = with_isolated_tracker()

      assert DirtyTracker.size(dirty_set) == 0

      :ok =
        DirtyTracker.mark_dirty_batch(
          [{"todo_a", "todo"}, {"todo_b", "todo"}, {"todo_c", "todo"}],
          dirty_set
        )

      assert DirtyTracker.size(dirty_set) == 3
    end

    test "returns 0 for an undefined table" do
      undefined = :"dirty_set_that_does_not_exist_#{System.unique_integer([:positive])}"

      assert DirtyTracker.size(undefined) == 0
    end
  end
end
