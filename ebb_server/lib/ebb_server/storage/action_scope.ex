defmodule EbbServer.Storage.ActionScope do
  @moduledoc """
  Reads the per-Update delivery scopes persisted with a committed Action.

  The Writer stores `"update_scopes"`, one group list per Update,
  index-aligned with `"updates"` (#473). Fan-out and catch-up use this so
  an Update reaches exactly the groups it scopes to.

  An Action committed before the scopes were persisted has no
  `"update_scopes"`, and resolving it from the caches is not safe: a
  `relationship`/`entityGroup` delete's by-id entry is already gone. Such
  an Action — and a malformed scope list — is treated as unscoped and
  returned whole, which is the pre-#473 delivery behavior.
  """

  @doc """
  Returns the Updates of `action` whose own scope includes `group_id`.

  Unscoped Actions return every Update.
  """
  @spec updates_for_group(map(), String.t()) :: [map()]
  def updates_for_group(action, group_id) do
    updates = action["updates"] || []

    case action["update_scopes"] do
      scopes when is_list(scopes) ->
        if length(scopes) == length(updates) do
          scoped_updates(updates, scopes, group_id)
        else
          updates
        end

      _ ->
        updates
    end
  end

  defp scoped_updates(updates, scopes, group_id) do
    updates
    |> Enum.zip(scopes)
    |> Enum.flat_map(fn {update, scope} ->
      if group_id in scope, do: [update], else: []
    end)
  end
end
