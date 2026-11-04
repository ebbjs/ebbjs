defmodule EbbServer.Functions.Worker.PoolTest.Stub do
  @moduledoc false
  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(opts) do
    parent = self()
    owner = Keyword.fetch!(opts, :owner)
    notify = Keyword.get(opts, :notify)

    pid =
      spawn(fn ->
        send(parent, :stub_ready)
        loop(owner)
      end)

    if notify, do: send(notify, {:stub_started, pid})

    {:ok, %{pid: pid, notify: notify}}
  end

  @impl true
  def send_frame(%{pid: pid}, _frame) do
    send(pid, :frame)
    :ok
  end

  @impl true
  def close(%{pid: pid}) do
    Process.exit(pid, :kill)
    :ok
  end

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(%{pid: pid}), do: Process.alive?(pid)

  @impl true
  def monitor(%{pid: pid}), do: Process.monitor(pid)

  @impl true
  def set_owner(%{pid: pid}, owner) do
    send(pid, {:set_owner, owner})
    :ok
  end

  @impl true
  def release(_handle), do: :ok

  @impl true
  def cleanup(%{pid: pid, notify: nil}) do
    _ = pid
    :ok
  end

  def cleanup(%{pid: pid, notify: notify}) do
    send(notify, {:stub_cleanup, pid})
    :ok
  end

  defp loop(owner) do
    receive do
      {:set_owner, new_owner} -> loop(new_owner)
      {:frame, _frame} -> loop(owner)
      _other -> loop(owner)
    end
  end
end

defmodule EbbServer.Functions.Worker.PoolTest.NoOwnerStub do
  @moduledoc false
  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:ok, %{}}

  @impl true
  def send_frame(_handle, _frame), do: :ok

  @impl true
  def close(_handle), do: :ok

  @impl true
  def alive?(_handle), do: true

  @impl true
  def monitor(_handle), do: make_ref()

  @impl true
  def os_pid(_handle), do: nil
end

defmodule EbbServer.Functions.Worker.PoolTest do
  use ExUnit.Case, async: false

  alias EbbServer.Functions.Stats
  alias EbbServer.Functions.Worker
  alias EbbServer.Functions.Worker.Pool
  alias EbbServer.Functions.Worker.PoolTest.Stub

  setup do
    start_supervised!({Stats, []})
    :ok
  end

  defp start_pool(opts) do
    start_supervised!(
      {Pool,
       Keyword.merge(
         [
           name: nil,
           size: 2,
           queue_limit: 0,
           queue_timeout_ms: 100,
           transport: Stub,
           transport_opts: []
         ],
         opts
       )}
    )
  end

  defp eventually(fun, attempts \\ 100) do
    case fun.() do
      true -> :ok
      false when attempts > 0 -> Process.sleep(10) && eventually(fun, attempts - 1)
      false -> flunk("condition never became true")
    end
  end

  defp idle(pool), do: eventually(fn -> Pool.snapshot(pool).idle == 2 end)

  defp worker_pid(lease), do: Worker.os_pid(lease.worker) || lease.worker.handle.pid

  test "warms `size` workers and leases two of them" do
    pool = start_pool([])
    idle(pool)

    {:ok, first} = Pool.checkout(pool)
    {:ok, second} = Pool.checkout(pool)

    assert worker_pid(first) != worker_pid(second)
    assert %{busy: 2, idle: 0} = Pool.snapshot(pool)
    assert %{"busy" => 2, "idle" => 0} = Stats.snapshot()["pool"] |> Map.take(["busy", "idle"])

    assert {:error, :saturated} = Pool.checkout(pool)
  end

  test "a checkin returns the same worker to the next caller" do
    pool = start_pool([])
    idle(pool)

    {:ok, first} = Pool.checkout(pool)
    :ok = Pool.checkin(pool, first)

    {:ok, second} = Pool.checkout(pool)
    assert worker_pid(second) == worker_pid(first)
  end

  test "a queued caller gets the next released worker" do
    pool = start_pool(size: 1, queue_limit: 1, queue_timeout_ms: 1_000)
    eventually(fn -> Pool.snapshot(pool).idle == 1 end)

    {:ok, lease} = Pool.checkout(pool)

    task = Task.async(fn -> Pool.checkout(pool) end)
    eventually(fn -> Pool.snapshot(pool).queued == 1 end)

    assert {:error, :saturated} = Pool.checkout(pool)

    :ok = Pool.checkin(pool, lease)

    assert {:ok, handed} = Task.await(task)
    assert worker_pid(handed) == worker_pid(lease)
  end

  test "a queue wait past the timeout is a refusal, not a hang" do
    pool = start_pool(size: 1, queue_limit: 1, queue_timeout_ms: 50)
    eventually(fn -> Pool.snapshot(pool).idle == 1 end)

    {:ok, _lease} = Pool.checkout(pool)

    assert {:error, :saturated} = Pool.checkout(pool)
    assert %{queued: 0} = Pool.snapshot(pool)
  end

  test "discarding a worker kills it and replaces its slot" do
    pool = start_pool([])
    idle(pool)

    {:ok, lease} = Pool.checkout(pool)
    original = worker_pid(lease)

    :ok = Pool.discard(pool, lease)

    eventually(fn -> Pool.snapshot(pool).kills == 1 end)
    eventually(fn -> Pool.snapshot(pool).idle == 2 end)

    refute Process.alive?(original)
  end

  test "a worker that dies is replaced and its leftovers are cleaned up" do
    pool = start_pool(transport_opts: [notify: self()])
    idle(pool)

    {:ok, lease} = Pool.checkout(pool)
    pid = worker_pid(lease)
    Process.exit(pid, :kill)

    assert_receive {:stub_cleanup, ^pid}, 1_000
    eventually(fn -> Pool.snapshot(pool).idle == 2 end)
  end

  test "refuses a transport that cannot change owner" do
    assert_raise ArgumentError, ~r/set_owner\/2/, fn ->
      Pool.init(size: 1, transport: NoOwnerStub, transport_opts: [])
    end
  end

  test "a caller that dies while holding a worker does not leak it" do
    pool = start_pool([])
    idle(pool)

    holder = spawn(fn -> Pool.checkout(pool) && Process.sleep(:infinity) end)
    eventually(fn -> Pool.snapshot(pool).busy == 1 end)

    Process.exit(holder, :kill)

    eventually(fn -> Pool.snapshot(pool).busy == 0 end)
    eventually(fn -> Pool.snapshot(pool).idle == 2 end)
  end
end
