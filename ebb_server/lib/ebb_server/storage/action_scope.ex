defmodule EbbServer.Storage.ActionScope do
  @moduledoc """
  Reads the per-subject delivery scopes persisted with a committed Action.

  The Writer stores `"subject_scopes"`, one `{subject_id, [group_id]}` entry
  per folded subject, in first-appearance order (#814). An Update is
  delivered through its own subject's entry, so the C component Updates of
  one row share one scope decision instead of repeating it. Fan-out and
  catch-up use this so an Update reaches exactly the groups its subject
  scopes to.

  ## Fallbacks

  A stored Action always carries the list, so a missing or non-list value
  means the record is corrupt. Resolving it from the caches is not safe: a
  `relationship`/`entityGroup` delete's by-id entry is already gone. Such a
  record, and any Update whose subject is absent from a present list, is
  treated as unscoped and delivered to every group the Action is indexed
  under (fail open) rather than dropped.

  A subject listed with `[]` is neither fallback: it means "deliver to
  nobody", and its Updates are withheld.
  """

  alias EbbServer.Storage.ActionFormat

  @doc """
  Returns the Updates of `action` whose own subject's scope includes
  `group_id`.

  Unscoped Actions return every Update.
  """
  @spec updates_for_group(map(), String.t()) :: [map()]
  def updates_for_group(action, group_id) do
    updates = action["updates"] || []

    case subject_scopes_by_subject(action["subject_scopes"]) do
      {:ok, scopes} -> Enum.filter(updates, &delivered_to?(&1, scopes, group_id))
      :error -> updates
    end
  end

  defp delivered_to?(update, scopes, group_id) do
    case Map.fetch(scopes, update["subject_id"]) do
      {:ok, group_ids} -> group_id in group_ids
      :error -> true
    end
  end

  defp subject_scopes_by_subject(scopes) do
    if ActionFormat.subject_scopes?(scopes), do: {:ok, Map.new(scopes)}, else: :error
  end
end
