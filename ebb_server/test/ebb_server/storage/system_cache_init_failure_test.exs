defmodule EbbServer.Storage.SystemCacheInitFailureTest do
  @moduledoc """
  `SystemCache.init/1` must fail the storage start rather than report health
  over a half-built cache (ebbjs/ebbjs#421, #641 slice 7).

  These tests drive `init/1` itself: a cache child that cannot start, an init
  that adopts a supplied GSN counter, and the stop path that gives up on a
  children supervisor that will not shut down. `init/1` starts its children
  under their global names, so the storage tree is stopped for the duration of
  each test and restarted afterwards for the rest of the suite.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias EbbServer.Storage.{DirtyTracker, SystemCache}
  alias EbbServer.Storage.Supervisor, as: StorageSupervisor
  alias EbbServer.TestHelpers

  @cache_children [
    DirtyTracker,
    EbbServer.Storage.GroupCache,
    EbbServer.Storage.EntityGroupCache,
    EbbServer.Storage.EntityTypeCache,
    EbbServer.Storage.RelationshipCache
  ]

  setup do
    # `start_link` links the caller to the cache supervisor, which exits when
    # a child fails to start; trap so the returned `{:error, reason}` can be
    # read instead of the test process dying.
    Process.flag(:trap_exit, true)

    # Free the global cache child names and the RocksDB lock held by the app's
    # storage tree. Other tests can leave the application supervisor stopped,
    # in which case the names are already free.
    parent = Process.whereis(EbbServer.Supervisor)

    if is_pid(parent) do
      case Elixir.Supervisor.terminate_child(parent, StorageSupervisor) do
        :ok -> :ok
        {:error, :not_found} -> :ok
      end
    end

    on_exit(fn ->
      stop_storage_supervisor()

      if is_pid(parent) and Process.alive?(parent) do
        case Elixir.Supervisor.restart_child(parent, StorageSupervisor) do
          {:ok, _pid} -> :ok
          {:error, _reason} -> :ok
        end
      end
    end)

    :ok
  end

  test "init stops when a cache child cannot start" do
    {:ok, holder} = Agent.start_link(fn -> :ok end, name: DirtyTracker)
    on_exit(fn -> TestHelpers.safe_stop(holder) end)

    name = unique_name("system_cache")

    assert {:error,
            {:shutdown, {:failed_to_start_child, DirtyTracker, {:already_started, ^holder}}}} =
             SystemCache.start_link(name: name)

    refute Process.whereis(name)
  end

  test "init adopts the supplied GSN counter and applies the initial GSN" do
    rocks = TestHelpers.start_rocks(%{test: "init_gsn_counter"})
    sqlite = TestHelpers.start_sqlite(rocks.dir)

    counter = :atomics.new(1, signed: false)
    name = unique_name("system_cache")
    gsn_counter_name = unique_name("gsn_counter")
    on_exit(fn -> :persistent_term.erase(gsn_counter_name) end)

    assert {:ok, pid} =
             SystemCache.start_link(
               name: name,
               rocks_name: rocks.name,
               sqlite_name: sqlite.name,
               gsn_counter: counter,
               gsn_counter_name: gsn_counter_name,
               initial_gsn: 42
             )

    assert Process.whereis(name) == pid
    assert :persistent_term.get(gsn_counter_name) === counter
    assert :atomics.get(counter, 1) == 42

    assert :ok = GenServer.stop(pid)

    refute Process.whereis(name)
    assert Enum.all?(@cache_children, &(Process.whereis(&1) == nil))
  end

  test "init's stop path gives up on a children supervisor that will not shut down" do
    rocks = TestHelpers.start_rocks(%{test: "init_stop_timeout"})
    sqlite = TestHelpers.start_sqlite(rocks.dir)

    name = unique_name("system_cache")
    gsn_counter_name = unique_name("gsn_counter")
    on_exit(fn -> :persistent_term.erase(gsn_counter_name) end)

    assert {:ok, pid} =
             SystemCache.start_link(
               name: name,
               rocks_name: rocks.name,
               sqlite_name: sqlite.name,
               gsn_counter: :atomics.new(1, signed: false),
               gsn_counter_name: gsn_counter_name,
               initial_gsn: 0
             )

    sup_pid = children_supervisor(pid)
    # `:sys.suspend/1` still answers system messages; suspending the process
    # itself leaves it alive but unable to run, which is what a wedged
    # supervisor looks like.
    true = :erlang.suspend_process(sup_pid)

    # Free the names even when an assertion below fails: a suspended cache
    # supervisor would otherwise hold them for the rest of the suite.
    on_exit(fn ->
      if cache_pid = Process.whereis(name), do: TestHelpers.safe_stop(cache_pid)
      resume(sup_pid)
      await_cache_children_exit()
    end)

    started = System.monotonic_time(:millisecond)

    log =
      capture_log(fn ->
        assert :ok = GenServer.stop(pid, :normal, 20_000)
      end)

    elapsed = System.monotonic_time(:millisecond) - started

    assert log =~ "cache children still running"
    # `stop_children/1` gives the supervisor five seconds before it gives up;
    # returning sooner would mean the suspended supervisor was never asked.
    assert elapsed >= 5_000

    true = :erlang.resume_process(sup_pid)
    await_cache_children_exit()

    assert Enum.all?(@cache_children, &(Process.whereis(&1) == nil))
  end

  # `init/1` links the children supervisor to itself, so it is the only link
  # that is not this test process.
  defp children_supervisor(pid) do
    {:links, links} = Process.info(pid, :links)
    [sup_pid] = links -- [self()]
    sup_pid
  end

  defp resume(sup_pid) do
    try do
      :erlang.resume_process(sup_pid)
    catch
      _, _ -> :ok
    end
  end

  defp await_cache_children_exit(attempts \\ 200) do
    case Enum.filter(@cache_children, &Process.whereis/1) do
      [] ->
        :ok

      _remaining when attempts > 0 ->
        Process.sleep(10)
        await_cache_children_exit(attempts - 1)

      remaining ->
        flunk("cache children still registered after shutdown: #{inspect(remaining)}")
    end
  end

  defp unique_name(prefix), do: :"#{prefix}_#{System.unique_integer([:positive])}"

  defp stop_storage_supervisor do
    if pid = Process.whereis(StorageSupervisor) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        _, _ -> :ok
      end
    end
  end
end
