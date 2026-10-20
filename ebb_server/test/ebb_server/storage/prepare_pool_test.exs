defmodule EbbServer.Storage.PreparePoolTest do
  @moduledoc """
  The Prepare pool boundary (ebbjs/ebbjs#553).

  The pool assigns one `ref`-keyed job to a prepare worker, forwards the
  result, and contains a worker death as a failed job for the Writer that
  owns the call. Arrival order and the queue bound stay in the Writer.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.PreparePool

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

  defp start_pool(opts) do
    opts = Keyword.put_new(opts, :owner, self())
    {:ok, pool} = PreparePool.start_link(opts)
    pool
  end
end
