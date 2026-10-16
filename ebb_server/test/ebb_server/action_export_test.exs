defmodule EbbServer.ActionExportTest do
  @moduledoc """
  Behavioral tests for the opt-in Action exporter.

  The exporter is a consumer of the committed log: it reads from a durable
  cursor behind the resolution frontier and invokes an application handler
  once per Action. It is off the write path, so no handler can affect a
  write; delivery is at-least-once, so a failing handler stalls the cursor
  rather than skipping the batch.
  """

  use ExUnit.Case, async: false

  alias EbbServer.ActionExport
  alias EbbServer.Storage.Writer

  import EbbServer.TestHelpers

  @export_events [
    [:ebb, :action_export, :batch],
    [:ebb, :action_export, :failed],
    [:ebb, :action_export, :filtered],
    [:ebb, :action_export, :lag]
  ]

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name, dir: dir} = start_rocks()
    %{name: sqlite_name} = start_sqlite(dir)

    %{name: writer_name} =
      start_writer(writer_opts(Map.put(cache, :rocks_name, rocks_name), %{}))

    %{
      cache: cache,
      rocks_name: rocks_name,
      sqlite: sqlite_name,
      writer_name: writer_name,
      cursor_name: "action_export_#{System.unique_integer([:positive])}"
    }
  end

  defp start_exporter(ctx, opts) do
    name = :"exporter_#{System.unique_integer([:positive])}"
    task_supervisor = :"export_tasks_#{System.unique_integer([:positive])}"
    {:ok, _pid} = Task.Supervisor.start_link(name: task_supervisor)

    base = [
      name: name,
      rocks_name: ctx.rocks_name,
      watermark_tracker: ctx.cache.watermark_tracker,
      sqlite: ctx.sqlite,
      cursor_name: ctx.cursor_name,
      task_supervisor: task_supervisor,
      poll_interval_ms: 60_000
    ]

    {:ok, pid} = ActionExport.start_link(Keyword.merge(base, opts))

    on_exit(fn ->
      safe_stop(pid)

      if task_pid = Process.whereis(task_supervisor) do
        safe_stop(task_pid)
      end
    end)

    %{name: name, pid: pid}
  end

  defp write(actions, writer_name) do
    assert {:ok, _range, []} = Writer.write_actions(actions, writer_name)
  end

  defp collect_exported(ref, count, timeout \\ 2_000) do
    do_collect_exported(ref, count, [], timeout)
  end

  defp do_collect_exported(_ref, 0, acc, _timeout), do: Enum.reverse(acc)

  defp do_collect_exported(ref, count, acc, timeout) do
    receive do
      {:exported, ^ref, action} -> do_collect_exported(ref, count - 1, [action | acc], timeout)
    after
      timeout -> Enum.reverse(acc)
    end
  end

  # Waits for one telemetry event, leaving any others queued for later reads.
  defp await_event(ref, event, timeout \\ 2_000) do
    await_event(ref, event, System.monotonic_time(:millisecond) + timeout, [])
  end

  defp await_event(ref, event, deadline, stashed) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:telemetry_event, ^ref, ^event, measurements, metadata} ->
        Enum.each(stashed, &send(self(), &1))
        {measurements, metadata}

      {:telemetry_event, ^ref, _other, _measurements, _metadata} = message ->
        await_event(ref, event, deadline, [message | stashed])
    after
      remaining -> flunk("timed out waiting for telemetry #{inspect(event)}")
    end
  end

  defp find_event(events, name) do
    Enum.find(events, &match?({^name, _, _}, &1))
  end

  describe "exporting committed actions" do
    test "invokes the handler once per action in GSN order", ctx do
      write(
        [
          validated_action(%{
            id: "act_1",
            updates: [validated_update(%{id: "u_1", subject_id: "todo_1", subject_type: "todo"})]
          }),
          validated_action(%{
            id: "act_2",
            updates: [validated_update(%{id: "u_2", subject_id: "todo_2", subject_type: "todo"})]
          })
        ],
        ctx.writer_name
      )

      ref = make_ref()
      test_pid = self()

      %{name: name} =
        start_exporter(ctx,
          on_action: fn action -> send(test_pid, {:exported, ref, action}) end
        )

      actions = collect_exported(ref, 2)

      assert Enum.map(actions, & &1["id"]) == ["act_1", "act_2"]
      assert Enum.map(actions, & &1["gsn"]) == [1, 2]
      assert Enum.all?(actions, &is_binary(&1["actor_id"]))

      assert [%{"id" => "u_1", "subject_id" => "todo_1", "subject_type" => "todo"} = update] =
               hd(actions)["updates"]

      assert update["method"] == "put"
      assert is_map(update["data"])

      assert wait_until(fn -> ActionExport.cursor(name) == 2 end)
    end

    test "does nothing when no handler is configured", ctx do
      ref = attach_telemetry(@export_events)
      write([validated_action(%{id: "act_noop"})], ctx.writer_name)

      %{name: name} = start_exporter(ctx, on_action: nil)

      refute_receive {:telemetry_event, ^ref, _, _, _}, 200
      assert ActionExport.cursor(name) == 0
    end

    test "drains a backlog in bounded batches", ctx do
      test_pid = self()
      ref = make_ref()

      write(
        [
          validated_action(%{id: "act_1"}),
          validated_action(%{id: "act_2"}),
          validated_action(%{id: "act_3"})
        ],
        ctx.writer_name
      )

      %{name: name} =
        start_exporter(ctx,
          batch_size: 1,
          on_action: fn action -> send(test_pid, {:exported, ref, action}) end
        )

      assert Enum.map(collect_exported(ref, 3), & &1["id"]) == ["act_1", "act_2", "act_3"]
      assert wait_until(fn -> ActionExport.cursor(name) == 3 end)
    end
  end

  describe "handler failures" do
    test "a raising handler is logged, counted, and does not advance the cursor", ctx do
      ref = attach_telemetry(@export_events)
      write([validated_action(%{id: "act_raise"})], ctx.writer_name)

      test_pid = self()

      %{name: name, pid: pid} =
        start_exporter(ctx,
          on_action: fn action ->
            send(test_pid, {:attempted, action})
            raise "sink boom"
          end
        )

      assert_receive {:attempted, _action}, 2_000

      {measurements, metadata} = await_event(ref, [:ebb, :action_export, :failed])

      assert %{count: 1} = measurements

      assert %{
               gsn: 1,
               reason: {:handler_raise, %RuntimeError{message: "sink boom"}, _stacktrace}
             } =
               metadata

      assert ActionExport.cursor(name) == 0
      assert Process.alive?(pid)

      # The write path is unaffected: a hanging/raising sink cannot corrupt
      # or block a commit.
      assert {:ok, {2, 2}, []} = Writer.write_actions([validated_action()], ctx.writer_name)
    end

    test "a handler returning {:error, reason} does not advance the cursor", ctx do
      ref = attach_telemetry(@export_events)
      write([validated_action(%{id: "act_err"})], ctx.writer_name)

      test_pid = self()

      %{name: name, pid: pid} =
        start_exporter(ctx,
          on_action: fn action ->
            send(test_pid, {:attempted, action})
            {:error, :warehouse_unavailable}
          end
        )

      assert_receive {:attempted, _action}, 2_000

      assert {%{count: 1}, %{gsn: 1, reason: :warehouse_unavailable}} =
               await_event(ref, [:ebb, :action_export, :failed])

      assert ActionExport.cursor(name) == 0
      assert Process.alive?(pid)
    end

    test "a hanging handler is timed out and the exporter keeps polling", ctx do
      ref = attach_telemetry(@export_events)
      write([validated_action(%{id: "act_hang"})], ctx.writer_name)

      test_pid = self()

      %{name: name, pid: pid} =
        start_exporter(ctx,
          handler_timeout_ms: 50,
          poll_interval_ms: 20,
          on_action: fn action ->
            send(test_pid, {:attempted, action})
            Process.sleep(5_000)
          end
        )

      assert_receive {:attempted, _action}, 2_000
      # A second attempt proves the exporter did not hot-loop or give up.
      assert_receive {:attempted, _action}, 2_000

      assert {%{count: 1}, %{gsn: 1, reason: :handler_timeout}} =
               await_event(ref, [:ebb, :action_export, :failed])

      assert ActionExport.cursor(name) == 0
      assert Process.alive?(pid)
    end
  end

  describe "system row filtering" do
    test "strips system updates, keeps domain updates, and drops system-only actions", ctx do
      ref = attach_telemetry(@export_events)

      write(
        [
          validated_action(%{
            id: "act_mixed",
            updates: [
              validated_update(%{id: "u_todo", subject_id: "todo_1", subject_type: "todo"}),
              validated_update(%{id: "u_gm", subject_id: "gm_1", subject_type: "groupMember"})
            ]
          }),
          validated_action(%{
            id: "act_system",
            updates: [
              validated_update(%{id: "u_eg", subject_id: "eg_1", subject_type: "entityGroup"})
            ]
          })
        ],
        ctx.writer_name
      )

      test_pid = self()

      %{name: name} =
        start_exporter(ctx, on_action: fn action -> send(test_pid, {:exported, action}) end)

      assert_receive {:exported, action}, 2_000
      assert action["id"] == "act_mixed"
      assert Enum.map(action["updates"], & &1["id"]) == ["u_todo"]

      # The per-Update delivery scopes are internal routing metadata.
      refute Map.has_key?(action, "update_scopes")

      refute_receive {:exported, _action}, 200

      assert wait_until(fn -> ActionExport.cursor(name) == 2 end)

      assert {%{count: 2}, %{}} = await_event(ref, [:ebb, :action_export, :filtered])
    end
  end

  describe "cursor resume" do
    test "restarts from the durable cursor instead of re-delivering the prefix", ctx do
      test_pid = self()
      write([validated_action(%{id: "act_1"}), validated_action(%{id: "act_2"})], ctx.writer_name)

      ref_1 = make_ref()

      first =
        start_exporter(ctx,
          poll_interval_ms: 20,
          on_action: fn action -> send(test_pid, {:exported, ref_1, action}) end
        )

      assert Enum.map(collect_exported(ref_1, 2), & &1["id"]) == ["act_1", "act_2"]
      assert wait_until(fn -> ActionExport.cursor(first.name) == 2 end)
      safe_stop(first.pid)

      write([validated_action(%{id: "act_3"})], ctx.writer_name)

      ref_2 = make_ref()

      second =
        start_exporter(ctx,
          poll_interval_ms: 20,
          on_action: fn action -> send(test_pid, {:exported, ref_2, action}) end
        )

      assert Enum.map(collect_exported(ref_2, 1), & &1["id"]) == ["act_3"]
      assert wait_until(fn -> ActionExport.cursor(second.name) == 3 end)
    end
  end

  describe "telemetry" do
    test "emits lag and batch events for a successful export", ctx do
      ref = attach_telemetry(@export_events)

      write([validated_action(%{id: "act_1"}), validated_action(%{id: "act_2"})], ctx.writer_name)

      test_pid = self()

      %{name: name, pid: pid} =
        start_exporter(ctx, on_action: fn action -> send(test_pid, {:exported, action}) end)

      assert_receive {:exported, _action}, 2_000
      assert_receive {:exported, _action}, 2_000
      assert wait_until(fn -> ActionExport.cursor(name) == 2 end)

      safe_stop(pid)

      events = telemetry_events(ref)

      assert {[:ebb, :action_export, :batch], %{count: 2}, %{from_gsn: 1, to_gsn: 2}} =
               find_event(events, [:ebb, :action_export, :batch])

      assert {[:ebb, :action_export, :lag], %{lag: 2}, %{cursor: 0}} =
               find_event(events, [:ebb, :action_export, :lag])
    end
  end

  describe "application wiring" do
    test "no exporter child unless :on_action is configured" do
      without_on_action(fn ->
        assert EbbServer.Application.action_export_children() == []
      end)
    end

    test "the exporter supervisor is a child when :on_action is configured" do
      with_on_action({SomeModule, :some_function}, fn ->
        assert EbbServer.Application.action_export_children() == [
                 EbbServer.ActionExport.Supervisor
               ]
      end)
    end
  end

  defp with_on_action(value, fun) do
    original = Application.get_env(:ebb_server, :on_action)
    set_on_action(value)
    on_exit(fn -> set_on_action(original) end)
    fun.()
  end

  defp without_on_action(fun) do
    original = Application.get_env(:ebb_server, :on_action)
    set_on_action(nil)
    on_exit(fn -> set_on_action(original) end)
    fun.()
  end

  defp set_on_action(nil), do: Application.delete_env(:ebb_server, :on_action)
  defp set_on_action(value), do: Application.put_env(:ebb_server, :on_action, value)
end
