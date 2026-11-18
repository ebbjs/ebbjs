defmodule EbbServer.Storage.PreparePool do
  @moduledoc """
  Supervised pool of `EbbServer.Storage.Preparer` workers owned by one
  Writer.

  Payload build and ETF encode are CPU-bound and need no live cache or
  GSN, so they run here instead of on the Writer's call path. The pool
  only assigns one `ref`-keyed job at a time to a worker and forwards the
  result:

  - `{:prepare_result, ref, {:ok, payload_etfs}}` when every payload in
    the job encoded;
  - `{:prepare_result, ref, {:error, reason}}` when the worker raised,
    threw, or exited inside the job;
  - `{:prepare_result, ref, {:error, {:crashed, reason}}}` when the worker
    itself died.

  Ordering, dedup, claim order, timeouts, and the queue bound stay in the
  Writer. The pool is deliberately not the owner of arrival order: it
  forwards whatever finishes, and the Writer only hands the contiguous
  prepared prefix to the sequencer.

  The pool is linked to the Writer and monitors it, so a Writer restart
  takes the old pool and its workers with it. Shutdown is best-effort: a
  worker already encoding a payload can finish after its owner exits, and
  the result is simply sent to a dead process.

  The scheduling skeleton it shares with `EbbServer.Storage.CommitterPool`
  lives in `EbbServer.Storage.WorkerPool`.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{Preparer, WorkerPool}

  @type job :: %{actions: [Preparer.action()], worker: pid() | nil}

  @typedoc "This pool's state; the scheduling fields are typed in `WorkerPool.t/0`."
  @type t :: %__MODULE__{}

  defstruct WorkerPool.shared_fields() ++ [prepare_fn: nil]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @spec prepare(GenServer.server(), reference(), [Preparer.action()]) :: :ok
  def prepare(pool, ref, actions) do
    GenServer.cast(pool, {:prepare, ref, actions})
  end

  @doc """
  Abandons a job the Writer has already timed out.

  A waiting job is dropped. A running job's worker is killed and replaced:
  a prepare that outlives the Writer's timeout cannot be trusted to return
  its slot. The Writer has already replied to the caller, so no result is
  sent for an abandoned job.
  """
  @spec abandon(GenServer.server(), reference()) :: :ok
  def abandon(pool, ref) do
    GenServer.cast(pool, {:abandon, ref})
  end

  @impl true
  def init(opts) do
    size = WorkerPool.size!(opts, 2, "PreparePool")
    prepare_fn = Keyword.get(opts, :prepare_fn)

    unless is_nil(prepare_fn) or is_function(prepare_fn, 1) do
      raise ArgumentError,
            "PreparePool prepare_fn must be a one-argument function, got: #{inspect(prepare_fn)}"
    end

    state =
      %__MODULE__{ablate: Keyword.get(opts, :ablate, []), prepare_fn: prepare_fn}
      |> WorkerPool.start(Keyword.fetch!(opts, :owner))
      |> WorkerPool.fill(size, &start_worker/1)

    {:ok, state}
  end

  @impl true
  def handle_cast({:prepare, ref, actions}, state) do
    job = %{actions: actions, worker: nil}

    {:noreply, WorkerPool.submit(state, ref, job, spec())}
  end

  def handle_cast({:abandon, ref}, state) do
    case Map.pop(state.jobs, ref) do
      {nil, _jobs} ->
        {:noreply, state}

      {%{worker: nil}, jobs} ->
        {:noreply, %{state | jobs: jobs, waiting: List.delete(state.waiting, ref)}}

      {%{worker: worker}, jobs} ->
        # Leave the worker in `workers` so its DOWN frees the slot and starts
        # a replacement instead of being treated as unknown.
        Process.exit(worker, :kill)
        {:noreply, %{state | jobs: jobs, waiting: List.delete(state.waiting, ref)}}
    end
  end

  @impl true
  def handle_info({:prepare_result, ref, result}, state) do
    case WorkerPool.finish_job(state, ref, result, spec()) do
      {:ok, state} ->
        {:noreply, state}

      :unknown ->
        Logger.warning("PreparePool received a result for unknown ref #{inspect(ref)}")
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    WorkerPool.owner_down(state)
  end

  def handle_info({:DOWN, _monitor_ref, :process, pid, reason}, state) do
    case Map.fetch(state.workers, pid) do
      :error ->
        Logger.warning("PreparePool received DOWN for unknown worker #{inspect(pid)}")
        {:noreply, state}

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

  defp start_worker(state) do
    case WorkerPool.start_worker(state, spec()) do
      {:ok, state} ->
        state

      {:error, reason} ->
        raise RuntimeError, "PreparePool could not start a Preparer: #{inspect(reason)}"
    end
  end

  defp dispatch(state), do: WorkerPool.dispatch(state, spec())

  defp spec do
    %{
      worker: Preparer,
      worker_opts: &worker_opts/1,
      assign: &assign/4,
      result_tag: :prepare_result,
      crash_result: fn reason -> {:error, {:crashed, reason}} end
    }
  end

  defp worker_opts(state) do
    [owner: self(), ablate: state.ablate, prepare_fn: state.prepare_fn]
  end

  defp assign(_state, worker, ref, job) do
    Preparer.prepare(worker, ref, job.actions)

    %{job | worker: worker}
  end
end
