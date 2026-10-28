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

    assert_receive :name_held
    on_exit(fn -> Process.exit(holder, :kill) end)

    spawn(fn ->
      Process.sleep(300)
      send(holder, :release)
    end)

    started_at = System.monotonic_time(:millisecond)
    assert {:ok, replacement} = StorageSupervisor.start_link(data_dir: tmp_dir)
    waited = System.monotonic_time(:millisecond) - started_at
    on_exit(fn -> TestHelpers.safe_stop(replacement) end)

    assert waited >= 300
    assert Health.status() == :ok
  end
end
