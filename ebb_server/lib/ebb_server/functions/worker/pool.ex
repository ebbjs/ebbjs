defmodule EbbServer.Functions.Worker.Pool do
  @moduledoc """
  A bounded pool of pre-warmed workers.

  The pool keeps `size` Bun processes connected and idle (default `min(4,
  schedulers_online)`), hands one to each invocation, and takes it back when
  the invocation answered. A checkout with no idle worker waits up to
  `queue_timeout_ms` behind at most `queue_limit` other callers (default 20);
  past the bound — or past the timeout — it answers `{:error, :saturated}` and
  the router turns that into a `503`, so a spike is a fast refusal instead of
  a spawn storm.

  ## A worker's life

  A slot is spawned by a task and reports its handle back; the slot is idle as
  soon as the runner connected, because the first frame it sends is `ready`
  and the invocation that receives it handles that frame itself. Checkout
  moves the worker's owner to the caller, so the invocation's monitor and its
  frame mailbox are exactly what they would be with a per-invocation worker.

  A successful invocation calls `release/1`, which returns the worker to the
  pool. Every failure path — deadline, crash, rejected host call — calls
  `close/1`, which kills the process group and replaces the slot: a worker
  that timed out must not serve another caller. The same replacement happens
  when a worker process goes down, when a caller dies while holding a worker,
  or when a spawn fails. Failed spawns back off exponentially up to five
  seconds, and the gauge counts them, so a broken runner cannot turn a burst
  of requests into a burst of processes.

  ## Gauges

  Every state change emits `[:ebb, :functions, :pool, :state]` with idle,
  busy, queued, workers, spawn_failures, kills, and respawning.
  `EbbServer.Functions.Stats` turns them into the numbers behind
  `ebb functions health`.
  """

  use GenServer

  require Logger

  alias EbbServer.Functions.Worker

  defmodule Lease do
    @moduledoc false
    @enforce_keys [:pool, :ref, :worker]
    defstruct [:pool, :ref, :worker]

    @type t :: %__MODULE__{pool: atom() | pid(), ref: reference(), worker: term()}
  end

  defmodule Transport do
    @moduledoc """
    The worker transport an invocation sees when the pool is in front of it.

    `start/1` is a checkout; `release/1` is a checkin; `close/1` kills the
    leased worker and replaces its slot. Everything else delegates to the
    leased worker's own transport.
    """

    @behaviour EbbServer.Functions.Worker

    alias EbbServer.Functions.Worker
    alias EbbServer.Functions.Worker.Pool
    alias EbbServer.Functions.Worker.Pool.Lease

    @impl true
    def start(opts) do
      pool = Keyword.fetch!(opts, :pool)

      try do
        case Pool.checkout(pool) do
          {:ok, lease} -> {:ok, lease}
          {:error, :saturated} -> {:error, :saturated}
          {:error, reason} -> {:error, reason}
        end
      catch
        :exit, _reason -> {:error, :unavailable}
      end
    end

    @impl true
    def send_frame(lease, frame), do: Worker.send_frame(lease.worker, frame)

    @impl true
    def close(lease) do
      Pool.discard(lease.pool, lease)
      :ok
    end

    @impl true
    def release(lease) do
      Pool.checkin(lease.pool, lease)
    end

    @impl true
    def os_pid(lease), do: Worker.os_pid(lease.worker)

    @impl true
    def alive?(lease), do: Worker.alive?(lease.worker)

    @impl true
    def monitor(lease), do: Worker.monitor(lease.worker)

    @impl true
    def set_owner(lease, owner), do: Worker.set_owner(lease.worker, owner)
  end

  @max_backoff_ms 5_000

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @doc """
  Leases one idle worker, or waits in the bounded queue.

  The pool owns the queue timeout, so this call does not time out on the
  caller's side; it answers `{:error, :saturated}` at the bound.
  """
  @spec checkout(atom() | pid()) :: {:ok, Lease.t()} | {:error, :saturated}
  def checkout(pool), do: GenServer.call(pool, :checkout, :infinity)

  @doc "Returns a healthy worker to the pool."
  @spec checkin(atom() | pid(), Lease.t()) :: :ok
  def checkin(pool, lease), do: GenServer.call(pool, {:checkin, lease}, 5_000)

  @doc "Kills the leased worker and replaces its slot."
  @spec discard(atom() | pid(), Lease.t()) :: :ok
  def discard(pool, lease), do: GenServer.cast(pool, {:discard, lease})

  @doc "The current gauges; for tests and `ebb functions health`."
  @spec snapshot(atom() | pid()) :: map()
  def snapshot(pool), do: GenServer.call(pool, :snapshot)

  @impl true
  def init(opts) do
    state = %{
      size: Keyword.fetch!(opts, :size),
      queue_limit: Keyword.get(opts, :queue_limit, 20),
      queue_timeout_ms: Keyword.get(opts, :queue_timeout_ms, 5_000),
      transport: Keyword.fetch!(opts, :transport),
      transport_opts: Keyword.get(opts, :transport_opts, []),
      rows: %{},
      by_pid: %{},
      idle: [],
      waiting: :queue.new(),
      pending: MapSet.new(),
      spawn_failures: 0,
      kills: 0
    }

    state = Enum.reduce(1..max(state.size, 0)//1, state, fn _slot, acc -> spawn_slot(acc) end)

    send(self(), :emit)
    {:ok, state}
  end

  @impl true
  def handle_call(:checkout, {caller, _tag} = from, state) do
    case pop_idle(state) do
      {:ok, row, state} ->
        Worker.set_owner(row.worker, caller)
        monitor = Process.monitor(caller)
        row = %{row | status: :busy, owner: caller, owner_mon: monitor}
        state = put_row(state, row)
        lease = %Lease{pool: self(), ref: row.ref, worker: row.worker}
        {:reply, {:ok, lease}, emit(state)}

      :none ->
        queue_checkout(from, caller, state)
    end
  end

  def handle_call({:checkin, %Lease{ref: ref}}, _from, state) do
    case Map.fetch(state.rows, ref) do
      {:ok, %{status: :busy} = row} ->
        if Worker.alive?(row.worker) do
          demonitor(row.owner_mon)
          Worker.set_owner(row.worker, self())

          state =
            state
            |> mark_idle(row)
            |> serve_waiters()
            |> emit()

          {:reply, :ok, state}
        else
          {:reply, :ok, state |> drop_row(ref, :close) |> emit()}
        end

      _missing ->
        {:reply, :ok, state}
    end
  end

  def handle_call(:snapshot, _from, state), do: {:reply, gauges(state), state}

  @impl true
  def handle_cast({:discard, %Lease{ref: ref}}, state) do
    {:noreply, state |> drop_row(ref, :close) |> emit()}
  end

  @impl true
  def handle_info({:spawn_result, ref, result}, state) do
    state = %{state | pending: MapSet.delete(state.pending, ref)}

    case result do
      {:ok, worker} ->
        monitor = Worker.monitor(worker) || Process.monitor(worker_pid(worker))
        pid = worker_pid(worker)

        row = %{
          ref: ref,
          worker: worker,
          pid: pid,
          monitor: monitor,
          status: :idle,
          owner: nil,
          owner_mon: nil
        }

        state =
          state
          |> Map.put(:spawn_failures, 0)
          |> mark_idle(row)
          |> serve_waiters()
          |> emit()

        {:noreply, state}

      {:error, reason} ->
        Logger.warning("functions worker pool could not start a worker: #{inspect(reason)}")
        {:noreply, state |> respawn_after_failure(ref) |> emit()}
    end
  end

  def handle_info({:spawn, ref}, state) do
    {:noreply, spawn_slot(state, ref)}
  end

  def handle_info({:checkout_timeout, wait_ref}, state) do
    case take_waiter(state.waiting, wait_ref) do
      {:ok, waiter, waiting} ->
        demonitor(waiter.monitor)
        GenServer.reply(waiter.from, {:error, :saturated})
        {:noreply, emit(%{state | waiting: waiting})}

      :error ->
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, monitor, :process, pid, _reason}, state) do
    cond do
      ref = Map.get(state.by_pid, pid) ->
        {:noreply, state |> drop_row(ref, :already_down) |> emit()}

      row = row_by_monitor(state, monitor) ->
        {:noreply, state |> drop_row(row.ref, :close) |> emit()}

      true ->
        case take_waiter_by_monitor(state.waiting, monitor) do
          {:ok, _waiter, waiting} -> {:noreply, %{state | waiting: waiting}}
          :error -> {:noreply, state}
        end
    end
  end

  def handle_info(:emit, state), do: {:noreply, emit(state)}
  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.rows, fn {_ref, row} -> Worker.close(row.worker) end)
    :ok
  end

  # --- checkout / checkin --------------------------------------------------

  defp queue_checkout(from, caller, state) do
    if :queue.len(state.waiting) < state.queue_limit do
      wait_ref = make_ref()
      monitor = Process.monitor(caller)

      timer =
        Process.send_after(self(), {:checkout_timeout, wait_ref}, state.queue_timeout_ms)

      waiter = %{ref: wait_ref, from: from, monitor: monitor, timer: timer}
      state = %{state | waiting: :queue.in(waiter, state.waiting)}
      {:noreply, emit(state)}
    else
      {:reply, {:error, :saturated}, emit(state)}
    end
  end

  defp serve_waiters(state) do
    with {:ok, row, state} <- pop_idle(state),
         {:ok, waiter, waiting} <- pop_waiter(state.waiting) do
      Process.cancel_timer(waiter.timer)
      demonitor(waiter.monitor)

      {pid, _tag} = waiter.from
      Worker.set_owner(row.worker, pid)
      monitor = Process.monitor(pid)
      row = %{row | status: :busy, owner: pid, owner_mon: monitor}

      GenServer.reply(waiter.from, {:ok, %Lease{pool: self(), ref: row.ref, worker: row.worker}})

      serve_waiters(%{put_row(state, row) | waiting: waiting})
    else
      _none -> state
    end
  end

  defp pop_idle(%{idle: []}), do: :none

  defp pop_idle(%{idle: [ref | rest]} = state) do
    case Map.fetch(state.rows, ref) do
      {:ok, %{status: :idle} = row} -> {:ok, row, %{state | idle: rest}}
      _missing -> pop_idle(%{state | idle: rest})
    end
  end

  defp pop_waiter(waiting) do
    case :queue.out(waiting) do
      {{:value, waiter}, rest} -> {:ok, waiter, rest}
      {:empty, _rest} -> :none
    end
  end

  defp take_waiter(waiting, wait_ref) do
    {matched, rest} =
      waiting
      |> :queue.to_list()
      |> Enum.split_with(&(&1.ref == wait_ref))

    case matched do
      [waiter] -> {:ok, waiter, :queue.from_list(rest)}
      [] -> :error
    end
  end

  defp take_waiter_by_monitor(waiting, monitor) do
    {matched, rest} =
      waiting
      |> :queue.to_list()
      |> Enum.split_with(&(&1.monitor == monitor))

    case matched do
      [waiter] -> {:ok, waiter, :queue.from_list(rest)}
      [] -> :error
    end
  end

  # --- workers -------------------------------------------------------------

  defp spawn_slot(state, ref \\ make_ref()) do
    if MapSet.member?(state.pending, ref) do
      state
    else
      pool = self()
      transport = state.transport
      opts = Keyword.put(state.transport_opts, :owner, pool)

      Task.start(fn -> send(pool, {:spawn_result, ref, Worker.start(transport, opts)}) end)

      %{state | pending: MapSet.put(state.pending, ref)}
    end
  end

  defp drop_row(state, ref, close) do
    case Map.fetch(state.rows, ref) do
      :error ->
        state

      {:ok, row} ->
        demonitor(row.owner_mon)
        demonitor(row.monitor)

        if close == :close and Worker.alive?(row.worker) do
          Task.start(fn -> Worker.close(row.worker) end)
        end

        kills = if row.status == :busy, do: state.kills + 1, else: state.kills

        %{
          state
          | rows: Map.delete(state.rows, ref),
            by_pid: Map.delete(state.by_pid, row.pid),
            idle: List.delete(state.idle, ref),
            kills: kills
        }
        |> respawn(ref)
    end
  end

  defp respawn(state, ref) do
    Process.send_after(self(), {:spawn, ref}, 0)
    state
  end

  defp respawn_after_failure(state, ref) do
    failures = state.spawn_failures + 1
    delay = min(100 * Integer.pow(2, min(failures, 6)), @max_backoff_ms)
    Logger.warning("functions worker pool retrying a spawn in #{delay}ms (#{failures} failures)")
    Process.send_after(self(), {:spawn, ref}, delay)
    %{state | spawn_failures: failures}
  end

  defp put_row(state, row) do
    %{
      state
      | rows: Map.put(state.rows, row.ref, row),
        by_pid: Map.put(state.by_pid, row.pid, row.ref)
    }
  end

  defp mark_idle(state, row) do
    row = %{row | status: :idle, owner: nil, owner_mon: nil}

    %{
      state
      | rows: Map.put(state.rows, row.ref, row),
        by_pid: Map.put(state.by_pid, row.pid, row.ref),
        idle: [row.ref | List.delete(state.idle, row.ref)]
    }
  end

  defp row_by_monitor(state, monitor) do
    Enum.find_value(state.rows, fn {_ref, row} ->
      cond do
        row.monitor == monitor -> row
        row.owner_mon == monitor -> row
        true -> nil
      end
    end)
  end

  defp worker_pid(%Worker{handle: handle}), do: worker_pid(handle)
  defp worker_pid(%{pid: pid}), do: pid
  defp worker_pid(_handle), do: nil

  defp demonitor(nil), do: :ok
  defp demonitor(ref), do: Process.demonitor(ref, [:flush])

  # --- gauges --------------------------------------------------------------

  defp emit(state) do
    :telemetry.execute([:ebb, :functions, :pool, :state], gauges(state), %{})
    state
  end

  defp gauges(state) do
    %{
      idle: length(state.idle),
      busy: Enum.count(state.rows, fn {_ref, row} -> row.status == :busy end),
      queued: :queue.len(state.waiting),
      workers: map_size(state.rows),
      spawn_failures: state.spawn_failures,
      kills: state.kills,
      respawning: MapSet.size(state.pending)
    }
  end
end
