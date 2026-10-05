defmodule EbbServer.Storage.Supervisor do
  @moduledoc """
  Supervisor for the storage layer.

  Starts children in order with `rest_for_one` strategy, ensuring RocksDB
  and SQLite are ready before SystemCache, WatermarkTracker is ready
  before Writer, and Writer is last.

  The `rest_for_one` strategy means if any child crashes, those started
  after it (higher in the list) will be restarted, but those before it
  will not. Two reasons drive the order:

  - A `SystemCache` (or `WatermarkTracker`) failure must rebuild the
    in-memory caches and the Writer, so the Writer reconciles against the
    fresh watermark on `init/1`.
  - A Writer-only crash restarts the Writer alone, since nothing is
    ordered after it.

  `:writer_opts` is merged over the Writer's boot defaults so tests can
  inject a `:commit_fn` or a bad cache table while still exercising the
  real tree.
  """

  use Supervisor

  @writer_defaults [
    watermark_tracker: EbbServer.Storage.WatermarkTracker,
    fan_out_router: EbbServer.Sync.FanOutRouter
  ]

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
      {EbbServer.Storage.Writer, writer_opts}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end
