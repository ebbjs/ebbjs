defmodule EbbServer.Sync.GroupRegistryOutageTest do
  @moduledoc """
  Fan-out must survive the group `Registry` being unavailable
  (ebbjs/ebbjs#653).

  `EbbServer.Sync.GroupRegistry` is a sibling of the sync tree rather than
  a child of it, so there are windows — during its own restart, and between
  two trees in the test suite — where the name is unregistered.
  `Registry.lookup/2` raises `ArgumentError` in that window, which used to
  kill `FanOutRouter`. Its replacement re-derives the un-pushed ranges on
  `init/1` and crashes on the same push again, so a single commit could
  exhaust `EbbServer.Sync.Supervisor`'s restart intensity; the supervisor
  then exits `:shutdown`, killing any test process linked to it.

  No registry means no live `GroupServer`s, so a fan-out in that window has
  no destination and is a no-op.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.Integration.ActionHelpers

  alias EbbServer.Integration.StorageCase
  alias EbbServer.Sync.{FanOutRouter, GroupRegistry}
  alias EbbServer.Sync.Supervisor, as: SyncSupervisor

  test "a commit while the registry is down leaves the router running" do
    router = Process.whereis(FanOutRouter)
    actor_id = "a_outage_#{:erlang.unique_integer([:positive])}"

    take_down_registry()

    # Each commit fans out to its group. The Writer notifies before it
    # replies, so the `:sys.get_state/1` call below is handled after that
    # notification and reports a router that crashed while handling it.
    for n <- 1..3 do
      bootstrap_group(actor_id, "g_outage_#{n}", ["read"])
      _ = :sys.get_state(FanOutRouter)

      assert Process.whereis(FanOutRouter) == router
    end

    assert is_pid(Process.whereis(SyncSupervisor))
  end

  test "unsubscribing and broadcasting presence while the registry is down are no-ops" do
    router = Process.whereis(FanOutRouter)
    group_id = "g_outage_#{:erlang.unique_integer([:positive])}"
    connection = spawn(fn -> Process.sleep(:infinity) end)

    :ok = FanOutRouter.subscribe([group_id], connection, "a_outage")
    take_down_registry()

    # A cast then a call, so the cast is handled first.
    :ok = FanOutRouter.broadcast_presence([group_id], "e_outage", "a_outage", %{})
    :ok = FanOutRouter.unsubscribe(connection)

    assert Process.whereis(FanOutRouter) == router
  end

  # Stopping the registry through the application supervisor would have it
  # restarted mid-test, so detach it first when that tree is still up, and
  # put it back afterwards so the rest of the suite sees the tree it
  # started with.
  defp take_down_registry do
    parent = Process.whereis(EbbServer.Supervisor)
    detached = parent && Supervisor.terminate_child(parent, GroupRegistry) == :ok

    StorageCase.stop_if_running(GroupRegistry)
    refute Process.whereis(GroupRegistry)

    if detached, do: on_exit(fn -> restore_app_registry() end)
  end

  defp restore_app_registry do
    case Process.whereis(EbbServer.Supervisor) do
      nil -> :ok
      parent -> Supervisor.restart_child(parent, GroupRegistry)
    end

    :ok
  end
end
