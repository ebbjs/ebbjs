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
  arrives in the row's one atomic component value, and an `ebb/link` write is
  scoped by its subject, which is already the source. Which owner a value
  names is the component's declaration
  (`EbbServer.Storage.SystemComponent`), read through `EntityScope`.
  """

  alias EbbServer.Storage.{EntityScope, PermissionHelper, RowMutations}

  @doc """
  Rows whose entity is missing from the index are silently dropped; the
  client catches them up via `/sync/groups/:id?offset=` instead.
  """
  @spec resolve_group_ids(map(), keyword()) :: [String.t()]
  def resolve_group_ids(action, opts) do
    updates =
      action["updates"]
      |> List.wrap()
      |> Enum.map(&RowMutations.from_stored/1)

    mutations = RowMutations.fold(updates, opts)

    opts =
      Keyword.put(opts, :intra_action, PermissionHelper.build_intra_action_context(mutations))

    mutations
    |> Enum.flat_map(&resolve_mutation_group_ids(&1, opts))
    |> Enum.uniq()
  end

  # A row's scope follows its component kind, never its model; only a delete's
  # kind has to be resolved from the by-id caches.
  defp resolve_mutation_group_ids(mutation, opts) do
    EntityScope.resolve_groups(scope_key(mutation, opts), mutation.subject_id, opts)
  end

  defp scope_key(%{kind: kind}, _opts) when not is_nil(kind), do: kind

  defp scope_key(mutation, opts) do
    EntityScope.kind(mutation.subject_id, opts) || mutation.model
  end
end
