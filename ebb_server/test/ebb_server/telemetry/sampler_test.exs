defmodule EbbServer.Telemetry.SamplerTest do
  # The sampler emits global `:telemetry` events, so these tests must not run
  # while other modules' telemetry handlers are attached.
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers

  alias EbbServer.Storage.{DirtyTracker, RocksDB, WatermarkTracker}
  alias EbbServer.Telemetry.Sampler

  setup do
    %{cache: start_isolated_cache(), rocks: start_rocks()}
  end

  describe "start_link/1 with enabled: false" do
    test "returns :ignore and registers no process" do
      name = :"disabled_sampler_#{System.unique_integer([:positive])}"

      assert :ignore = Sampler.start_link(enabled: false, name: name)
      assert Process.whereis(name) == nil
    end

    test "honors the application config when no option overrides it" do
      # config/test.exs disables the sampler under its application env, the
      # same path the real supervision tree takes on boot.
      assert Application.get_env(:ebb_server, Sampler)[:enabled] == false

      name = :"app_disabled_sampler_#{System.unique_integer([:positive])}"

      assert :ignore = Sampler.start_link(name: name)
      assert Process.whereis(name) == nil
    end
  end

  describe "sampling" do
    test "emits watermark lag and dirty-set size from the underlying tables", %{
      cache: cache,
      rocks: rocks
    } do
      :ok =
        RocksDB.write_batch(
          [{:put, RocksDB.cf_actions(rocks.name), RocksDB.encode_gsn_key(1), "action"}],
          name: rocks.name
        )

      :ok = DirtyTracker.mark_dirty_batch(["todo_a", "todo_b", "todo_c"], cache.dirty_set)

      expected_lag =
        RocksDB.get_max_gsn(rocks.name) -
          WatermarkTracker.committed_watermark(cache.watermark_tracker)

      assert expected_lag == 1

      ref = attach_telemetry([[:ebb, :watermark, :lag], [:ebb, :dirty_set, :size]])

      start_supervised!(
        {Sampler,
         [
           enabled: true,
           interval_ms: 30,
           rocks_name: rocks.name,
           watermark_tracker: cache.watermark_tracker,
           dirty_set: cache.dirty_set
         ]}
      )

      assert {[:ebb, :watermark, :lag], %{lag: ^expected_lag}, %{}} = await_event(ref)
      assert {[:ebb, :dirty_set, :size], %{size: 3}, %{}} = await_event(ref)
    end

    test "emits repeatedly on the configured interval", %{cache: cache, rocks: rocks} do
      ref = attach_telemetry([[:ebb, :watermark, :lag]])

      start_supervised!(
        {Sampler,
         [
           enabled: true,
           interval_ms: 20,
           rocks_name: rocks.name,
           watermark_tracker: cache.watermark_tracker,
           dirty_set: cache.dirty_set
         ]}
      )

      events = for _ <- 1..3, do: await_event(ref)

      assert Enum.all?(
               events,
               &match?({[:ebb, :watermark, :lag], %{lag: lag}, %{}} when is_integer(lag), &1)
             )
    end

    test "keeps sampling when the watermark lag read fails", %{cache: cache} do
      :ok = DirtyTracker.mark_dirty_batch(["todo_a"], cache.dirty_set)
      ref = attach_telemetry([[:ebb, :watermark, :lag], [:ebb, :dirty_set, :size]])

      pid =
        start_supervised!(
          {Sampler,
           [
             enabled: true,
             interval_ms: 20,
             rocks_name: :rocks_that_is_not_running,
             watermark_tracker: cache.watermark_tracker,
             dirty_set: cache.dirty_set
           ]}
        )

      assert {[:ebb, :dirty_set, :size], %{size: 1}, %{}} = await_event(ref)
      assert {[:ebb, :dirty_set, :size], %{size: 1}, %{}} = await_event(ref)
      assert {[:ebb, :dirty_set, :size], %{size: 1}, %{}} = await_event(ref)

      assert Process.alive?(pid)
      refute_received {:telemetry_event, ^ref, [:ebb, :watermark, :lag], _, _}
    end
  end

  describe "fan-out gauges (#363)" do
    test "emits active connection and group counts from the injected supervisors", %{
      cache: cache,
      rocks: rocks
    } do
      connection_supervisor = start_dynamic_supervisor()
      group_supervisor = start_dynamic_supervisor()
      start_child(connection_supervisor)
      start_child(group_supervisor)

      ref =
        attach_telemetry([
          [:ebb, :fanout, :active_connections],
          [:ebb, :fanout, :active_groups]
        ])

      start_supervised!(
        {Sampler,
         [
           enabled: true,
           interval_ms: 30,
           rocks_name: rocks.name,
           watermark_tracker: cache.watermark_tracker,
           dirty_set: cache.dirty_set,
           connection_supervisor: connection_supervisor,
           group_supervisor: group_supervisor
         ]}
      )

      assert {[:ebb, :fanout, :active_connections], %{count: connections}, %{}} =
               await_event(ref)

      assert {[:ebb, :fanout, :active_groups], %{count: groups}, %{}} = await_event(ref)

      assert connections == 1
      assert groups == 1
    end

    test "a missing supervisor skips only its own gauge", %{cache: cache, rocks: rocks} do
      group_supervisor = start_dynamic_supervisor()
      start_child(group_supervisor)

      ref =
        attach_telemetry([
          [:ebb, :fanout, :active_connections],
          [:ebb, :fanout, :active_groups]
        ])

      pid =
        start_supervised!(
          {Sampler,
           [
             enabled: true,
             interval_ms: 20,
             rocks_name: rocks.name,
             watermark_tracker: cache.watermark_tracker,
             dirty_set: cache.dirty_set,
             connection_supervisor: :fanout_missing_connection_supervisor,
             group_supervisor: group_supervisor
           ]}
        )

      assert {[:ebb, :fanout, :active_groups], %{count: 1}, %{}} = await_event(ref)
      assert {[:ebb, :fanout, :active_groups], %{count: 1}, %{}} = await_event(ref)

      assert Process.alive?(pid)
      refute_received {:telemetry_event, ^ref, [:ebb, :fanout, :active_connections], _, _}
    end
  end

  defp await_event(ref, timeout \\ 1_000) do
    receive do
      {:telemetry_event, ^ref, event, measurements, metadata} ->
        {event, measurements, metadata}
    after
      timeout -> flunk("expected a telemetry event within #{timeout}ms")
    end
  end

  defp start_dynamic_supervisor do
    name = :"fanout_dyn_sup_#{System.unique_integer([:positive])}"
    {:ok, pid} = DynamicSupervisor.start_link(name: name)

    on_exit(fn ->
      if Process.alive?(pid), do: DynamicSupervisor.stop(pid)
    end)

    name
  end

  defp start_child(supervisor) do
    {:ok, _pid} =
      DynamicSupervisor.start_child(supervisor, {Task, fn -> Process.sleep(:infinity) end})

    :ok
  end
end
