defmodule EbbServer.Storage.CommitPipelineTest do
  @moduledoc """
  Pure transition tests for `EbbServer.Storage.CommitPipeline`.

  The point of the state machine is that these run without a Writer, a
  cache, a Committer, or RocksDB. The randomized cases assert the ordering
  and guard invariants over arbitrary ack/abandon orders, which is the part
  the GenServer used to hide.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.CommitPipeline
  alias EbbServer.Storage.CommitPipeline.Batch

  describe "a successful batch" do
    test "walks claimed -> prepared -> committing -> committed -> applying -> released" do
      state = CommitPipeline.new()
      assert CommitPipeline.phase(state) == :idle

      {ref, batch, state} = claim!(state, 1)
      assert %Batch{phase: :claimed, action_ids: ["act_1"]} = batch
      assert CommitPipeline.phase(state) == :claimed
      assert_guard(state)

      {:ok, prepared, state} =
        CommitPipeline.prepared(state, ref, [:prepared], %{1 => ["g_1"]}, {[], 7})

      assert %Batch{phase: :prepared, pending_marks: {[], 7}} = prepared
      assert CommitPipeline.phase(state) == :prepared
      assert_guard(state)

      {:ok, committing, state} = CommitPipeline.committing(state, ref)
      assert %Batch{phase: :committing} = committing
      assert CommitPipeline.committing?(state, ref)
      assert CommitPipeline.phase(state) == :committing
      assert_guard(state)

      {:ok, committed, state} = CommitPipeline.committed(state, ref)
      assert %Batch{phase: :committed} = committed
      assert state.in_flight_ids == MapSet.new()
      assert CommitPipeline.get(state, ref) == committed
      assert CommitPipeline.phase(state) == :committed

      {:ok, applying, state} = CommitPipeline.applying(state, ref)
      assert %Batch{phase: :applying} = applying
      assert CommitPipeline.releasable(state) == []
      assert CommitPipeline.phase(state) == :applying

      {:ok, released, state} = CommitPipeline.release(state, ref)
      assert %Batch{phase: :released} = released
      assert CommitPipeline.get(state, ref) == nil
      assert state.claim_order == []
      assert CommitPipeline.phase(state) == :idle
      refute CommitPipeline.inflight?(state)
    end
  end

  describe "abandon paths" do
    test "abandon is valid from every pre-release phase and prunes the batch" do
      for phase <- [:claimed, :prepared, :committing, :committed] do
        {ref, _batch, state} = claim!(CommitPipeline.new(), 1)
        state = advance_to(state, ref, phase)

        assert {:ok, abandoned, state} = CommitPipeline.abandon(state, ref, :boom)
        assert %Batch{phase: :abandoned, reason: :boom, action_ids: ["act_1"]} = abandoned
        assert CommitPipeline.get(state, ref) == nil
        assert state.claim_order == []
        assert state.in_flight_ids == MapSet.new()
        refute CommitPipeline.inflight?(state)

        assert {:error, :unknown_batch} = CommitPipeline.abandon(state, ref, :again)
      end
    end

    test "invalid transitions refuse to move a batch" do
      {ref, _batch, state} = claim!(CommitPipeline.new(), 1)

      assert {:error, {:invalid_transition, :claimed, :committed}} =
               CommitPipeline.committed(state, ref)

      assert {:error, {:invalid_transition, :claimed, :applying}} =
               CommitPipeline.applying(state, ref)

      assert {:error, {:invalid_transition, :claimed, :released}} =
               CommitPipeline.release(state, ref)

      {:ok, _batch, state} = CommitPipeline.prepared(state, ref, [], %{}, {[], nil})

      assert {:error, {:invalid_transition, :prepared, :committed}} =
               CommitPipeline.committed(state, ref)
    end
  end

  describe "ordering state" do
    test "a later committed batch cannot be released before an earlier claim" do
      state = CommitPipeline.new(max_in_flight: 2)
      {first_ref, _first, state} = claim!(state, 1)
      {second_ref, _second, state} = claim!(state, 2)

      state = advance_to(state, second_ref, :committing)
      {:ok, _second, state} = CommitPipeline.committed(state, second_ref)

      assert CommitPipeline.releasable(state) == []

      state = advance_to(state, first_ref, :committing)
      {:ok, _first, state} = CommitPipeline.committed(state, first_ref)

      assert [%Batch{gsn_start: 1}, %Batch{gsn_start: 2}] =
               CommitPipeline.releasable(state)
    end

    test "an abandoned earlier batch stops blocking a later committed one" do
      state = CommitPipeline.new(max_in_flight: 2)
      {first_ref, _first, state} = claim!(state, 1)
      {second_ref, _second, state} = claim!(state, 2)

      state = advance_to(state, second_ref, :committing)
      {:ok, _second, state} = CommitPipeline.committed(state, second_ref)

      assert CommitPipeline.releasable(state) == []

      state = advance_to(state, first_ref, :committing)
      {:ok, _first, state} = CommitPipeline.abandon(state, first_ref, :injected)

      assert [%Batch{gsn_start: 2}] = CommitPipeline.releasable(state)
    end

    test "release order is claim order across arbitrary acks" do
      for iteration <- 1..300 do
        :rand.seed(:exsss, {549, iteration * 17, 9001 + iteration})
        count = :rand.uniform(6)

        {refs, state} =
          Enum.reduce(1..count, {[], CommitPipeline.new(max_in_flight: count)}, fn gsn,
                                                                                   {refs, state} ->
            {ref, _batch, state} = claim!(state, gsn, ["act_#{gsn}_a", "act_#{gsn}_b"])
            {refs ++ [ref], state}
          end)

        statuses = Map.new(refs, fn ref -> {ref, Enum.random([:commit, :abandon, :open])} end)

        state =
          refs
          |> Enum.shuffle()
          |> Enum.reduce(state, fn ref, state ->
            state = advance_to(state, ref, :committing)

            case Map.fetch!(statuses, ref) do
              :commit ->
                {:ok, _batch, state} = CommitPipeline.committed(state, ref)
                state

              :abandon ->
                {:ok, _batch, state} = CommitPipeline.abandon(state, ref, :injected)
                state

              :open ->
                state
            end
          end)

        assert_guard(state)
        assert_releasable_prefix(state)

        {released, state} = drain(state, [])
        assert_release_order(released)

        # Commit every range still open, then drain again. The final release
        # order is the original claim order minus the abandoned ranges.
        state =
          Enum.reduce(refs, state, fn ref, state ->
            case CommitPipeline.get(state, ref) do
              %Batch{phase: :committing} ->
                {:ok, _batch, state} = CommitPipeline.committed(state, ref)
                state

              _ ->
                state
            end
          end)

        {more_released, state} = drain(state, [])
        released = released ++ more_released

        assert_release_order(released)

        expected =
          refs
          |> Enum.with_index(1)
          |> Enum.reject(fn {ref, _gsn} -> Map.fetch!(statuses, ref) == :abandon end)
          |> Enum.map(fn {_ref, gsn} -> gsn end)

        assert Enum.map(released, & &1.gsn_start) == expected
        assert state.in_flight_ids == MapSet.new()
        refute CommitPipeline.inflight?(state)
      end
    end
  end

  describe "buffer stats" do
    test "reports the open claims and the oldest unreleased gsn" do
      state = CommitPipeline.new(max_in_flight: 2)

      assert CommitPipeline.buffer_stats(state) == %{
               in_flight_batches: 0,
               oldest_unreleased_gsn: 0
             }

      {first_ref, _first, state} = claim!(state, 1)

      assert CommitPipeline.buffer_stats(state) == %{
               in_flight_batches: 1,
               oldest_unreleased_gsn: 1
             }

      {_second_ref, _second, state} = claim!(state, 2)

      assert CommitPipeline.buffer_stats(state) == %{
               in_flight_batches: 2,
               oldest_unreleased_gsn: 1
             }

      state = advance_to(state, first_ref, :committed)
      {:ok, _batch, state} = CommitPipeline.applying(state, first_ref)
      {:ok, _batch, state} = CommitPipeline.release(state, first_ref)

      assert CommitPipeline.buffer_stats(state) == %{
               in_flight_batches: 1,
               oldest_unreleased_gsn: 2
             }
    end
  end

  describe "overlay chain state" do
    test "a released batch drops its cache slice but a successor keeps its own" do
      state = CommitPipeline.new(max_in_flight: 2)
      {first_ref, _first, state} = claim!(state, 1)
      {second_ref, _second, state} = claim!(state, 2)

      {:ok, _first, state} =
        CommitPipeline.prepared(state, first_ref, [], %{}, {[], nil}, {[], :first_slice})

      {:ok, _second, state} =
        CommitPipeline.prepared(state, second_ref, [], %{}, {[], nil}, {[], :second_slice})

      assert CommitPipeline.cache_slices(state) == [:first_slice, :second_slice]

      {:ok, _first, state} = CommitPipeline.committing(state, first_ref)
      {:ok, _first, state} = CommitPipeline.committed(state, first_ref)
      {:ok, _first, state} = CommitPipeline.applying(state, first_ref)
      {:ok, _first, state} = CommitPipeline.release(state, first_ref)

      assert CommitPipeline.cache_slices(state) == [:second_slice]
    end

    test "a prepared successor can be rebuilt in place" do
      state = CommitPipeline.new()
      {ref, _batch, state} = claim!(state, 1)

      {:ok, _batch, state} =
        CommitPipeline.prepared(state, ref, [], %{}, {[], nil}, {[], :stale})

      {:ok, rebuilt, _state} =
        CommitPipeline.reprepared(state, ref, [:rebuilt], %{1 => ["g_1"]}, {[], 7}, {[], :fresh})

      assert rebuilt.phase == :prepared
      assert rebuilt.prepared == [:rebuilt]
      assert rebuilt.groups_by_gsn == %{1 => ["g_1"]}
      assert rebuilt.pending_marks == {[], 7}
      assert rebuilt.cache_overlay == :fresh
    end
  end

  describe "flush scheduling" do
    test "an empty pipeline is idle and a burst drains through one marker" do
      state = CommitPipeline.new()
      assert {:idle, state} = CommitPipeline.schedule(state, 1000, 0)
      assert state.flush_scheduled == false

      state = enqueue(state, 1)
      assert {:send_flush, state} = CommitPipeline.schedule(state, 1000, 0)
      assert state.flush_scheduled

      assert {:wait, state} = CommitPipeline.schedule(state, 1000, 0)

      {state, pending} = CommitPipeline.take_pending(state)
      assert length(pending) == 1
      assert state.pending == []
      assert state.pending_count == 0
      assert state.flush_scheduled == false
      assert state.flush_timer == false
    end

    test "the batch cap flushes immediately and the timer defers" do
      state = CommitPipeline.new() |> enqueue(2)
      assert {:flush, _state} = CommitPipeline.schedule(state, 2, 0)

      state = CommitPipeline.new() |> enqueue(1)
      assert {:schedule_timer, state} = CommitPipeline.schedule(state, 1000, 50)
      assert state.flush_timer
      assert {:wait, _state} = CommitPipeline.schedule(state, 1000, 50)

      state = CommitPipeline.clear_timer(state)
      assert state.flush_timer == false
    end

    test "an in-flight batch stalls scheduling even when calls are pending" do
      state = CommitPipeline.new()
      {_ref, _batch, state} = claim!(state, 1)
      state = enqueue(state, 4)

      assert {:wait, state} = CommitPipeline.schedule(state, 1, 0)
      assert state.pending_count == 4
      assert CommitPipeline.inflight?(state)
    end

    test "the configured pipeline depth stops scheduling, not claiming" do
      state = CommitPipeline.new(max_in_flight: 2)
      {_first_ref, _first, state} = claim!(state, 1)
      {_second_ref, _second, state} = claim!(state, 2)
      state = enqueue(state, 1)

      # Two claims are at the depth cap; the next flush waits for a release.
      assert {:wait, state} = CommitPipeline.schedule(state, 1000, 0)
      assert map_size(state.batches) == 2
    end
  end

  defp claim!(state, gsn, ids \\ nil) do
    ref = make_ref()
    ids = ids || ["act_#{gsn}"]

    batch = %Batch{
      ref: ref,
      gsn_start: gsn,
      gsn_end: gsn,
      action_ids: ids,
      pending: [],
      ranges: %{0 => {gsn, gsn}},
      started_at: 0,
      batch_size: length(ids)
    }

    {:ok, batch, state} = CommitPipeline.claim(state, batch)
    {ref, batch, state}
  end

  defp enqueue(state, count) do
    actions = for i <- 1..count, do: {:action, <<i>>}
    CommitPipeline.enqueue(state, {self(), make_ref()}, actions)
  end

  defp advance_to(state, _ref, :claimed), do: state

  defp advance_to(state, ref, :prepared) do
    {:ok, _batch, state} = prepared!(state, ref)
    state
  end

  defp advance_to(state, ref, :committing) do
    {:ok, _batch, state} = prepared!(state, ref)
    {:ok, _batch, state} = CommitPipeline.committing(state, ref)
    state
  end

  defp advance_to(state, ref, :committed) do
    state = advance_to(state, ref, :committing)
    {:ok, _batch, state} = CommitPipeline.committed(state, ref)
    state
  end

  defp prepared!(state, ref) do
    CommitPipeline.prepared(state, ref, [], %{}, {[], nil})
  end

  defp drain(state, released) do
    case CommitPipeline.releasable(state) do
      [] ->
        {released, state}

      ready ->
        state =
          Enum.reduce(ready, state, fn batch, state ->
            {:ok, _batch, state} = CommitPipeline.applying(state, batch.ref)
            {:ok, _batch, state} = CommitPipeline.release(state, batch.ref)
            state
          end)

        drain(state, released ++ ready)
    end
  end

  defp assert_guard(state) do
    expected =
      state.batches
      |> Map.values()
      |> Enum.filter(&(&1.phase in [:claimed, :prepared, :committing]))
      |> Enum.flat_map(& &1.action_ids)
      |> MapSet.new()

    assert state.in_flight_ids == expected
  end

  defp assert_releasable_prefix(state) do
    ready = CommitPipeline.releasable(state)

    open =
      Enum.find(state.claim_order, fn ref ->
        CommitPipeline.get(state, ref).phase != :committed
      end)

    if open do
      open_gsn = CommitPipeline.get(state, open).gsn_start
      assert Enum.all?(ready, &(&1.gsn_start < open_gsn))
    end
  end

  defp assert_release_order(released) do
    gsns = Enum.map(released, & &1.gsn_start)
    assert gsns == Enum.sort(gsns)
  end
end
