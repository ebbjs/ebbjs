defmodule EbbServer.Storage.CacheMutationPlanner do
  @moduledoc """
  Computes the system-cache writes a batch's Updates imply, and the
  overlay of rows those writes would leave behind.

  The planner is pure: it reads only the `tables` map it is given and the
  `overlay` it is handed, and it writes no cache. `EbbServer.Storage.Writer`
  keeps the apply stage — `apply_post_commit/2` plans from its live cache
  table names, then applies each returned mutation.

  ## Overlay

  A plan's overlay carries its own prior effects, mapping `{cache, id}` to
  the row the plan would leave behind or to `:deleted`. So a later Update
  in the same plan merges over an earlier put or sees an earlier delete
  instead of reading a cache the plan has not written yet. The overlay is
  returned so the caller can chain plans: plan N+1 can be computed while
  plan N's mutations are still unapplied, and dropping N's overlay on
  abandon makes N+1 resolve against the pre-plan cache.
  """

  alias EbbServer.Storage.{EntityGroupCache, Fields, GroupCache, PermissionChecker}

  @typedoc """
  The caches a patch merge reads. Both are ETS tables keyed by entry id.
  """
  @type tables :: %{
          group_members_by_id: :ets.tab(),
          entity_groups_by_id: :ets.tab()
        }

  @typedoc """
  One planned cache write: a row put, an id delete, or the entity-type
  index entry every Update carries.
  """
  @type mutation ::
          {:entity_type, String.t(), String.t()}
          | {:group_member_put, map()}
          | {:group_member_delete, String.t()}
          | {:entity_group_put, map()}
          | {:entity_group_delete, String.t()}
          | {:relationship_put, map()}
          | {:relationship_delete, String.t()}

  @type cache_key :: {atom(), String.t()}
  @type overlay :: %{optional(cache_key()) => map() | :deleted}

  @doc """
  Plans a flat list of validated Updates against the given cache tables.

  The returned overlay is `overlay` extended with this plan's effects, so a
  caller can chain onto a predecessor's plan with `plan(updates, tables,
  predecessor_overlay)`.

  Repeat-dropping is per plan: an identical mutation at the tail of one plan
  and the head of the next is emitted (and applied) twice, which every cache
  here treats as idempotent.
  """
  @spec plan([PermissionChecker.validated_update()], tables(), overlay()) ::
          {[mutation()], overlay()}
  def plan(updates, tables, overlay \\ %{}) do
    {mutations, overlay} =
      Enum.reduce(updates, {[], overlay}, fn update, acc -> plan_update(update, tables, acc) end)

    {mutations |> Enum.reverse() |> drop_repeats(), overlay}
  end

  # A repeat is dropped only when it is identical to the previous mutation
  # for the same key. Two identical applications in a row are idempotent
  # for every cache here, so this preserves the final state sequential
  # per-Update application would produce. It also keeps `GroupCache`'s
  # actor-keyed cleanup honest: collapsing two *different* rows for one
  # membership id would strand the first one's primary row.
  defp drop_repeats(mutations) do
    {kept, _last} =
      Enum.reduce(mutations, {[], %{}}, fn mutation, {kept, last} ->
        key = mutation_key(mutation)
        value = mutation_value(mutation)

        case Map.fetch(last, key) do
          {:ok, ^value} -> {kept, last}
          _ -> {[mutation | kept], Map.put(last, key, value)}
        end
      end)

    Enum.reverse(kept)
  end

  # The entity-type index mirrors `cf_type_entities`, which the Writer
  # writes for every Update (including deletes, whose entry stays).
  defp plan_update(update, tables, {mutations, overlay}) do
    mutations = [{:entity_type, update.subject_id, update.subject_type} | mutations]
    plan_system_mutation(update, tables, mutations, overlay)
  end

  defp plan_system_mutation(%{subject_type: "groupMember"} = update, tables, mutations, overlay) do
    key = {:group_members_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            key,
            tables.group_members_by_id,
            &GroupCache.get_group_member/2
          )

        actor_id = Fields.get(data, "actor_id") || existing[:actor_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(actor_id) or is_nil(group_id) do
          {mutations, overlay}
        else
          row = %{
            id: update.subject_id,
            actor_id: actor_id,
            group_id: group_id,
            permissions: Fields.get(data, "permissions") || existing[:permissions]
          }

          {[{:group_member_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:group_member_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(%{subject_type: "entityGroup"} = update, tables, mutations, overlay) do
    key = {:entity_groups_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            key,
            tables.entity_groups_by_id,
            &EntityGroupCache.get_entity_group/2
          )

        entity_id = Fields.get(data, "entity_id") || existing[:entity_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(entity_id) or is_nil(group_id) do
          {mutations, overlay}
        else
          row = %{id: update.subject_id, entity_id: entity_id, group_id: group_id}
          {[{:entity_group_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:entity_group_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  # Relationship rows never merge with the cached row: the wire fields are
  # authoritative, as in the pre-dedup handler.
  defp plan_system_mutation(%{subject_type: "relationship"} = update, _tables, mutations, overlay) do
    key = {:relationships_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}
        source_id = Fields.get(data, "source_id")
        target_id = Fields.get(data, "target_id")

        if is_nil(source_id) or is_nil(target_id) do
          {mutations, overlay}
        else
          row = %{
            id: update.subject_id,
            source_id: source_id,
            target_id: target_id,
            type: Fields.get(data, "type"),
            field: Fields.get(data, "field")
          }

          {[{:relationship_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:relationship_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(_update, _tables, mutations, overlay), do: {mutations, overlay}

  # Only a patch consults a pre-existing row. The overlay is the plan's own
  # prior effect, so a delete in the same plan means there is nothing left
  # to merge over and the patch cannot resurrect a pre-plan row.
  defp patch_existing(%{method: :patch} = update, overlay, key, table, fetch) do
    case Map.fetch(overlay, key) do
      {:ok, :deleted} -> %{}
      {:ok, row} -> row
      :error -> fetch.(update.subject_id, table) || %{}
    end
  end

  defp patch_existing(_update, _overlay, _key, _table, _fetch), do: %{}

  defp mutation_value({:entity_type, _id, type}), do: type
  defp mutation_value({:group_member_put, row}), do: row
  defp mutation_value({:group_member_delete, _id}), do: :deleted
  defp mutation_value({:entity_group_put, row}), do: row
  defp mutation_value({:entity_group_delete, _id}), do: :deleted
  defp mutation_value({:relationship_put, row}), do: row
  defp mutation_value({:relationship_delete, _id}), do: :deleted

  defp mutation_key({:entity_type, id, _type}), do: {:entity_type, id}
  defp mutation_key({:group_member_put, %{id: id}}), do: {:group_members_by_id, id}
  defp mutation_key({:group_member_delete, id}), do: {:group_members_by_id, id}
  defp mutation_key({:entity_group_put, %{id: id}}), do: {:entity_groups_by_id, id}
  defp mutation_key({:entity_group_delete, id}), do: {:entity_groups_by_id, id}
  defp mutation_key({:relationship_put, %{id: id}}), do: {:relationships_by_id, id}
  defp mutation_key({:relationship_delete, id}), do: {:relationships_by_id, id}
end
