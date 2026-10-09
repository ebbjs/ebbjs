defmodule EbbServer.Bench.Boot do
  @moduledoc """
  Boots an isolated EbbServer tree for one benchmark run.

  The `:ebb_server` application is deliberately *not* started: a custom Mix
  task does not start its own application, which lets this module boot the
  same children `EbbServer.Application` does but with a temp data dir, a
  fixed bench port, and an injected `:commit_fn` for `--durability async`.
  """

  alias EbbServer.Bench.Options
  alias EbbServer.Storage.RocksDB

  @supervisor EbbServer.Bench.Supervisor

  @type t :: %{supervisor: pid(), tmp_dir: String.t(), durability: Options.durability()}

  @doc """
  Starts dependency applications, then the isolated storage + sync tree.
  """
  @spec start(Options.t()) :: t()
  def start(%Options{} = config) do
    start_dependencies()
    Application.put_env(:ebb_server, :auth_mode, :bypass)

    tmp_dir = tmp_dir()
    File.mkdir_p!(tmp_dir)

    children = [
      {Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry},
      {EbbServer.Storage.Supervisor, data_dir: tmp_dir, writer_opts: writer_opts(config)},
      EbbServer.Sync.Supervisor,
      {Bandit, plug: EbbServer.Sync.Router, port: config.port}
    ]

    case Supervisor.start_link(children, strategy: :one_for_one, name: @supervisor) do
      {:ok, supervisor} ->
        %{supervisor: supervisor, tmp_dir: tmp_dir, durability: config.durability}

      {:error, reason} ->
        File.rm_rf(tmp_dir)
        raise "failed to boot the bench tree: #{inspect(reason)}"
    end
  end

  @doc """
  Stops the tree and removes its temp data directory.
  """
  @spec stop(t()) :: :ok
  def stop(%{supervisor: supervisor, tmp_dir: tmp_dir}) do
    stop_supervisor(supervisor)
    File.rm_rf(tmp_dir)
    :ok
  end

  @doc """
  A `commit_fn` that mirrors `RocksDB.write_batch/2` but commits with
  `sync: false`. Used only for the `--durability async` ceiling run.
  """
  @spec async_commit(list(), keyword()) :: :ok | {:error, term()}
  def async_commit(operations, opts) do
    name = Keyword.get(opts, :name, RocksDB)
    {:ok, batch} = :rocksdb.batch()

    try do
      Enum.each(operations, fn {:put, cf_ref, key, value} ->
        :ok = :rocksdb.batch_put(batch, cf_ref, key, value)
      end)

      :rocksdb.write_batch(RocksDB.db_ref(name), batch, sync: false)
    after
      :rocksdb.release_batch(batch)
    end
  end

  defp writer_opts(%{durability: :async}), do: [commit_fn: &__MODULE__.async_commit/2]
  defp writer_opts(_config), do: []

  defp start_dependencies do
    :ebb_server
    |> Application.spec(:applications)
    |> List.wrap()
    |> Enum.reject(&(&1 == :ebb_server))
    |> Enum.each(fn app ->
      {:ok, _started} = Application.ensure_all_started(app)
    end)
  end

  defp tmp_dir do
    Path.join(
      System.tmp_dir!(),
      "ebb_bench_#{System.os_time(:second)}_#{:erlang.unique_integer([:positive])}"
    )
  end

  defp stop_supervisor(supervisor) do
    if Process.alive?(supervisor), do: Supervisor.stop(supervisor, :normal, 30_000)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end
end
