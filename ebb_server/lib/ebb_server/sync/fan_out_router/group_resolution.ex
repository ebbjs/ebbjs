defmodule EbbServer.Sync.FanOutRouter.GroupResolution do
  @moduledoc """
  Fallback group resolution for a committed Action.

  The Writer normally hands `EbbServer.Sync.FanOutRouter` the group set it
  used to build `cf_group_actions`, from its commit snapshot. This module
  covers the GSNs a notifier did not annotate: it resolves, per Action,
  which group ids the Action fans out to.

  A row's scope is a per-subject decision, so the Action's per-component
  Updates fold into row mutations first
  (`EbbServer.Storage.RowMutations`): an `ebb/membership` row's `group_id`
  and an `ebb/link` row's `source_id` each arrive in the row's one atomic
  component value.
  """

  alias EbbServer.Storage.{EntityIndex, PermissionHelper, RowMutations, SystemComponent}

  @doc """
  Resolves the set of group ids an Action should fan out to.

  Dispatches each folded row through `EntityIndex`, folding in the
  membership rows carried by the Action itself so that a create and its
  `ebb/membership` rows land in the same groups. See `EntityIndex` for the
  per-kind resolution rules. Rows whose entity is missing from the index
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
    updates =
      action["updates"]
      |> List.wrap()
      |> Enum.map(&RowMutations.from_stored/1)

    mutations = RowMutations.fold(updates, opts)

    opts =
      opts
      |> Keyword.put(:intra_action, PermissionHelper.build_intra_action_context(mutations))
      |> Keyword.put_new_lazy(:intra_relationship_sources, fn ->
        PermissionHelper.build_intra_relationship_sources(updates)
      end)

    mutations
    |> Enum.flat_map(&resolve_mutation_group_ids(&1, opts))
    |> Enum.uniq()
  end

  # A row's scope is decided by its component kind, never by its model: all
  # four platform kinds commit under `ebb`. A delete names no component, so
  # the by-id caches are the only place its kind survives — and a link the
  # same Action created has no cache row yet, which is what
  # `:intra_relationship_sources` covers.
  defp resolve_mutation_group_ids(mutation, opts) do
    case scope_key(mutation, opts) do
      :link ->
        # A link belongs to its source's groups, never its target's. A put or
        # patch is bound to the source the wire carries (the authorizer
        # refuses a mismatch), a delete to the stored row's (#624).
        EntityIndex.relationship_groups(
          mutation.method,
          SystemComponent.path(mutation.data, :link, "source_id"),
          mutation.subject_id,
          opts
        )

      nil ->
        EntityIndex.resolve_groups(mutation.model, mutation.subject_id, opts)

      kind ->
        EntityIndex.resolve_groups(kind, mutation.subject_id, opts)
    end
  end

  defp scope_key(%{kind: kind}, _opts) when not is_nil(kind), do: kind

  defp scope_key(mutation, opts) do
    EntityIndex.kind(mutation.subject_id, opts) || mutation.model
  end
end
