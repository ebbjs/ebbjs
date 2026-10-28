defmodule EbbServer.HealthTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Health

  defmodule ChildReport do
    @moduledoc false
    # Stands in for `Storage.Supervisor` when a test needs the readiness probe
    # to see a specific `which_children/1` answer.
    use GenServer

    def start_link(children) do
      GenServer.start_link(__MODULE__, children, name: EbbServer.Storage.Supervisor)
    end

    @impl true
    def init(children), do: {:ok, children}

    @impl true
    def handle_call(:which_children, _from, children), do: {:reply, children, children}
  end

  describe "status/0" do
    test "reports ready when the storage tree is serving" do
      assert Health.status() == :ok
    end

    test "reports unavailable when a storage child stops answering" do
      sqlite = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite)

      :ok = :sys.suspend(sqlite)
      on_exit(fn -> if Process.alive?(sqlite), do: :sys.resume(sqlite) end)

      assert {:error, _reason} = Health.status()

      :ok = :sys.resume(sqlite)

      assert Health.status() == :ok
    end

    test "reports unavailable when the tree is up but a child is not running" do
      sup = Process.whereis(EbbServer.Storage.Supervisor)
      assert is_pid(sup)

      # `which_children/1` only reports `:undefined` for a child that is
      # mid-restart, so that answer is stubbed rather than raced for. The real
      # tree keeps serving — only its own report is swapped out.
      Process.unregister(EbbServer.Storage.Supervisor)

      {:ok, stub} =
        ChildReport.start_link([{:rocksdb, :undefined, :worker, [EbbServer.Storage.RocksDB]}])

      on_exit(fn ->
        if Process.alive?(stub), do: GenServer.stop(stub)
        if Process.alive?(sup), do: Process.register(sup, EbbServer.Storage.Supervisor)
      end)

      assert {:error, {:storage, {:child_not_running, :rocksdb}}} = Health.status()
    end
  end
end
