defmodule EbbServer.Storage.SupervisorRestartTest do
  @moduledoc """
  In-process recovery for the storage tree (ebbjs/ebbjs#632).

  A `Storage.Supervisor` death used to be unrecoverable. The children were
  killed through their links without running `terminate/2`, so their handles
  stayed published in `:persistent_term`, and the replacement RocksDB could
  not take the LOCK file. Starting the replacement immediately — which is what
  the parent supervisor does — also failed on the registered names the dying
  children still held, and each failure burned one of the parent's restarts.

  These tests restart the tree the way the parent does: as soon as it is dead,
  with the predecessor's children still on their way out.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  @moduletag :capture_log

  alias EbbServer.Health
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Storage.WatermarkTracker
  alias EbbServer.Storage.Supervisor, as: StorageSupervisor
  alias EbbServer.TestHelpers

  test "a replacement tree opens RocksDB on the same data dir", %{tmp_dir: tmp_dir} do
    Process.flag(:trap_exit, true)
    assert Health.status() == :ok

    sup = Process.whereis(StorageSupervisor)
    assert is_pid(sup)
    sup_ref = Process.monitor(sup)

    Process.exit(sup, :kill)
    assert_receive {:DOWN, ^sup_ref, :process, ^sup, :killed}

    assert {:error, {:storage, :not_started}} = Health.status()

    # No waiting for the predecessor's children here: the parent supervisor
    # cannot wait either, and the replacement has to survive their teardown,
    # including a `db_ref` that still holds the RocksDB LOCK.
    {:ok, replacement} = StorageSupervisor.start_link(data_dir: tmp_dir)
    on_exit(fn -> TestHelpers.safe_stop(replacement) end)

    assert Health.status() == :ok
    assert RocksDB.get_max_gsn() >= 0
  end

  test "the replacement waits for the predecessor's registered names", %{tmp_dir: tmp_dir} do
    Process.flag(:trap_exit, true)

    # Stop the tree this test was given the graceful way, so every child name
    # is free, then take one back: a name held past the replacement's start is
    # what used to fail the restart with `:already_started`.
    sup = Process.whereis(StorageSupervisor)
    assert is_pid(sup)
    assert TestHelpers.safe_stop(sup) == :ok

    test_pid = self()

    holder =
      spawn(fn ->
        Process.register(self(), WatermarkTracker)
        send(test_pid, :name_held)

        receive do
          :release -> :ok
        end
      end)

    assert_receive :name_held, 2_000
    on_exit(fn -> Process.exit(holder, :kill) end)

    # The replacement is unlinked from its starter, so an assertion between the
    # start and the await must not leave it registered for the rest of the run.
    on_exit(fn ->
      case Process.whereis(StorageSupervisor) do
        nil ->
          :ok

        ^sup ->
          # Still the tree this case owns; the case's own cleanup stops it.
          :ok

        pid ->
          TestHelpers.safe_stop(pid)
      end
    end)

    # `Supervisor.start_link/1` registers the supervisor before `init/1` runs,
    # so a live name means `init/1` has begun. It does not prove the wait has
    # started, but a tree that did not wait fails on the held name below.
    task =
      Task.async(fn ->
        case StorageSupervisor.start_link(data_dir: tmp_dir) do
          {:ok, pid} = started ->
            # The starter is not the tree's owner; unlinking keeps the Task's
            # exit from taking the replacement down with it.
            Process.unlink(pid)
            started

          other ->
            other
        end
      end)

    # The budget stays below `@predecessor_timeout_ms` (5s), so on the
    # regression this test guards — `init/1` not waiting at all and failing on
    # the held name — the poll reports that instead of racing the give-up.
    assert TestHelpers.wait_until(fn -> Process.whereis(StorageSupervisor) != nil end, 400),
           "the replacement never reached init/1 while #{inspect(WatermarkTracker)} was held"

    # The wait only ends once the held name is free, so the holder still owns
    # it here while the replacement is starting.
    assert Process.whereis(WatermarkTracker) == holder
    assert Task.yield(task, 0) == nil

    send(holder, :release)

    # Generous: the wait above already proved the blocking property, and this
    # only bounds the tree start that follows the release, which opens RocksDB
    # and SQLite and can take seconds on a loaded runner. The replacement still
    # rides the production 5s predecessor budget; overrunning it is the
    # behaviour under test, not a test defect.
    assert {:ok, replacement} = Task.await(task, 30_000)
    on_exit(fn -> TestHelpers.safe_stop(replacement) end)

    assert Health.status() == :ok
  end
end
