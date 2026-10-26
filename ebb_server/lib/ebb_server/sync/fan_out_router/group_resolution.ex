defmodule EbbServer.Sync.FanOutRouter.GroupResolution do
  @moduledoc """
  Fallback group resolution for a committed Action.

  The Writer normally hands `EbbServer.Sync.FanOutRouter` the group set it
  used to build `cf_group_actions`, from its commit snapshot. This module
  covers the GSNs a notifier did not annotate: it resolves, per Action,
  which group ids the Action fans out to.
  """

  alias EbbServer.Storage.{EntityIndex, Fields, PermissionHelper}

  @doc """
  Resolves the set of group ids an Action should fan out to.

  Dispatches each Update through `EntityIndex`, folding in the
  membership rows carried by the Action itself so that a create and
  its `entityGroup` rows land in the same groups. See `EntityIndex`
  for the per-type resolution rules. Updates whose entity is missing
  from the index are silently dropped; the client catches them up via
  `/sync/groups/:id?offset=` instead.

  This is the **fallback** path: the Writer normally hands the Router
  the group set it used to build `cf_group_actions`, from the commit
  snapshot. Resolution here re-reads the caches, which have already
  moved for deletes, so it is only used for GSNs a notifier did not
  annotate.
  """
  @spec resolve_group_ids(map(), keyword()) :: [String.t()]
  def resolve_group_ids(action, opts) do
    intra_action = PermissionHelper.build_intra_action_context(action["updates"] || [])
    opts = Keyword.put(opts, :intra_action, intra_action)

    action["updates"]
    |> Enum.flat_map(&resolve_update_group_ids(&1, opts))
    |> Enum.uniq()
  end

  # A relationship belongs to its source's groups, never its own target.
  # The source follows the stored row for a delete, so a wire `source_id`
  # cannot widen a delete's scope (#624).
  defp resolve_update_group_ids(%{"subject_type" => "relationship"} = update, opts) do
    EntityIndex.relationship_groups(
      update["method"],
      Fields.get(update["data"], "source_id"),
      update["subject_id"],
      opts
    )
  end

  defp resolve_update_group_ids(update, opts) do
    EntityIndex.resolve_groups(update["subject_type"], update["subject_id"], opts)
  end
end
