defmodule EbbServer.Storage.ActionScope do
  @moduledoc """
  Reads the per-subject delivery scopes persisted with a committed Action.

  The Writer stores `"subject_scopes"`, one `{subject_id, [group_id]}` entry
  per folded subject, in first-appearance order (#814). An Update is
  delivered through its own subject's entry, so the C component Updates of
  one row share one scope decision instead of repeating it. Fan-out and
  catch-up use this so an Update reaches exactly the groups its subject
  scopes to.

  `EbbServer.Storage.ActionFormat` is the one gate on the list's shape: every
  reader of a committed Action goes through it, and it raises rather than
  returning a record with a missing or mistyped half. There is no second
  shape check here.

  ## A subject with no entry

  A listed subject with `[]` means "deliver to nobody", and its Updates are
  withheld. An Update whose subject is absent from an otherwise well-formed
  list is delivered to every group the Action is indexed under: the shape says
  nothing about whether the list covers every subject, and the delivery filter
  must not drop an Update the Action committed. Resolving the record from the
  caches instead is not possible this late — a `relationship`/`entityGroup`
  delete's by-id entry is already gone.
  """

  @doc """
  Returns the Updates of `action` whose own subject's scope includes
  `group_id`.
  """
  @spec updates_for_group(map(), String.t()) :: [map()]
  def updates_for_group(action, group_id) do
    scopes = Map.new(action["subject_scopes"])

    action
    |> Map.get("updates", [])
    |> Enum.filter(&delivered_to?(&1, scopes, group_id))
  end

  defp delivered_to?(update, scopes, group_id) do
    case Map.fetch(scopes, update["subject_id"]) do
      {:ok, group_ids} -> group_id in group_ids
      :error -> true
    end
  end
end
