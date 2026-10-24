defmodule EbbServer.Health do
  @moduledoc """
  Readiness probe behind `GET /healthz`.

  ## Why this exists

  `EbbServer.Application.start/2` returns before the storage layer has
  finished opening RocksDB, opening SQLite, and rebuilding the in-memory
  caches. A process that exists is therefore not the same as a node that
  can serve traffic, and container orchestrators need a signal that
  distinguishes the two.

  Every check answers a question the server cannot serve a request
  without:

    - The storage supervisor and every child it started are alive. A
      crashed child under `:rest_for_one` means the tree is mid-rebuild,
      and a partially rebuilt tree looks healthy at the process level.
    - RocksDB answers a point read on its default column family. Every
      write goes through this database handle, so a missing or closed
      handle is a hard write-path failure.
    - SQLite answers a trivial statement. Entity materialization and the
      boot rebuild read and write through it; a hung or dead GenServer
      blocks every cache read and every write that dirties an entity.
    - `WatermarkTracker.committed_watermark/0` returns a frontier. Every
      handshake, catch-up, and SSE stream reads it, so a tracker whose
      `:atomics` reference is gone cannot serve the sync protocol.

  ## What this module is not

  This is a readiness check, not a diagnostic. Failures collapse to a
  single `{:error, term()}` and `EbbServer.Sync.Router` maps every one of
  them to the same `503` body, so the public probe reveals nothing about
  internals. It does not check disk space, clock skew, or auth-service
  reachability; those fail at their own call sites.
  """

  alias EbbServer.Storage.{RocksDB, SQLite, WatermarkTracker}

  alias EbbServer.Storage.Supervisor, as: StorageSupervisor

  @doc """
  Reports whether this node can serve sync traffic.

  Returns `:ok` only when the storage supervisor, all of its children,
  and cheap reads against RocksDB, SQLite, and the watermark tracker
  succeed. Any failure returns `{:error, term()}`; callers must not leak
  the term to clients.
  """
  @spec status() :: :ok | {:error, term()}
  def status do
    with :ok <- check(:storage, &storage_running/0),
         :ok <- check(:rocksdb, &rocksdb/0),
         :ok <- check(:sqlite, &SQLite.health/0) do
      check(:watermark, &watermark/0)
    end
  end

  # Children come from the supervisor, not a list kept in sync here, so a
  # new storage child is covered the moment it is added.
  defp storage_running do
    case Process.whereis(StorageSupervisor) do
      nil ->
        {:error, :not_started}

      _pid ->
        StorageSupervisor
        |> Supervisor.which_children()
        |> Enum.reject(&running_child?/1)
        |> case do
          [] -> :ok
          [{id, _pid, _type, _modules} | _rest] -> {:error, {:child_not_running, id}}
        end
    end
  end

  defp running_child?({_id, pid, _type, _modules}), do: is_pid(pid) and Process.alive?(pid)

  defp rocksdb do
    case RocksDB.get(RocksDB.cf_default(), "") do
      {:ok, _value} -> :ok
      :not_found -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp watermark do
    case WatermarkTracker.committed_watermark() do
      watermark when is_integer(watermark) and watermark >= 0 -> :ok
      other -> {:error, {:invalid_watermark, other}}
    end
  end

  # Failures are labelled so an operator can read the cause from the log
  # while the router still collapses every one of them to a bare 503.
  defp check(label, fun) do
    case safe(fun) do
      {:ok, :ok} -> :ok
      {:ok, {:error, reason}} -> {:error, {label, reason}}
      {:ok, other} -> {:error, {label, {:unexpected, other}}}
      {:error, reason} -> {:error, {label, reason}}
    end
  end

  # A raise or an exit — a dead handle, or a bounded call to a suspended
  # process — is a not-ready answer, not a crash of the request. The NIF
  # reads themselves have no timeout, so a wedged RocksDB blocks this
  # request and the container healthcheck times out instead.
  defp safe(fun) do
    {:ok, fun.()}
  rescue
    exception -> {:error, {:exception, Exception.message(exception)}}
  catch
    :exit, reason -> {:error, {:exit, reason}}
    kind, reason -> {:error, {kind, reason}}
  end
end
