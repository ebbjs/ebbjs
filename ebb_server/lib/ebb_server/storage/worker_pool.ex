defmodule EbbServer.Storage.WorkerPool do
  @moduledoc """
  The scheduling skeleton the Writer's two worker pools share.

  `EbbServer.Storage.PreparePool` and `EbbServer.Storage.CommitterPool`
  each keep one supervised worker per slot, one `ref`-keyed job per
  worker, and a FIFO of refs waiting for a slot. Each frees a slot when a
  result arrives, turns a worker death into a failed job and a replacement
  worker, and stops with its owner. That part is written once here.

  The pools keep what is genuinely theirs: the job payload, the message
  that hands a job to a worker, the result tag, and whatever retirement
  only one pool does. State stays the pool's own struct, flat — these
  functions read and write only the keys both pools share, so a pool's
  extra fields and messages are untouched.
  """

  @doc """
  The fields every pool carries, for the pools to build their structs on.
  """
  @spec shared_fields() :: [{atom(), term()}]
  def shared_fields do
    [
      owner: nil,
      owner_ref: nil,
      supervisor: nil,
      workers: %{},
      idle: [],
      jobs: %{},
      waiting: [],
      ablate: []
    ]
  end

  @typedoc "The slice of pool state this module reads and writes."
  @type t :: %{
          required(:owner) => pid(),
          required(:owner_ref) => reference(),
          required(:supervisor) => pid(),
          required(:workers) => %{pid() => reference() | nil},
          required(:idle) => [pid()],
          required(:jobs) => %{reference() => map()},
          required(:waiting) => [reference()],
          required(:ablate) => [atom()]
        }

  @typedoc """
  What a pool must tell the skeleton about its own jobs.

  `worker_opts` is evaluated inside the pool process, once per worker
  start, so a pool can close over its configuration and its own pid.
  `assign` takes the job the scheduler just popped and answers with the
  job to record against the worker: that is where a pool hands the work
  over and stamps anything it only knows once the job is in flight.
  `crash_result` is the result body a pool reports for a job whose worker
  died, because the two pools answer their owner in different shapes.
  """
  @type spec :: %{
          worker: module(),
          worker_opts: (t() -> keyword()),
          assign: (t(), pid(), reference(), map() -> map()),
          result_tag: atom(),
          crash_result: (term() -> term())
        }

  @doc """
  Reads the pool size, rejecting anything that is not a positive integer.

  `default` and `pool` belong to the caller: the two pools start at
  different sizes and name themselves in the error.
  """
  @spec size!(keyword(), pos_integer(), String.t()) :: pos_integer()
  def size!(opts, default, pool) do
    size = Keyword.get(opts, :size, default)

    unless is_integer(size) and size > 0 do
      raise ArgumentError, "#{pool} size must be a positive integer, got: #{inspect(size)}"
    end

    size
  end

  @doc """
  Monitors the owner and starts the supervisor that holds the workers.

  The pool is linked to its owner, so it never outlives the Writer that
  started it.
  """
  @spec start(t(), pid()) :: t()
  def start(state, owner) do
    {:ok, supervisor} = DynamicSupervisor.start_link(strategy: :one_for_one)

    %{state | owner: owner, owner_ref: Process.monitor(owner), supervisor: supervisor}
  end

  @doc "Starts `count` workers up front, so the pool is whole before its first job."
  @spec fill(t(), pos_integer(), (t() -> t())) :: t()
  def fill(state, count, start_worker) do
    Enum.reduce(1..count, state, fn _, state -> start_worker.(state) end)
  end

  @doc "Queues a job and dispatches as much of the queue as the pool can."
  @spec submit(t(), reference(), map(), spec()) :: t()
  def submit(state, ref, job, spec) do
    state = %{state | jobs: Map.put(state.jobs, ref, job), waiting: state.waiting ++ [ref]}

    dispatch(state, spec)
  end

  @doc """
  Hands queued jobs to idle workers until one of the two runs out.

  Only the handover is the pool's: the slot bookkeeping around it is not.
  """
  @spec dispatch(t(), spec()) :: t()
  def dispatch(%{waiting: []} = state, _spec), do: state

  def dispatch(%{idle: []} = state, _spec), do: state

  def dispatch(state, spec) do
    [worker | idle] = state.idle
    [ref | waiting] = state.waiting
    job = state.jobs |> Map.fetch!(ref) |> then(&spec.assign.(state, worker, ref, &1))

    state = %{
      state
      | idle: idle,
        waiting: waiting,
        workers: Map.put(state.workers, worker, ref),
        jobs: Map.put(state.jobs, ref, job)
    }

    dispatch(state, spec)
  end

  @doc """
  Starts one worker under the pool's supervisor and gives it an idle slot.

  The caller owns the failure: a supervisor that refuses the child leaves
  the pool unable to serve its queue, and only the pool knows what to call
  the worker it could not start.
  """
  @spec start_worker(t(), spec()) :: {:ok, t()} | {:error, term()}
  def start_worker(state, spec) do
    child = %{
      id: {spec.worker, make_ref()},
      start: {spec.worker, :start_link, [spec.worker_opts.(state)]},
      restart: :temporary,
      type: :worker
    }

    case DynamicSupervisor.start_child(state.supervisor, child) do
      {:ok, pid} ->
        Process.monitor(pid)
        {:ok, %{state | workers: Map.put(state.workers, pid, nil), idle: [pid | state.idle]}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Records a live job's result, forwards it to the owner, and frees its
  worker's slot for the next queued ref.

  Answers `:unknown` for a ref the pool no longer tracks; what a stale
  result means is the pool's call.
  """
  @spec finish_job(t(), reference(), term(), spec()) :: {:ok, t()} | :unknown
  def finish_job(state, ref, result, spec) do
    case Map.fetch(state.jobs, ref) do
      {:ok, %{worker: worker}} when is_pid(worker) ->
        send(state.owner, {spec.result_tag, ref, result})

        state = %{
          state
          | jobs: Map.delete(state.jobs, ref),
            workers: Map.put(state.workers, worker, nil),
            idle: [worker | state.idle]
        }

        {:ok, dispatch(state, spec)}

      _ ->
        :unknown
    end
  end

  @doc "Drops a dead worker's slot, whether it held a job or was idle."
  @spec forget_worker(t(), pid()) :: t()
  def forget_worker(state, pid) do
    %{state | workers: Map.delete(state.workers, pid), idle: List.delete(state.idle, pid)}
  end

  @doc """
  Fails the job a dead worker was holding, so its caller is answered
  instead of waiting on a worker that will never report.
  """
  @spec fail_job(t(), reference() | nil, term(), spec()) :: t()
  def fail_job(state, nil, _reason, _spec), do: state

  def fail_job(state, ref, reason, spec) do
    case Map.pop(state.jobs, ref) do
      {nil, _jobs} ->
        state

      {_job, jobs} ->
        send(state.owner, {spec.result_tag, ref, spec.crash_result.(reason)})
        %{state | jobs: jobs, waiting: List.delete(state.waiting, ref)}
    end
  end

  @doc "Answers the `:DOWN` of the pool's owner: the pool goes with it."
  @spec owner_down(t()) :: {:stop, :normal, t()}
  def owner_down(state), do: {:stop, :normal, state}

  @doc """
  Stops every worker.

  Best-effort and bounded: a worker that will not stop inside the timeout
  must not keep the pool's terminate from returning.
  """
  @spec shutdown(t()) :: :ok
  def shutdown(state) do
    if Process.alive?(state.supervisor) do
      DynamicSupervisor.stop(state.supervisor, :normal, 5_000)
    end

    :ok
  catch
    :exit, _ -> :ok
  end
end
