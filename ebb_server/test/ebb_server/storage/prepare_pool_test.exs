defmodule EbbServer.Storage.PreparePoolTest.HungChild do
  @moduledoc false

  # A plain trapping process, not a GenServer: it never handles the
  # supervisor's shutdown signal, so the supervisor cannot finish
  # terminating within the pool's 5 s stop timeout. A GenServer would end
  # on its parent's exit signal before that timeout could be reached.
  def child_spec(_opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [[]]},
      restart: :temporary,
      shutdown: :infinity,
      type: :worker
    }
  end

  def start_link(_opts) do
    pid =
      spawn_link(fn ->
        Process.flag(:trap_exit, true)
        Process.sleep(:infinity)
      end)

    {:ok, pid}
  end
end

defmodule EbbServer.Storage.PreparePoolTest do
  @moduledoc """
  The Prepare pool boundary (ebbjs/ebbjs#553).

  The pool assigns one `ref`-keyed job to a prepare worker, forwards the
  result, and contains a worker death as a failed job for the Writer that
  owns the call. Arrival order and the queue bound stay in the Writer.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias EbbServer.Storage.PreparePool
  alias EbbServer.Storage.PreparePoolTest.HungChild

  test "assigns a job to a worker and forwards its result" do
    test_pid = self()
    ref = make_ref()

    pool =
      start_pool(
        prepare_fn: fn action ->
          send(test_pid, {:prepared, action.id, self()})
          <<action.id::binary>>
        end
      )

    action = %{id: "act_one", actor_id: "a_test", hlc: 1, updates: []}

    :ok = PreparePool.prepare(pool, ref, [action])

    assert_receive {:prepared, "act_one", worker}, 2_000
    assert is_pid(worker)
    assert_receive {:prepare_result, ^ref, {:ok, [<<"act_one">>]}}, 2_000
  end

  test "turns a worker death into a crashed job and replaces the worker" do
    test_pid = self()
    first_ref = make_ref()
    second_ref = make_ref()

    pool =
      start_pool(
        size: 1,
        prepare_fn: fn action ->
          send(test_pid, {:started, action.id, self()})

          receive do
            :release -> <<action.id::binary>>
          end
        end
      )

    first = %{id: "act_first", actor_id: "a_test", hlc: 1, updates: []}
    second = %{id: "act_second", actor_id: "a_test", hlc: 2, updates: []}

    :ok = PreparePool.prepare(pool, first_ref, [first])
    assert_receive {:started, "act_first", first_worker}, 2_000

    Process.exit(first_worker, :kill)

    assert_receive {:prepare_result, ^first_ref, {:error, {:crashed, :killed}}}, 2_000

    :ok = PreparePool.prepare(pool, second_ref, [second])
    assert_receive {:started, "act_second", second_worker}, 2_000
    assert second_worker != first_worker

    send(second_worker, :release)
    assert_receive {:prepare_result, ^second_ref, {:ok, [<<"act_second">>]}}, 2_000
  end

  test "abandoning a running job retires its worker and serves the next job" do
    test_pid = self()
    abandoned_ref = make_ref()
    next_ref = make_ref()

    pool =
      start_pool(
        size: 1,
        prepare_fn: fn action ->
          send(test_pid, {:started, action.id, self()})

          if action.id == "act_hang" do
            receive do
              :never -> :ok
            end
          end

          <<action.id::binary>>
        end
      )

    hang = %{id: "act_hang", actor_id: "a_test", hlc: 1, updates: []}
    next = %{id: "act_next", actor_id: "a_test", hlc: 2, updates: []}

    :ok = PreparePool.prepare(pool, abandoned_ref, [hang])
    assert_receive {:started, "act_hang", first_worker}, 2_000

    :ok = PreparePool.abandon(pool, abandoned_ref)
    refute_receive {:prepare_result, ^abandoned_ref, _}, 100

    :ok = PreparePool.prepare(pool, next_ref, [next])
    assert_receive {:started, "act_next", second_worker}, 2_000
    assert second_worker != first_worker
    assert_receive {:prepare_result, ^next_ref, {:ok, [<<"act_next">>]}}, 2_000
  end

  test "a raised prepare is reported as a failed job and keeps the worker" do
    pool = start_pool(prepare_fn: fn _action -> raise "boom" end)
    ref = make_ref()
    action = %{id: "act_raise", actor_id: "a_test", hlc: 1, updates: []}

    :ok = PreparePool.prepare(pool, ref, [action])

    assert_receive {:prepare_result, ^ref, {:error, {:raised, %RuntimeError{}, _stacktrace}}},
                   2_000

    ref = make_ref()
    :ok = PreparePool.prepare(pool, ref, [action])

    assert_receive {:prepare_result, ^ref, {:error, {:raised, %RuntimeError{}, _stacktrace}}},
                   2_000
  end

  test "queues a job while every worker is busy and dispatches it on release" do
    test_pid = self()
    first_ref = make_ref()
    second_ref = make_ref()

    pool =
      start_pool(
        size: 1,
        prepare_fn: fn action ->
          send(test_pid, {:started, action.id, self()})

          receive do
            :release -> <<action.id::binary>>
          end
        end
      )

    first = %{id: "act_first", actor_id: "a_test", hlc: 1, updates: []}
    second = %{id: "act_second", actor_id: "a_test", hlc: 2, updates: []}

    :ok = PreparePool.prepare(pool, first_ref, [first])
    assert_receive {:started, "act_first", worker}, 2_000

    :ok = PreparePool.prepare(pool, second_ref, [second])
    refute_receive {:started, "act_second", _worker}, 100

    send(worker, :release)
    assert_receive {:prepare_result, ^first_ref, {:ok, _}}, 2_000
    assert_receive {:started, "act_second", ^worker}, 2_000

    send(worker, :release)
    assert_receive {:prepare_result, ^second_ref, {:ok, _}}, 2_000
  end

  test "stops when its owner goes away" do
    owner = spawn(fn -> receive do: (:stop -> :ok) end)

    {:ok, pool} = PreparePool.start_link(owner: owner, size: 1)

    ref = Process.monitor(pool)
    send(owner, :stop)

    assert_receive {:DOWN, ^ref, :process, ^pool, :normal}, 2_000
  end

  describe "pool defence (#641 slice 10)" do
    test "init rejects a size that is not a positive integer" do
      Process.flag(:trap_exit, true)

      for size <- [0, -1, "2", nil] do
        assert {:error, {%ArgumentError{message: message}, _stacktrace}} =
                 PreparePool.start_link(owner: self(), size: size)

        assert message =~ "size must be a positive integer"
      end
    end

    test "init rejects a prepare_fn that is not a one-argument function" do
      Process.flag(:trap_exit, true)

      assert {:error, {%ArgumentError{message: message}, _stacktrace}} =
               PreparePool.start_link(owner: self(), prepare_fn: :not_a_function)

      assert message =~ "prepare_fn must be a one-argument function"
    end

    test "abandoning a ref the pool never queued keeps the pool serving" do
      unknown_ref = make_ref()
      pool = start_pool(size: 1, prepare_fn: & &1.id)

      :ok = PreparePool.abandon(pool, unknown_ref)

      ref = make_ref()
      :ok = PreparePool.prepare(pool, ref, [action("act_after_unknown_abandon")])

      assert_receive {:prepare_result, ^ref, {:ok, ["act_after_unknown_abandon"]}}, 2_000
      refute_received {:prepare_result, ^unknown_ref, _}
    end

    test "abandoning a queued job drops it without retiring the busy worker" do
      test_pid = self()
      running_ref = make_ref()
      queued_ref = make_ref()
      next_ref = make_ref()

      pool =
        start_pool(
          size: 1,
          prepare_fn: fn action ->
            send(test_pid, {:started, action.id, self()})

            receive do
              :release -> action.id
            end
          end
        )

      :ok = PreparePool.prepare(pool, running_ref, [action("act_running")])
      assert_receive {:started, "act_running", worker}, 2_000

      :ok = PreparePool.prepare(pool, queued_ref, [action("act_queued")])
      refute_receive {:started, "act_queued", _worker}, 100

      :ok = PreparePool.abandon(pool, queued_ref)

      send(worker, :release)
      assert_receive {:prepare_result, ^running_ref, {:ok, ["act_running"]}}, 2_000
      refute_received {:started, "act_queued", _worker}
      refute_received {:prepare_result, ^queued_ref, _}

      # The queued job never held the worker, so the next job reuses it.
      :ok = PreparePool.prepare(pool, next_ref, [action("act_next")])
      assert_receive {:started, "act_next", ^worker}, 2_000

      send(worker, :release)
      assert_receive {:prepare_result, ^next_ref, {:ok, ["act_next"]}}, 2_000
    end

    test "a result for an unknown ref is logged and ignored" do
      unknown_ref = make_ref()
      pool = start_pool(size: 1, prepare_fn: & &1.id)

      log =
        capture_log(fn ->
          send(pool, {:prepare_result, unknown_ref, {:ok, ["stray"]}})

          ref = make_ref()
          :ok = PreparePool.prepare(pool, ref, [action("act_after_stray_result")])
          assert_receive {:prepare_result, ^ref, {:ok, ["act_after_stray_result"]}}, 2_000
        end)

      assert log =~ "received a result for unknown ref #{inspect(unknown_ref)}"
      refute_received {:prepare_result, ^unknown_ref, _}
    end

    test "a DOWN for an unknown worker is logged and ignored" do
      ghost = spawn(fn -> Process.sleep(:infinity) end)
      pool = start_pool(size: 1, prepare_fn: & &1.id)

      log =
        capture_log(fn ->
          send(pool, {:DOWN, make_ref(), :process, ghost, :killed})

          ref = make_ref()
          :ok = PreparePool.prepare(pool, ref, [action("act_after_stray_down")])
          assert_receive {:prepare_result, ^ref, {:ok, ["act_after_stray_down"]}}, 2_000
        end)

      assert log =~ "received DOWN for unknown worker #{inspect(ghost)}"

      Process.exit(ghost, :kill)
    end

    test "an idle worker death is replaced without failing a job" do
      test_pid = self()

      pool =
        start_pool(
          size: 1,
          prepare_fn: fn action ->
            send(test_pid, {:prepared, self()})
            action.id
          end
        )

      ref = make_ref()
      :ok = PreparePool.prepare(pool, ref, [action("act_idle")])

      assert_receive {:prepared, worker}, 2_000
      assert_receive {:prepare_result, ^ref, {:ok, ["act_idle"]}}, 2_000

      # `:kill` is asynchronous, so the DOWN is also injected: the pool is
      # guaranteed to have handled an idle-worker DOWN before the next job,
      # instead of dispatching that job to the dying worker.
      Process.exit(worker, :kill)
      send(pool, {:DOWN, make_ref(), :process, worker, :killed})
      # A synchronous call behind the injected DOWN: the pool has handled
      # it before the next job can be dispatched.
      :sys.get_state(pool)

      next_ref = make_ref()
      :ok = PreparePool.prepare(pool, next_ref, [action("act_after_idle_death")])

      assert_receive {:prepared, replacement}, 2_000
      assert replacement != worker
      assert_receive {:prepare_result, ^next_ref, {:ok, ["act_after_idle_death"]}}, 2_000

      # A death with no job behind it fails nothing; only the killed
      # worker's slot is re-drawn.
      refute_received {:prepare_result, _, {:error, {:crashed, _}}}
    end

    @tag timeout: 60_000
    test "terminate tolerates a supervisor that never finishes stopping" do
      pool = start_pool(size: 1, prepare_fn: & &1.id)
      %{supervisor: supervisor} = :sys.get_state(pool)

      {:ok, hung} = DynamicSupervisor.start_child(supervisor, {HungChild, []})

      down = Process.monitor(pool)
      assert :ok = GenServer.stop(pool, :normal, 20_000)
      assert_receive {:DOWN, ^down, :process, ^pool, :normal}, 2_000

      # Releasing the hung child lets the stranded supervisor finish.
      Process.exit(hung, :kill)
      supervisor_down = Process.monitor(supervisor)
      assert_receive {:DOWN, ^supervisor_down, :process, ^supervisor, _reason}, 5_000
    end

    test "a supervisor that refuses a replacement worker crashes the pool" do
      Process.flag(:trap_exit, true)
      test_pid = self()

      pool =
        start_pool(
          size: 1,
          prepare_fn: fn action ->
            send(test_pid, {:prepared, self()})
            action.id
          end
        )

      ref = make_ref()
      :ok = PreparePool.prepare(pool, ref, [action("act_probe")])
      assert_receive {:prepared, worker}, 2_000
      assert_receive {:prepare_result, ^ref, {:ok, ["act_probe"]}}, 2_000

      # The pool's supervisor handle is the seam: a real DynamicSupervisor
      # that genuinely refuses the child, as a shutting-down one would.
      {:ok, refusing} = DynamicSupervisor.start_link(strategy: :one_for_one, max_children: 0)
      :sys.replace_state(pool, fn state -> %{state | supervisor: refusing} end)

      Process.exit(worker, :kill)

      assert_receive {:EXIT, ^pool, {%RuntimeError{message: message}, _stacktrace}}, 5_000
      assert message =~ "could not start a Preparer"
      assert message =~ ":max_children"
    end
  end

  defp action(id) do
    %{id: id, actor_id: "a_test", hlc: 1, updates: []}
  end

  defp start_pool(opts) do
    opts = Keyword.put_new(opts, :owner, self())
    {:ok, pool} = PreparePool.start_link(opts)
    pool
  end
end
