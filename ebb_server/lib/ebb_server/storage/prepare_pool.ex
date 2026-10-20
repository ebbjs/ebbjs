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
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.Preparer

  @type job :: %{actions: [Preparer.action()], worker: pid() | nil}

  @type t :: %__MODULE__{
          owner: pid(),
          owner_ref: reference(),
          supervisor: pid(),
          ablate: [atom()],
          prepare_fn: (Preparer.action() -> binary()) | nil,
          workers: %{pid() => reference() | nil},
          idle: [pid()],
          jobs: %{reference() => job()},
          waiting: [reference()]
        }

  defstruct [
    :owner,
    :owner_ref,
    :supervisor,
    :ablate,
    :prepare_fn,
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
  Queues one call's Actions for payload build and encode.

  Asynchronous: the Writer keeps accepting calls while prepare runs. The
  owner receives `{:prepare_result, ref, result}` exactly once per job.
  """
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
    owner = Keyword.fetch!(opts, :owner)
    size = Keyword.get(opts, :size, 2)

    unless is_integer(size) and size > 0 do
      raise ArgumentError, "PreparePool size must be a positive integer, got: #{inspect(size)}"
    end

    prepare_fn = Keyword.get(opts, :prepare_fn)

    unless is_nil(prepare_fn) or is_function(prepare_fn, 1) do
      raise ArgumentError,
            "PreparePool prepare_fn must be a one-argument function, got: #{inspect(prepare_fn)}"
    end

    {:ok, supervisor} = DynamicSupervisor.start_link(strategy: :one_for_one)

    state = %__MODULE__{
      owner: owner,
      owner_ref: Process.monitor(owner),
      supervisor: supervisor,
      ablate: Keyword.get(opts, :ablate, []),
      prepare_fn: prepare_fn
    }

    {:ok, Enum.reduce(1..size, state, fn _, state -> start_worker(state) end)}
  end

  @impl true
  def handle_cast({:prepare, ref, actions}, state) do
    job = %{actions: actions, worker: nil}
    state = %{state | jobs: Map.put(state.jobs, ref, job), waiting: state.waiting ++ [ref]}

    {:noreply, dispatch(state)}
  end

  @impl true
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
    case Map.fetch(state.jobs, ref) do
      {:ok, %{worker: worker}} when is_pid(worker) ->
        send(state.owner, {:prepare_result, ref, result})

        state = %{
          state
          | jobs: Map.delete(state.jobs, ref),
            workers: Map.put(state.workers, worker, nil),
            idle: [worker | state.idle]
        }

        {:noreply, dispatch(state)}

      _ ->
        Logger.warning("PreparePool received a result for unknown ref #{inspect(ref)}")
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, owner_ref, :process, _owner, _reason}, %{owner_ref: owner_ref} = state) do
    {:stop, :normal, state}
  end

  def handle_info({:DOWN, _monitor_ref, :process, pid, reason}, state) do
    case Map.fetch(state.workers, pid) do
      :error ->
        Logger.warning("PreparePool received DOWN for unknown worker #{inspect(pid)}")
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
        send(state.owner, {:prepare_result, ref, {:error, {:crashed, reason}}})
        %{state | jobs: jobs, waiting: List.delete(state.waiting, ref)}
    end
  end

  defp dispatch(%{waiting: []} = state), do: state
  defp dispatch(%{idle: []} = state), do: state

  defp dispatch(state) do
    [worker | idle] = state.idle
    [ref | waiting] = state.waiting
    job = Map.fetch!(state.jobs, ref)

    Preparer.prepare(worker, ref, job.actions)

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
      id: {Preparer, make_ref()},
      start:
        {Preparer, :start_link,
         [
           [
             owner: self(),
             ablate: state.ablate,
             prepare_fn: state.prepare_fn
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
              "PreparePool could not start a Preparer: #{inspect(reason)}"
    end
  end
end
