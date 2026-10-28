defmodule EbbServer.Sync.GroupRegistry do
  @moduledoc """
  The `Registry` mapping a group id to its live `GroupServer`.

  The registry is a sibling of the sync tree rather than a child of it, so
  there are windows — during its own restart, and between two trees in
  tests — where the name is unregistered. `Registry.lookup/2` raises
  `ArgumentError` in that window, and a fan-out has nowhere to go: a
  `GroupServer` cannot outlive the registry it is registered in.

  `lookup/1` treats that window as "nothing registered". It also returns
  `nil` when the registry disappears between the check and the ETS read,
  since that race is the whole point.
  """

  @registry __MODULE__

  @doc """
  The live `GroupServer` pid for `group_id`, or `nil` when there is none
  or the registry is not running.
  """
  @spec lookup(String.t()) :: pid() | nil
  def lookup(group_id) do
    case Registry.lookup(@registry, group_id) do
      [{pid, _value}] -> pid
      [] -> nil
    end
  rescue
    ArgumentError -> nil
  end

  @doc "The `:via` name a `GroupServer` for `group_id` registers under."
  @spec name(String.t()) :: {:via, module(), {module(), String.t()}}
  def name(group_id), do: {:via, Registry, {@registry, group_id}}
end
