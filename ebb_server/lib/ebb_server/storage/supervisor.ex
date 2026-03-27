defmodule EbbServer.Storage.Supervisor do
  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    data_dir = Application.get_env(:ebb_server, :data_dir, "./data")

    children = [
      {EbbServer.Storage.RocksDB, data_dir: data_dir},
      {EbbServer.Storage.SQLite, data_dir: data_dir},
      {EbbServer.Storage.SystemCache, []},
      {EbbServer.Storage.Writer, []}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end
