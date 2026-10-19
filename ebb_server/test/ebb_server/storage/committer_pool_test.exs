defmodule EbbServer.Storage.CommitterPoolTest do
  @moduledoc """
  The Committer pool boundary (ebbjs/ebbjs#550).

  The pool owns Worker lifecycle only: it assigns one `ref`-keyed job to a
  Committer, forwards that job's result, and turns a worker death into a
  contained failure for the writer that owns the range. Ordering and the
  abandon/apply policy stay in the Writer.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.CommitterPool

  test "assigns a job to a worker and forwards its result" do
    test_pid = self()
    ref = make_ref()

    pool =
      start_pool(
        commit_fn: fn ops, opts ->
          send(test_pid, {:committed, self(), ops, opts})
          :ok
        end,
        rocks_name: :pool_test_rocks
      )

    :ok = CommitterPool.commit(pool, ref, [], 4, 4)

    assert_receive {:committer_assigned, ^ref, worker}, 2_000
    assert is_pid(worker)
    assert_receive {:committed, ^worker, [], [name: :pool_test_rocks]}, 2_000
    assert_receive {:committer_result, ^ref, :ok}, 2_000
  end

  test "queues a job while every worker is busy and dispatches it on release" do
    test_pid = self()
    first_ref = make_ref()
    second_ref = make_ref()

    pool =
      start_pool(
        commit_fn: fn _ops, _opts ->
          send(test_pid, {:job_started, self()})

          receive do
            :release -> :ok
          end
        end,
        size: 1
      )

    :ok = CommitterPool.commit(pool, first_ref, [], 1, 1)
    assert_receive {:committer_assigned, ^first_ref, worker}, 2_000
    assert_receive {:job_started, ^worker}, 2_000

    :ok = CommitterPool.commit(pool, second_ref, [], 2, 2)
    refute_receive {:committer_assigned, ^second_ref, _worker}, 100

    send(worker, :release)
    assert_receive {:committer_result, ^first_ref, :ok}, 2_000

    assert_receive {:committer_assigned, ^second_ref, ^worker}, 2_000
    assert_receive {:job_started, ^worker}, 2_000
    send(worker, :release)
    assert_receive {:committer_result, ^second_ref, :ok}, 2_000
  end

  test "turns a worker death into a crashed result and replaces the worker" do
    first_ref = make_ref()
    second_ref = make_ref()

    test_pid = self()

    pool =
      start_pool(
        commit_fn: fn _ops, _opts ->
          send(test_pid, {:job_started, self()})

          receive do
            :release -> :ok
          end
        end,
        size: 1
      )

    :ok = CommitterPool.commit(pool, first_ref, [], 1, 1)
    assert_receive {:committer_assigned, ^first_ref, first_worker}, 2_000
    assert_receive {:job_started, ^first_worker}, 2_000

    Process.exit(first_worker, :kill)

    assert_receive {:committer_result, ^first_ref, {:crashed, :killed}}, 2_000

    :ok = CommitterPool.commit(pool, second_ref, [], 2, 2)
    assert_receive {:committer_assigned, ^second_ref, second_worker}, 2_000
    assert second_worker != first_worker
    assert_receive {:job_started, ^second_worker}, 2_000
    send(second_worker, :release)
    assert_receive {:committer_result, ^second_ref, :ok}, 2_000
  end

  test "stops when its owner goes away" do
    owner = spawn(fn -> receive do: (:stop -> :ok) end)

    {:ok, pool} =
      CommitterPool.start_link(
        owner: owner,
        size: 1,
        rocks_name: :unused,
        commit_fn: fn _ops, _opts -> :ok end
      )

    ref = Process.monitor(pool)
    send(owner, :stop)

    assert_receive {:DOWN, ^ref, :process, ^pool, :normal}, 2_000
  end

  defp start_pool(opts) do
    {:ok, pool} =
      CommitterPool.start_link(
        Keyword.merge(
          [owner: self(), size: 2, rocks_name: :unused, commit_fn: fn _ops, _opts -> :ok end],
          opts
        )
      )

    on_exit(fn -> safe_stop(pool) end)

    pool
  end

  defp safe_stop(pid) do
    if Process.alive?(pid), do: GenServer.stop(pid, :normal, 5_000)
    :ok
  catch
    :exit, _ -> :ok
  end
end
