defmodule EbbServer.Storage.CommitterPool do
  @moduledoc """
  Supervised pool of `EbbServer.Storage.Committer` workers owned by one
  Writer.

  ## Why a pool

  The V0 Writer started one linked Committer. A Committer death therefore
  killed the Writer, and the Writer's `init/1` reconcile healed the one
  claimed range. That cannot contain a failure once more than one range is
  in flight: a bad range must become a resolved hole without taking the
  healthy ranges (or the sequencer) down with it.

  The pool gives every dispatch a worker and a `ref`-keyed job. The Writer
  keeps all ordering and failure policy; the pool only:

  - starts and maintains the configured number of workers;
  - assigns one job at a time to an idle worker;
  - forwards `{:committer_result, ref, result}` unchanged;
  - turns a worker `:DOWN` into
    `{:committer_result, ref, {:crashed, reason}}` for the job that worker
    owned, and starts a replacement;
  - stops when its owner (the Writer) goes away.

  ## Commit watchdog

  `commit_fn` is `RocksDB.write_batch/2`, a NIF. A process inside a NIF
  cannot be killed until the NIF returns, so killing a worker does not
  free its slot: waiting for the `:DOWN` would hang in exactly the failure
  the watchdog exists for. Instead the watchdog times out the *job*:

  - every dispatched job records `started_at`;
  - a sweeper fails any job older than `:commit_timeout_ms` (default
    2 000 ms, application env `:writer_commit_timeout_ms`) by sending its
    owner `{:committer_result, ref, {:crashed, :commit_timeout}}`;
  - the timed-out job is deleted, its worker is retired from
    `workers`/`idle`, and replaced, so the pool's capacity is restored
    without waiting for the stuck NIF.

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

  ## Lifecycle

  A job is `{ref, prepared, gsn_start, gsn_end}`. The pool sends
  `{:committer_assigned, ref, worker}` before dispatching the job, which
  lets the Writer record the owner on its `CommitPipeline.Batch`. Results
  and crashes are reported by `ref`, never by worker pid, so a replacement
  worker cannot inherit or resolve another range's failure.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.Committer

  @type job :: %{
          prepared: [EbbServer.Storage.PreparedAction.t()],
          gsn_start: non_neg_integer(),
          gsn_end: non_neg_integer(),
          worker: pid() | nil,
          started_at: integer() | nil
        }

  @type t :: %__MODULE__{
          owner: pid(),
          owner_ref: reference(),
          supervisor: pid(),
          rocks_name: GenServer.name(),
          commit_fn: fun(),
          ablate: [atom()],
          commit_timeout_ms: integer(),
          sweep_interval_ms: pos_integer(),
          workers: %{pid() => reference() | nil},
          idle: [pid()],
          jobs: %{reference() => job()},
          retired: %{reference() => pid()},
          waiting: [reference()]
        }

  defstruct [
    :owner,
    :owner_ref,
    :supervisor,
    :rocks_name,
    :commit_fn,
    :ablate,
    :commit_timeout_ms,
    :sweep_interval_ms,
    workers: %{},
    idle: [],
    jobs: %{},
    retired: %{},
    waiting: []
  ]

  @default_commit_timeout_ms 2_000
  @default_sweep_interval_ms 250

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Queues a prepared range for an available Committer.

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
    owner = Keyword.fetch!(opts, :owner)
    size = Keyword.get(opts, :size, 1)

    unless is_integer(size) and size > 0 do
      raise ArgumentError, "CommitterPool size must be a positive integer, got: #{inspect(size)}"
    end

    {:ok, supervisor} = DynamicSupervisor.start_link(strategy: :one_for_one)

    commit_timeout_ms = Keyword.get(opts, :commit_timeout_ms, @default_commit_timeout_ms)

    sweep_interval_ms = Keyword.get(opts, :sweep_interval_ms, @default_sweep_interval_ms)

    validate_watchdog_opts!(commit_timeout_ms, sweep_interval_ms)

    state = %__MODULE__{
      owner: owner,
      owner_ref: Process.monitor(owner),
      supervisor: supervisor,
      rocks_name: Keyword.fetch!(opts, :rocks_name),
      commit_fn: Keyword.fetch!(opts, :commit_fn),
      ablate: Keyword.get(opts, :ablate, []),
      commit_timeout_ms: commit_timeout_ms,
      sweep_interval_ms: sweep_interval_ms
    }

    {:ok, Enum.reduce(1..size, state, fn _, state -> start_worker(state) end) |> schedule_sweep()}
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

    state = %{state | jobs: Map.put(state.jobs, ref, job), waiting: state.waiting ++ [ref]}

    {:noreply, dispatch(state)}
  end

  @impl true
  def handle_info({:committer_result, ref, result}, state) do
    case Map.fetch(state.jobs, ref) do
      {:ok, %{worker: worker}} when is_pid(worker) ->
        send(state.owner, {:committer_result, ref, result})

        state = %{
          state
          | jobs: Map.delete(state.jobs, ref),
            workers: Map.put(state.workers, worker, nil),
            idle: [worker | state.idle]
        }

        {:noreply, dispatch(state)}

      _ ->
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
    {:stop, :normal, state}
  end

  def handle_info({:DOWN, _monitor_ref, :process, pid, reason}, state) do
    case Map.fetch(state.workers, pid) do
      :error ->
        retired = Map.reject(state.retired, fn {_ref, worker} -> worker == pid end)
        Logger.debug("CommitterPool received DOWN for unknown worker #{inspect(pid)}")
        {:noreply, %{state | retired: retired}}

      {:ok, job_ref} ->
        state = %{
          state
          | workers: Map.delete(state.workers, pid),
            idle: List.delete(state.idle, pid)
        }

        state = fail_job(state, job_ref, reason)
        {:noreply, state |> start_worker() |> dispatch()}
    end
  end

  @impl true
  def terminate(_reason, state) do
    if Process.alive?(state.supervisor) do
      DynamicSupervisor.stop(state.supervisor, :normal, 5_000)
    end

    :ok
  catch
    :exit, _ -> :ok
  end

  defp fail_job(state, nil, _reason), do: state

  defp fail_job(state, ref, reason) do
    case Map.pop(state.jobs, ref) do
      {nil, _jobs} ->
        state

      {_job, jobs} ->
        send(state.owner, {:committer_result, ref, {:crashed, reason}})
        %{state | jobs: jobs}
    end
  end

  defp sweep(state) do
    now = now_ms()

    state.jobs
    |> Enum.filter(fn {_ref, job} -> expired?(job, now, state.commit_timeout_ms) end)
    |> Enum.reduce(state, fn {ref, job}, state ->
      state = retire_worker(state, job.worker)
      state = retire_job(state, ref, job.worker)
      fail_job(state, ref, :commit_timeout)
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

  defp dispatch(%{waiting: [], jobs: _jobs} = state), do: state

  defp dispatch(%{idle: []} = state), do: state

  defp dispatch(state) do
    [worker | idle] = state.idle
    [ref | waiting] = state.waiting
    job = Map.fetch!(state.jobs, ref)

    send(state.owner, {:committer_assigned, ref, worker})

    GenServer.cast(worker, {:commit, ref, job.prepared, job.gsn_start, job.gsn_end})

    state = %{
      state
      | idle: idle,
        waiting: waiting,
        workers: Map.put(state.workers, worker, ref),
        jobs: Map.put(state.jobs, ref, %{job | worker: worker, started_at: now_ms()})
    }

    dispatch(state)
  end

  defp start_worker(state) do
    spec = %{
      id: {Committer, make_ref()},
      start:
        {Committer, :start_link,
         [
           [
             owner: self(),
             rocks_name: state.rocks_name,
             commit_fn: state.commit_fn,
             ablate: state.ablate
           ]
         ]},
      restart: :temporary,
      type: :worker
    }

    case DynamicSupervisor.start_child(state.supervisor, spec) do
      {:ok, pid} ->
        Process.monitor(pid)
        %{state | workers: Map.put(state.workers, pid, nil), idle: [pid | state.idle]}

      {:error, reason} ->
        raise RuntimeError,
              "CommitterPool could not start a Committer: #{inspect(reason)}"
    end
  end
end
