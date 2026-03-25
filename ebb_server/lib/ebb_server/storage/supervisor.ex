defmodule EbbServer.Storage.Supervisor do
  use Supervisor
  def start_link(init_arg) do
    Supervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end
  def init(_init_arg) do
    children = [
      # Storage children will go here later (Writer, etc.)
    ]
    Supervisor.init(children, strategy: :rest_for_one)
  end
end
