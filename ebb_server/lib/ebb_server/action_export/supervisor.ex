defmodule EbbServer.ActionExport.Supervisor do
  @moduledoc """
  Supervises the Action exporter and the `Task.Supervisor` its handler
  invocations run under.

  Started only when `config :ebb_server, on_action: {Module, :fun}` is set
  (see `EbbServer.Application.action_export_children/0`). Options are
  passed through to `EbbServer.ActionExport`, with the supervisor's own
  `:name` removed so the two processes do not collide.
  """

  use Supervisor

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    action_opts = Keyword.delete(opts, :name)

    task_supervisor =
      Keyword.get(action_opts, :task_supervisor, EbbServer.ActionExport.TaskSupervisor)

    children = [
      {Task.Supervisor, name: task_supervisor},
      {EbbServer.ActionExport, action_opts}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
