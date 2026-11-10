defmodule EbbServer.Sync.FanOutRouter.GroupResolution do
  @moduledoc """
  Fallback group resolution for a committed Action.

  The Writer normally hands `EbbServer.Sync.FanOutRouter` the group set it
  used to build `cf_group_actions`, from its commit snapshot. This module
  covers the GSNs a notifier did not annotate: it resolves, per Action,
  which group ids the Action fans out to.

  A row's scope is a per-subject decision, so the Action's per-component
  Updates fold into row mutations first
  (`EbbServer.Storage.RowMutations`): an `entityGroup` row's `group_id` and
  a relationship row's `source_id` each arrive in one component Update while
  their siblings carry none.
  """

  alias EbbServer.Storage.{EntityIndex, Fields, PermissionHelper, RowMutations}

  @doc """
  Resolves the set of group ids an Action should fan out to.

  Dispatches each folded row through `EntityIndex`, folding in the
  membership rows carried by the Action itself so that a create and its
  `entityGroup` rows land in the same groups. See `EntityIndex` for the
  per-model resolution rules. Rows whose entity is missing from the index
  are silently dropped; the client catches them up via
  `/sync/groups/:id?offset=` instead.

  This is the **fallback** path: the Writer normally hands the Router
  the group set it used to build `cf_group_actions`, from the commit
  snapshot. Resolution here re-reads the caches, which have already
  moved for deletes, so it is only used for GSNs a notifier did not
  annotate.
  """
  @spec resolve_group_ids(map(), keyword()) :: [String.t()]
  def resolve_group_ids(action, opts) do
    mutations =
      action["updates"]
      |> List.wrap()
      |> Enum.map(&RowMutations.from_stored/1)
      |> RowMutations.fold(opts)

    intra_action = PermissionHelper.build_intra_action_context(mutations)
    opts = Keyword.put(opts, :intra_action, intra_action)

    mutations
    |> Enum.flat_map(&resolve_mutation_group_ids(&1, opts))
    |> Enum.uniq()
  end

  # A relationship belongs to its source's groups, never its own target.
  # The source follows the stored row for a delete, so a wire `source_id`
  # cannot widen a delete's scope (#624).
  defp resolve_mutation_group_ids(%{model: "relationship"} = mutation, opts) do
    EntityIndex.relationship_groups(
      mutation.method,
      Fields.get(mutation.data, "source_id"),
      mutation.subject_id,
      opts
    )
  end

  defp resolve_mutation_group_ids(mutation, opts) do
    EntityIndex.resolve_groups(mutation.model, mutation.subject_id, opts)
  end
end
