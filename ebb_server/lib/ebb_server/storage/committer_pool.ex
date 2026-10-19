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
          worker: pid() | nil
        }

  @type t :: %__MODULE__{
          owner: pid(),
          owner_ref: reference(),
          supervisor: pid(),
          rocks_name: GenServer.name(),
          commit_fn: fun(),
          ablate: [atom()],
          workers: %{pid() => reference() | nil},
          idle: [pid()],
          jobs: %{reference() => job()},
          waiting: [reference()]
        }

  defstruct [
    :owner,
    :owner_ref,
    :supervisor,
    :rocks_name,
    :commit_fn,
    :ablate,
    workers: %{},
    idle: [],
    jobs: %{},
    waiting: []
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Queues a prepared range for an available Committer.

  Asynchronous: the Writer must remain responsive while the commit runs.
  The pool answers with `{:committer_assigned, ref, worker}` followed by
  exactly one `{:committer_result, ref, result}` (a crash is reported as
  `{:crashed, reason}`).
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

    state = %__MODULE__{
      owner: owner,
      owner_ref: Process.monitor(owner),
      supervisor: supervisor,
      rocks_name: Keyword.fetch!(opts, :rocks_name),
      commit_fn: Keyword.fetch!(opts, :commit_fn),
      ablate: Keyword.get(opts, :ablate, [])
    }

    {:ok, Enum.reduce(1..size, state, fn _, state -> start_worker(state) end)}
  end

  @impl true
  def handle_cast({:commit, ref, prepared, gsn_start, gsn_end}, state) do
    job = %{prepared: prepared, gsn_start: gsn_start, gsn_end: gsn_end, worker: nil}
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
        Logger.warning("CommitterPool received a result for unknown ref #{inspect(ref)}")
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    {:stop, :normal, state}
  end

  def handle_info({:DOWN, _monitor_ref, :process, pid, reason}, state) do
    case Map.fetch(state.workers, pid) do
      :error ->
        Logger.warning("CommitterPool received DOWN for unknown worker #{inspect(pid)}")
        {:noreply, state}

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
        jobs: Map.put(state.jobs, ref, %{job | worker: worker})
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
