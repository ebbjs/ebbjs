defmodule EbbServer.Storage.CommitterPool do
  @moduledoc """
  Supervised pool of `EbbServer.Storage.Committer` workers owned by one
  Writer.

  ## Why a pool

  The pool gives every dispatch a worker and a `ref`-keyed job. The Writer
  keeps all ordering and failure policy.

  ## Commit watchdog

  `commit_fn` is `RocksDB.write_batch/2`, a NIF. A process inside a NIF
  cannot be killed until the NIF returns, so killing a worker does not
  free its slot: waiting for the `:DOWN` would hang in exactly the failure
  the watchdog exists for. Instead the watchdog times out the *job*.

  A retired worker is not killed synchronously: it may still be inside the
  NIF, where a kill signal is not delivered until the call returns, and the
  late durable write is allowed to land (it can only fill the hole the
  abandon created). If the worker does return, its late result is ignored
  and the pool stops it then. If it does not, a second timer one threshold
  later sends the kill and drops the bookkeeping; a process inside a NIF
  still cannot die until the call returns, but it no longer holds a slot or
  a retirement entry. Those are the only reasons a result or `:DOWN`
  arrives unrecognized, so they log at debug. A non-positive threshold
  disables the sweeper, and `:sweep_interval_ms` (default 250 ms) sets its
  period.

  A worker crash is contained: the other workers keep running and the
  Writer abandons only the failed range. The pool itself is deliberately
  not kept alive across a Writer restart: it is linked to the Writer and
  monitors it, so a Writer death sends shutdown to the pool. That shutdown
  is best-effort — a worker already inside `write_batch` can finish after
  its owner exits — so the replacement Writer treats every unresolved
  claim as orphaned. GSNs are never reused, so a late write can only fill a
  range already resolved as a hole, never a newly claimed range.

  Results and crashes are reported by `ref`, never by worker pid, so a
  replacement worker cannot inherit or resolve another range's failure.

  The scheduling skeleton it shares with `EbbServer.Storage.PreparePool`
  lives in `EbbServer.Storage.WorkerPool`; retirement is this pool's own.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{Committer, WorkerPool}

  @type job :: %{
          prepared: [EbbServer.Storage.PreparedAction.t()],
          gsn_start: non_neg_integer(),
          gsn_end: non_neg_integer(),
          worker: pid() | nil,
          started_at: integer() | nil
        }

  @typedoc "This pool's state; the scheduling fields are typed in `WorkerPool.t/0`."
  @type t :: %__MODULE__{}

  defstruct WorkerPool.shared_fields() ++
              [
                rocks_name: nil,
                commit_fn: nil,
                commit_timeout_ms: nil,
                sweep_interval_ms: nil,
                retired: %{}
              ]

  @default_commit_timeout_ms 2_000
  @default_sweep_interval_ms 250
  @default_size 1

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Asynchronous: the Writer must remain responsive while the commit runs.
  The pool answers with `{:committer_assigned, ref, worker}` followed by
  exactly one `{:committer_result, ref, result}` (a crash is reported as
  `{:crashed, reason}`, and a commit that outlives the watchdog threshold
  as `{:crashed, :commit_timeout}`).
  """
  @spec commit(
          GenServer.server(),
          reference(),
          [EbbServer.Storage.PreparedAction.t()],
          integer(),
          integer()
        ) ::
          :ok
  def commit(pool, ref, prepared, gsn_start, gsn_end) do
    GenServer.cast(pool, {:commit, ref, prepared, gsn_start, gsn_end})
  end

  @impl true
  def init(opts) do
    size = WorkerPool.size!(opts, @default_size, "CommitterPool")

    commit_timeout_ms = Keyword.get(opts, :commit_timeout_ms, @default_commit_timeout_ms)

    sweep_interval_ms = Keyword.get(opts, :sweep_interval_ms, @default_sweep_interval_ms)

    validate_watchdog_opts!(commit_timeout_ms, sweep_interval_ms)

    state =
      %__MODULE__{
        rocks_name: Keyword.fetch!(opts, :rocks_name),
        commit_fn: Keyword.fetch!(opts, :commit_fn),
        ablate: Keyword.get(opts, :ablate, []),
        commit_timeout_ms: commit_timeout_ms,
        sweep_interval_ms: sweep_interval_ms
      }
      |> WorkerPool.start(Keyword.fetch!(opts, :owner))
      |> WorkerPool.fill(size, &start_worker/1)
      |> schedule_sweep()

    {:ok, state}
  end

  @impl true
  def handle_cast({:commit, ref, prepared, gsn_start, gsn_end}, state) do
    job = %{
      prepared: prepared,
      gsn_start: gsn_start,
      gsn_end: gsn_end,
      worker: nil,
      started_at: nil
    }

    {:noreply, WorkerPool.submit(state, ref, job, spec())}
  end

  @impl true
  def handle_info({:committer_result, ref, result}, state) do
    case WorkerPool.finish_job(state, ref, result, spec()) do
      {:ok, state} ->
        {:noreply, state}

      :unknown ->
        handle_stale_result(state, ref)
    end
  end

  def handle_info(:sweep, state) do
    {:noreply, state |> sweep() |> schedule_sweep() |> dispatch()}
  end

  def handle_info({:retire_timeout, ref}, state) do
    case Map.pop(state.retired, ref) do
      {nil, _retired} ->
        {:noreply, state}

      {worker, retired} ->
        Process.exit(worker, :kill)

        Logger.warning(
          "Committer worker did not return after the commit timeout; kill signal sent"
        )

        {:noreply, %{state | retired: retired}}
    end
  end

  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    WorkerPool.owner_down(state)
  end

  def handle_info({:DOWN, _monitor_ref, :process, pid, reason}, state) do
    case Map.fetch(state.workers, pid) do
      :error ->
        # A retired worker has no slot, so only its retirement entry is left
        # to drop.
        retired = Map.reject(state.retired, fn {_ref, worker} -> worker == pid end)
        Logger.debug("CommitterPool received DOWN for unknown worker #{inspect(pid)}")
        {:noreply, %{state | retired: retired}}

      {:ok, job_ref} ->
        state =
          state
          |> WorkerPool.forget_worker(pid)
          |> WorkerPool.fail_job(job_ref, reason, spec())
          |> start_worker()

        {:noreply, dispatch(state)}
    end
  end

  @impl true
  def terminate(_reason, state) do
    WorkerPool.shutdown(state)
  end

  defp handle_stale_result(state, ref) do
    case Map.pop(state.retired, ref) do
      {nil, _retired} ->
        Logger.debug("CommitterPool received a result for unknown ref #{inspect(ref)}")
        {:noreply, state}

      {worker, retired} ->
        # The late write landed and its worker is healthy enough to report;
        # it has no pool slot left, so stop it instead of leaving an idle
        # orphan under the supervisor.
        Process.exit(worker, :shutdown)
        Logger.debug("CommitterPool ignoring a late result from a retired worker")
        {:noreply, %{state | retired: retired}}
    end
  end

  defp sweep(state) do
    now = now_ms()

    state.jobs
    |> Enum.filter(fn {_ref, job} -> expired?(job, now, state.commit_timeout_ms) end)
    |> Enum.reduce(state, fn {ref, job}, state ->
      state = retire_worker(state, job.worker)
      state = retire_job(state, ref, job.worker)
      WorkerPool.fail_job(state, ref, :commit_timeout, spec())
    end)
  end

  defp expired?(_job, _now, timeout_ms) when timeout_ms <= 0, do: false
  defp expired?(%{started_at: nil}, _now, _timeout_ms), do: false

  defp expired?(%{started_at: started_at}, now, timeout_ms),
    do: now - started_at > timeout_ms

  # A worker whose commit outlived the threshold cannot be trusted with a
  # new job: it may still be inside the NIF. Removing it from the pool and
  # starting a replacement restores capacity; the worker itself is stopped
  # when (and if) its late result arrives.
  defp retire_worker(state, worker) when is_pid(worker) do
    %{
      state
      | workers: Map.delete(state.workers, worker),
        idle: List.delete(state.idle, worker)
    }
    |> start_worker()
  end

  defp retire_worker(state, _worker), do: state

  defp retire_job(state, _ref, nil), do: state

  defp retire_job(state, ref, worker) do
    Process.send_after(self(), {:retire_timeout, ref}, state.commit_timeout_ms)
    %{state | retired: Map.put(state.retired, ref, worker)}
  end

  defp schedule_sweep(%{commit_timeout_ms: timeout_ms} = state) when timeout_ms > 0 do
    Process.send_after(self(), :sweep, state.sweep_interval_ms)
    state
  end

  defp schedule_sweep(state), do: state

  defp now_ms, do: System.monotonic_time(:millisecond)

  defp validate_watchdog_opts!(commit_timeout_ms, sweep_interval_ms) do
    unless is_integer(commit_timeout_ms) do
      raise ArgumentError,
            "CommitterPool commit_timeout_ms must be an integer, got: " <>
              inspect(commit_timeout_ms)
    end

    unless is_integer(sweep_interval_ms) and sweep_interval_ms > 0 do
      raise ArgumentError,
            "CommitterPool sweep_interval_ms must be a positive integer, got: " <>
              inspect(sweep_interval_ms)
    end
  end

  defp start_worker(state) do
    case WorkerPool.start_worker(state, spec()) do
      {:ok, state} ->
        state

      {:error, reason} ->
        raise RuntimeError, "CommitterPool could not start a Committer: #{inspect(reason)}"
    end
  end

  defp dispatch(state), do: WorkerPool.dispatch(state, spec())

  defp spec do
    %{
      worker: Committer,
      worker_opts: &worker_opts/1,
      assign: &assign/4,
      result_tag: :committer_result,
      crash_result: fn reason -> {:crashed, reason} end
    }
  end

  defp worker_opts(state) do
    [
      owner: self(),
      rocks_name: state.rocks_name,
      commit_fn: state.commit_fn,
      ablate: state.ablate
    ]
  end

  defp assign(state, worker, ref, job) do
    send(state.owner, {:committer_assigned, ref, worker})

    GenServer.cast(worker, {:commit, ref, job.prepared, job.gsn_start, job.gsn_end})

    %{job | worker: worker, started_at: now_ms()}
  end
end
