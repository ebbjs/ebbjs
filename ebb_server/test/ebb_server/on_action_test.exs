defmodule EbbServer.OnActionTest do
  @moduledoc """
  Behavioral tests for the `onAction` developer hook.

  The Writer fires the configured handler once per durably committed
  Action, after the commit lands and off the critical path, so a slow or
  raising handler can never affect the write or its ack.
  """

  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  import ExUnit.CaptureLog

  alias EbbServer.Storage.Writer

  defmodule Handler do
    @moduledoc false

    def handle(payload) do
      send(:on_action_test_sink, {:on_action, payload})
    end
  end

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    } = start_isolated_cache()

    %{name: rocks_name} = start_rocks()
    ensure_on_action_supervisor()

    %{
      rocks_name: rocks_name,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id
    }
  end

  describe "onAction dispatch" do
    test "receives the action and the group set the commit resolved", ctx do
      test_pid = self()
      hlc = generate_hlc()

      %{name: writer_name} =
        start_writer(
          Map.put(ctx, :on_action, fn payload -> send(test_pid, {:on_action, payload}) end)
        )

      action = %{
        id: "act_on_action",
        actor_id: "actor_on_action",
        hlc: hlc,
        updates: [
          todo_update("upd_on_action", "todo_on_action", hlc),
          entity_group_update("eg_on_action", "todo_on_action", "group_on_action", hlc)
        ]
      }

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert_receive {:on_action, payload}
      assert payload.id == "act_on_action"
      assert payload.actor_id == "actor_on_action"
      assert payload.hlc == hlc
      assert payload.gsn == 1
      assert payload.updates == action.updates
      assert payload.groups == ["group_on_action"]
    end

    test "dispatches once per action with each action's own GSN", ctx do
      test_pid = self()

      %{name: writer_name} =
        start_writer(
          Map.put(ctx, :on_action, fn payload -> send(test_pid, {:on_action, payload}) end)
        )

      first = validated_action(%{id: "act_first"})
      second = validated_action(%{id: "act_second"})

      assert {:ok, {1, 2}, []} = Writer.write_actions([first, second], writer_name)

      assert_receive {:on_action, %{id: "act_first", gsn: 1}}
      assert_receive {:on_action, %{id: "act_second", gsn: 2}}
    end

    test "accepts a {Module, :function} handler", ctx do
      Process.register(self(), :on_action_test_sink)

      %{name: writer_name} =
        start_writer(Map.put(ctx, :on_action, {Handler, :handle}))

      action = validated_action(%{id: "act_module_handler"})

      assert {:ok, {1, 1}, []} = Writer.write_actions([action], writer_name)

      assert_receive {:on_action, %{id: "act_module_handler", gsn: 1}}
    end
  end

  describe "handler failures" do
    test "a raising handler does not fail the write and the writer keeps working", ctx do
      %{name: writer_name} =
        start_writer(Map.put(ctx, :on_action, fn _payload -> raise "handler exploded" end))

      capture_log(fn ->
        assert {:ok, {1, 1}, []} =
                 Writer.write_actions([validated_action(%{id: "act_raise"})], writer_name)

        assert {:ok, {2, 2}, []} =
                 Writer.write_actions(
                   [validated_action(%{id: "act_raise_next"})],
                   writer_name
                 )

        await_task_completion()
        Logger.flush()
      end)
    end

    test "logs and swallows a failing handler without taking down the dispatcher" do
      test_pid = self()

      handler = fn _payload ->
        send(test_pid, :handler_ran)
        raise "handler exploded"
      end

      log =
        capture_log(fn ->
          assert :ok = EbbServer.OnAction.dispatch_all(handler, [%{id: "act_log"}])
          assert_receive :handler_ran
          await_task_completion()
          Logger.flush()
        end)

      assert log =~ "onAction handler"
      assert log =~ "handler exploded"
      assert Process.alive?(Process.whereis(EbbServer.OnAction.Supervisor))
    end
  end

  describe "application env configuration" do
    test "uses the handler from :ebb_server, :on_action when no opt is given", ctx do
      test_pid = self()

      Application.put_env(:ebb_server, :on_action, fn payload ->
        send(test_pid, {:on_action, payload})
      end)

      on_exit(fn -> Application.delete_env(:ebb_server, :on_action) end)

      %{name: writer_name} = start_writer(ctx)

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_env"})], writer_name)

      assert_receive {:on_action, %{id: "act_env", gsn: 1}}
    end
  end

  describe "without a configured handler" do
    test "writes successfully and dispatches nothing", ctx do
      %{name: writer_name} = start_writer(ctx)

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_no_handler"})], writer_name)

      refute_receive {:on_action, _payload}, 100
    end
  end

  defp await_task_completion(attempts \\ 100)

  defp await_task_completion(0), do: flunk("onAction task did not finish")

  defp await_task_completion(attempts) do
    case Task.Supervisor.children(EbbServer.OnAction.Supervisor) do
      [] ->
        :ok

      _children ->
        Process.sleep(5)
        await_task_completion(attempts - 1)
    end
  end

  # The integration suite tears down the application supervision tree (see
  # `EbbServer.Integration.StorageCase`), and the dispatcher lives under it.
  # Stand one up outside the tree when it is gone so the hook has somewhere
  # to run, exactly as those tests do for `Storage.Supervisor`.
  defp ensure_on_action_supervisor do
    case Task.Supervisor.start_link(name: EbbServer.OnAction.Supervisor) do
      {:ok, pid} -> on_exit(fn -> safe_stop(pid) end)
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  defp entity_group_update(id, entity_id, group_id, hlc) do
    %{
      id: id,
      subject_id: id,
      subject_type: "entityGroup",
      method: :put,
      data: %{
        "fields" => %{
          "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
        }
      }
    }
  end

  defp todo_update(id, entity_id, hlc) do
    %{
      id: id,
      subject_id: entity_id,
      subject_type: "todo",
      method: :put,
      data: %{
        "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
      }
    }
  end
end
