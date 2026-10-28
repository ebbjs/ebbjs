defmodule EbbServer.HealthTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Health
  alias EbbServer.Storage.{RocksDB, SQLite, WatermarkTracker}
  alias EbbServer.Storage.Supervisor, as: StorageSupervisor

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

  defmodule UnreadyReport do
    @moduledoc false
    # Stands in for `Storage.SQLite` when a test needs the readiness probe to
    # see a health reply it does not recognise.
    use GenServer

    def start_link(reply) do
      GenServer.start_link(__MODULE__, reply, name: EbbServer.Storage.SQLite)
    end

    @impl true
    def init(reply), do: {:ok, reply}

    @impl true
    def handle_call(:health, _from, reply), do: {:reply, reply, reply}
  end

  # The probe reads the handles the running database publishes, so making a
  # read fail while the storage tree stays up means repointing those handles at
  # a database the test controls.
  defp probe_at(db_ref, cf_ref) do
    keys = [{:ebb_rocksdb_db, RocksDB}, {:ebb_cf_default, RocksDB}]
    originals = Enum.map(keys, &{&1, :persistent_term.get(&1)})

    :persistent_term.put({:ebb_rocksdb_db, RocksDB}, db_ref)
    :persistent_term.put({:ebb_cf_default, RocksDB}, cf_ref)

    on_exit(fn ->
      Enum.each(originals, fn {key, value} -> :persistent_term.put(key, value) end)
    end)
  end

  # A database outside the storage tree: the probe's handle swap needs a db the
  # test may close or corrupt without disturbing the tree under it.
  defp open_scratch(dir) do
    File.mkdir_p!(dir)

    {:ok, db_ref, [cf_ref]} =
      :rocksdb.open(String.to_charlist(dir), [create_if_missing: true], [{~c"default", []}])

    {db_ref, cf_ref}
  end

  # The first data block of an SST starts at offset 0, so zeroing its head
  # leaves the footer and properties block that `open/3` reads intact.
  defp corrupt_first_data_block(dir) do
    [sst] = Path.wildcard(Path.join(dir, "*.sst"))
    {:ok, fd} = :file.open(String.to_charlist(sst), [:read, :write, :binary])
    :ok = :file.pwrite(fd, 0, :binary.copy(<<0>>, 512))
    :ok = :file.close(fd)
  end

  describe "status/0" do
    test "reports ready when the storage tree is serving" do
      assert Health.status() == :ok
    end

    test "reports ready when the database answers the point read with a value" do
      :ok = RocksDB.write_batch([{:put, RocksDB.cf_default(), "", "marker"}])

      assert Health.status() == :ok
    end

    test "reports unavailable when a storage child stops answering" do
      sqlite = Process.whereis(SQLite)
      assert is_pid(sqlite)

      :ok = :sys.suspend(sqlite)
      on_exit(fn -> if Process.alive?(sqlite), do: :sys.resume(sqlite) end)

      assert {:error, _reason} = Health.status()

      :ok = :sys.resume(sqlite)

      assert Health.status() == :ok
    end

    test "reports unavailable when the storage supervisor is not started" do
      sup = Process.whereis(StorageSupervisor)
      assert is_pid(sup)

      Process.unregister(StorageSupervisor)
      on_exit(fn -> if Process.alive?(sup), do: Process.register(sup, StorageSupervisor) end)

      assert {:error, {:storage, :not_started}} = Health.status()
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

    test "reports unavailable when RocksDB answers the point read with an error", %{
      tmp_dir: tmp_dir
    } do
      dir = Path.join(tmp_dir, "corrupt_read")

      {db_ref, cf_ref} = open_scratch(dir)
      :ok = :rocksdb.put(db_ref, cf_ref, "", :rand.bytes(4096), [])
      :ok = :rocksdb.flush(db_ref, [])
      :rocksdb.close(db_ref)

      corrupt_first_data_block(dir)

      {db_ref, cf_ref} = open_scratch(dir)
      probe_at(db_ref, cf_ref)

      assert {:error, {:rocksdb, {:corruption, _reason}}} = Health.status()
    end

    test "reports unavailable when the RocksDB handle has been closed", %{tmp_dir: tmp_dir} do
      {db_ref, cf_ref} = open_scratch(Path.join(tmp_dir, "released_handle"))
      :rocksdb.close(db_ref)

      probe_at(db_ref, cf_ref)

      assert {:error, {:rocksdb, {:exception, _message}}} = Health.status()
    end

    test "reports unavailable when a child answers the health call unexpectedly" do
      sqlite = Process.whereis(SQLite)
      assert is_pid(sqlite)

      Process.unregister(SQLite)

      {:ok, stub} = UnreadyReport.start_link(:not_a_health_reply)

      on_exit(fn ->
        if Process.alive?(stub), do: GenServer.stop(stub)
        if Process.alive?(sqlite), do: Process.register(sqlite, SQLite)
      end)

      assert {:error, {:sqlite, {:unexpected, :not_a_health_reply}}} = Health.status()
    end

    test "reports unavailable when the committed watermark is invalid" do
      gsn_ref = :persistent_term.get({WatermarkTracker, :gsn_ref})
      invalid = :atomics.new(1, signed: true)
      :atomics.put(invalid, 1, -1)

      :persistent_term.put({WatermarkTracker, :gsn_ref}, invalid)
      on_exit(fn -> :persistent_term.put({WatermarkTracker, :gsn_ref}, gsn_ref) end)

      assert {:error, {:watermark, {:invalid_watermark, -1}}} = Health.status()
    end
  end
end
