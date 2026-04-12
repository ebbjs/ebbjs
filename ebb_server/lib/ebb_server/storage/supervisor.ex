defmodule EbbServer.Storage.Supervisor do
  @moduledoc """
  Supervisor for the storage layer.

  Starts children in order with `rest_for_one` strategy, ensuring RocksDB
  and SQLite are ready before SystemCache, WatermarkTracker is ready
  before Writer.

  The `rest_for_one` strategy means if any child crashes, those started
  after it (higher in the list) will be restarted, but those before it
  will not.
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    data_dir = Keyword.get(opts, :data_dir, Application.get_env(:ebb_server, :data_dir, "./data"))

    children = [
      {EbbServer.Storage.RocksDB, data_dir: data_dir},
      {EbbServer.Storage.SQLite, data_dir: data_dir},
      {EbbServer.Storage.SystemCache, []},
      {EbbServer.Storage.WatermarkTracker, []}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end
