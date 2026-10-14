defmodule EbbServer.Storage.SystemCacheStartupFailureTest do
  @moduledoc """
  A cache rebuild that raises must fail the storage start, not report
  health over a half-populated cache (ebbjs/ebbjs#421).

  `SystemCache.init/1` used to rescue the populate path and return
  `{:ok, state}`, so a partial rebuild looked like a clean start and no
  escalation fired. This test seeds an undecodable Action into
  `cf_actions` — the same failure mode the removed backfill rescue hid —
  and asserts `Storage.Supervisor` refuses to start.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.RocksDB
  alias EbbServer.Storage.Supervisor, as: StorageSupervisor
  alias EbbServer.Storage.SystemCache
  alias EbbServer.TestHelpers

  setup do
    # `start_link` links the caller to a supervisor that exits abnormally
    # when a child fails to start; trap so the assertion can read the
    # returned `{:error, reason}` instead of the test process dying.
    Process.flag(:trap_exit, true)

    # Free the global storage child names and the RocksDB lock. Other tests
    # (integration cases) can leave the application supervisor stopped, in
    # which case the names are already free.
    parent = Process.whereis(EbbServer.Supervisor)

    if is_pid(parent) do
      case Elixir.Supervisor.terminate_child(parent, StorageSupervisor) do
        :ok -> :ok
        {:error, :not_found} -> :ok
      end
    end

    on_exit(fn ->
      stop_storage_supervisor()

      if is_pid(parent) and Process.alive?(parent) do
        case Elixir.Supervisor.restart_child(parent, StorageSupervisor) do
          {:ok, _pid} -> :ok
          {:error, _reason} -> :ok
        end
      end
    end)

    :ok
  end

  test "refuses to start when the type-entities backfill cannot decode an Action" do
    dir = TestHelpers.tmp_dir(%{module: __MODULE__, test: "corrupt_action"})
    seed = :ebb_421_corrupt_seed

    {:ok, seed_pid} = RocksDB.start_link(data_dir: dir, name: seed)

    :ok =
      :rocksdb.put(
        RocksDB.db_ref(seed),
        RocksDB.cf_actions(seed),
        RocksDB.encode_gsn_key(1),
        <<0, 1, 2>>,
        []
      )

    :ok = GenServer.stop(seed_pid, :normal)

    assert {:error,
            {:shutdown,
             {:failed_to_start_child, SystemCache, {:system_cache_init_failed, %ArgumentError{}}}}} =
             StorageSupervisor.start_link(data_dir: dir, writer_opts: [])

    refute Process.whereis(SystemCache)
  end

  defp stop_storage_supervisor do
    if pid = Process.whereis(StorageSupervisor) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        _, _ -> :ok
      end
    end
  end
end
