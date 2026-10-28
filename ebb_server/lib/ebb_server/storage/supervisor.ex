defmodule EbbServer.Storage.Supervisor do
  @moduledoc """
  Supervisor for the storage layer.

  Starts children in order with `rest_for_one` strategy, ensuring RocksDB
  and SQLite are ready before SystemCache, WatermarkTracker and
  InFlightActions are ready before Writer, and Writer is last.

  The `rest_for_one` strategy means if any child crashes, those started
  after it (higher in the list) will be restarted, but those before it
  will not. Two reasons drive the order:

  - A `SystemCache` (or `WatermarkTracker`) failure must rebuild the
    in-memory caches, the in-flight action-id set, and the Writer, so the
    Writer reconciles against the fresh watermark on `init/1`.
  - A Writer-only crash restarts the Writer alone, since nothing is
    ordered after it. The linked Prepare and Committer pools stop with
    it, though a worker already inside `write_batch` may finish late. The
    replacement Writer clears the surviving in-flight ids and treats
    every unresolved claim as orphaned on `init/1`.

  `:writer_opts` is merged over the Writer's boot defaults so tests can
  inject a `:commit_fn` or a bad cache table while still exercising the
  real tree.

  ## Restarting over a dying predecessor

  The parent supervisor restarts this tree as soon as it dies, while the
  previous tree's children are still being killed through their links to
  it. Those children hold the registered names the replacements need, and
  the RocksDB handle they are still closing holds the LOCK file. Starting
  immediately therefore fails on `:already_started` or on the lock, and
  each failure burns one of the parent's restarts — so `init/1` waits for
  the predecessor's children to disappear before it starts new ones.
  """

  use Supervisor
  require Logger

  @writer_defaults [
    watermark_tracker: EbbServer.Storage.WatermarkTracker,
    in_flight_actions: EbbServer.Storage.InFlightActions,
    fan_out_router: EbbServer.Sync.FanOutRouter
  ]

  # Long enough for a Writer to finish the commit it is in the middle of,
  # short enough that a wedged predecessor does not block the parent forever.
  @predecessor_timeout_ms 5_000
  @predecessor_poll_ms 20

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    data_dir = Keyword.get(opts, :data_dir, Application.get_env(:ebb_server, :data_dir, "./data"))
    writer_opts = Keyword.merge(@writer_defaults, Keyword.get(opts, :writer_opts, []))

    children = [
      {EbbServer.Storage.RocksDB, data_dir: data_dir},
      {EbbServer.Storage.SQLite, data_dir: data_dir},
      {EbbServer.Storage.SystemCache, []},
      {EbbServer.Storage.WatermarkTracker, []},
      {EbbServer.Storage.InFlightActions, []},
      {EbbServer.Storage.Writer, writer_opts}
    ]

    :ok = await_predecessor(Enum.map(children, fn {module, _opts} -> module end))

    Supervisor.init(children, strategy: :rest_for_one)
  end

  # Every child registers itself under its module name, so a live name is a
  # predecessor's child that has not finished dying yet.
  defp await_predecessor(modules) do
    await_predecessor(modules, System.monotonic_time(:millisecond) + @predecessor_timeout_ms)
  end

  defp await_predecessor(modules, deadline) do
    case Enum.filter(modules, &Process.whereis/1) do
      [] ->
        :ok

      still_running ->
        if System.monotonic_time(:millisecond) >= deadline do
          Logger.warning(
            "storage children from the previous tree are still running: #{inspect(still_running)}"
          )

          :ok
        else
          Process.sleep(@predecessor_poll_ms)
          await_predecessor(modules, deadline)
        end
    end
  end
end
