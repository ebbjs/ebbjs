defmodule EbbServer.Storage.CacheMutationPlanner do
  @moduledoc """
  Computes the system-cache writes a batch's rows imply, and the overlay of
  rows those writes would leave behind. Its input is the folded row
  projection (`EbbServer.Storage.RowMutations`), because the system caches
  are projections of whole rows: a membership's `group_id` and a
  relationship's `source_id` may arrive in different component Updates of the
  same row.

  The planner is pure: it reads only the `tables` map it is given and the
  `overlay` it is handed, and it writes no cache. `EbbServer.Storage.Writer`
  keeps the apply stage — it plans before the commit, then applies the
  returned mutations once the range is durable.

  ## Overlay

  A plan's overlay carries its own prior effects, mapping `{cache, id}` to
  the row the plan would leave behind or to `:deleted`. So a later Update
  in the same plan merges over an earlier put or sees an earlier delete
  instead of reading a cache the plan has not written yet. The overlay is
  returned so the caller can chain plans: plan N+1 can be computed while
  plan N's mutations are still unapplied, and dropping N's slice on abandon
  makes N+1 resolve against the pre-plan cache.

  The overlay is opaque. `EbbServer.Storage.EntityIndex` reads it through
  the functions here rather than the raw map, so the planner can add
  projections — such as the entity→groups index below — without changing
  those callers.
  """

  alias EbbServer.Storage.{
    EntityGroupCache,
    FieldMerge,
    Fields,
    GroupAppsCache,
    GroupCache,
    RelationshipCache,
    RowMutations
  }

  alias EbbServer.Storage.CacheMutationPlanner.Overlay

  @typedoc """
  The caches a patch merge reads. Each is an ETS table keyed by entry id.
  """
  @type tables :: %{
          group_members_by_id: :ets.tab(),
          entity_groups_by_id: :ets.tab(),
          relationships_by_id: :ets.tab(),
          group_apps: :ets.tab()
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
          | {:group_apps_put, String.t(), map() | nil}
          | {:group_apps_delete, String.t()}

  @type overlay :: Overlay.t()

  @doc """
  Plans a flat list of folded row mutations against the given cache tables.

  The returned overlay is `overlay` extended with this plan's effects, so a
  caller can chain onto a predecessor's plan with `plan(updates, tables,
  predecessor_overlay)`.

  Repeat-dropping is per plan: an identical mutation at the tail of one plan
  and the head of the next is emitted (and applied) twice, which every cache
  here treats as idempotent.
  """
  @spec plan([RowMutations.mutation()], tables(), overlay() | nil) ::
          {[mutation()], overlay()}
  def plan(updates, tables, overlay \\ nil) do
    overlay = Overlay.normalize(overlay)

    {mutations, overlay} =
      Enum.reduce(updates, {[], overlay}, fn update, acc -> plan_update(update, tables, acc) end)

    {mutations |> Enum.reverse() |> drop_repeats(), overlay}
  end

  @doc """
  Returns the slice of `cumulative` that `mutations` contributed.

  A batch stores its own slice, not the cumulative overlay, so releasing it
  drops exactly its effects from the chain while a successor's later writes
  survive.
  """
  @spec slice(overlay(), [mutation()]) :: overlay()
  def slice(%Overlay{} = cumulative, mutations) do
    Enum.reduce(mutations, Overlay.empty(), fn mutation, slice ->
      slice_mutation(slice, cumulative, mutation)
    end)
  end

  @doc """
  Merges per-batch slices in the order they were planned.

  Later slices override earlier rows. The entity→groups projection is
  rebuilt from the merged membership rows, so an applied predecessor's
  slice is absent after release without losing the successor's writes.
  """
  @spec merge_overlays([overlay()]) :: overlay()
  def merge_overlays(overlays) do
    Enum.reduce(overlays, Overlay.empty(), fn overlay, merged ->
      Overlay.merge(merged, Overlay.normalize(overlay))
    end)
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

  # The entity-type cache mirrors the model entries of
  # `cf_component_entities`, which the Writer writes for every row (including
  # deletes, whose entry stays). A delete's model is the committed one the
  # fold resolved; an id nothing records has nothing to index, and an Action
  # cannot invent a model for it.
  defp plan_update(%{model: nil} = update, tables, {mutations, overlay}) do
    plan_system_mutation(update, tables, mutations, overlay)
  end

  defp plan_update(update, tables, {mutations, overlay}) do
    overlay = Overlay.put(overlay, {:entity_types, update.subject_id}, update.model)
    mutations = [{:entity_type, update.subject_id, update.model} | mutations]
    plan_system_mutation(update, tables, mutations, overlay)
  end

  defp plan_system_mutation(%{model: "groupMember"} = update, tables, mutations, overlay) do
    key = {:group_members_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            :group_members_by_id,
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

          {[{:group_member_put, row} | mutations], Overlay.put(overlay, key, row)}
        end

      :delete ->
        {[{:group_member_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(%{model: "entityGroup"} = update, tables, mutations, overlay) do
    key = {:entity_groups_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            :entity_groups_by_id,
            tables.entity_groups_by_id,
            &EntityGroupCache.get_entity_group/2
          )

        entity_id = Fields.get(data, "entity_id") || existing[:entity_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(entity_id) or is_nil(group_id) do
          {mutations, overlay}
        else
          row = %{id: update.subject_id, entity_id: entity_id, group_id: group_id}
          {[{:entity_group_put, row} | mutations], Overlay.put(overlay, key, row)}
        end

      :delete ->
        entity_id = entity_group_entity(overlay, update.subject_id, tables)

        {[{:entity_group_delete, update.subject_id} | mutations],
         Overlay.delete_entity_group(overlay, update.subject_id, entity_id)}
    end
  end

  # A group put replaces the whole row, so its apps field is exactly the
  # wire value. A patch merges per app id so concurrent scope edits do not
  # clobber each other. Neither path affects write authorization: app scope
  # is a sync filter, so the overlay must not serialize successors.
  defp plan_system_mutation(%{model: "group"} = update, tables, mutations, overlay) do
    key = {:group_apps, update.subject_id}

    case update.method do
      :put ->
        field = Fields.get(update.data || %{}, "apps")

        {[{:group_apps_put, update.subject_id, field} | mutations],
         Overlay.put(overlay, key, field)}

      :patch ->
        data = update.data || %{}

        if Fields.present?(data, "apps") do
          field = merge_group_apps(update, overlay, data, tables)

          {[{:group_apps_put, update.subject_id, field} | mutations],
           Overlay.put(overlay, key, field)}
        else
          {mutations, overlay}
        end

      :delete ->
        {[{:group_apps_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  # A relationship row's components may arrive across several Updates, so the
  # wire value wins where it is present and the cached row supplies the rest.
  # A row still missing its source or target cannot be projected.
  defp plan_system_mutation(%{model: "relationship"} = update, tables, mutations, overlay) do
    key = {:relationships_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        plan_relationship_put(update, tables, mutations, overlay, key)

      :delete ->
        {[{:relationship_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(_update, _tables, mutations, overlay), do: {mutations, overlay}

  defp plan_relationship_put(update, tables, mutations, overlay, key) do
    existing =
      patch_existing(
        update,
        overlay,
        :relationships_by_id,
        tables.relationships_by_id,
        &RelationshipCache.get_relationship/2
      )

    row = relationship_row(update, existing)

    if row == nil do
      {mutations, overlay}
    else
      {[{:relationship_put, row} | mutations], Overlay.put(overlay, key, row)}
    end
  end

  # A relationship row names a source and a target; a row still missing
  # either cannot be projected into the by-id cache.
  defp relationship_row(update, existing) do
    data = update.data || %{}
    source_id = Fields.get(data, "source_id") || row_field(existing, :source_id)
    target_id = Fields.get(data, "target_id") || row_field(existing, :target_id)

    if is_nil(source_id) or is_nil(target_id) do
      nil
    else
      %{
        id: update.subject_id,
        source_id: source_id,
        target_id: target_id,
        type: Fields.get(data, "type") || row_field(existing, :type),
        field: Fields.get(data, "field") || row_field(existing, :field)
      }
    end
  end

  # Only a patch consults a pre-existing row. The overlay is the plan's own
  # prior effect, so a delete in the same plan means there is nothing left
  # to merge over and the patch cannot resurrect a pre-plan row.
  defp patch_existing(%{method: :patch} = update, overlay, cache, table, fetch) do
    case Overlay.fetch(overlay, cache, update.subject_id) do
      {:ok, :deleted} -> %{}
      {:ok, row} -> row
      :error -> fetch.(update.subject_id, table) || %{}
    end
  end

  defp patch_existing(_update, _overlay, _cache, _table, _fetch), do: %{}

  defp merge_group_apps(update, overlay, data, tables) do
    existing =
      patch_existing(update, overlay, :group_apps, tables.group_apps, &GroupAppsCache.get_field/2)

    FieldMerge.merge(existing, Fields.get(data, "apps"))
  end

  defp row_field(existing, key), do: existing[key] || existing[to_string(key)]

  # A delete's wire form carries only the membership id, so the projection
  # needs the entity the row belonged to. Prefer the chain, then the cache.
  defp entity_group_entity(overlay, membership_id, tables) do
    Overlay.entity_for_membership(overlay, membership_id) ||
      case EntityGroupCache.get_entity_group(membership_id, tables.entity_groups_by_id) do
        nil -> nil
        entry -> entry[:entity_id] || entry["entity_id"]
      end
  end

  defp slice_mutation(slice, _cumulative, {:entity_type, id, type}) do
    Overlay.put(slice, {:entity_types, id}, type)
  end

  defp slice_mutation(slice, _cumulative, {:group_member_put, %{id: id} = row}) do
    Overlay.put(slice, {:group_members_by_id, id}, row)
  end

  defp slice_mutation(slice, _cumulative, {:group_member_delete, id}) do
    Overlay.put(slice, {:group_members_by_id, id}, :deleted)
  end

  defp slice_mutation(slice, _cumulative, {:entity_group_put, %{id: id} = row}) do
    Overlay.put(slice, {:entity_groups_by_id, id}, row)
  end

  defp slice_mutation(slice, cumulative, {:entity_group_delete, id}) do
    Overlay.delete_entity_group(slice, id, Overlay.entity_for_membership(cumulative, id))
  end

  defp slice_mutation(slice, _cumulative, {:relationship_put, %{id: id} = row}) do
    Overlay.put(slice, {:relationships_by_id, id}, row)
  end

  defp slice_mutation(slice, _cumulative, {:relationship_delete, id}) do
    Overlay.put(slice, {:relationships_by_id, id}, :deleted)
  end

  defp slice_mutation(slice, _cumulative, {:group_apps_put, id, field}) do
    Overlay.put(slice, {:group_apps, id}, field)
  end

  defp slice_mutation(slice, _cumulative, {:group_apps_delete, id}) do
    Overlay.put(slice, {:group_apps, id}, :deleted)
  end

  defp mutation_value({:entity_type, _id, type}), do: type
  defp mutation_value({:group_member_put, row}), do: row
  defp mutation_value({:group_member_delete, _id}), do: :deleted
  defp mutation_value({:entity_group_put, row}), do: row
  defp mutation_value({:entity_group_delete, _id}), do: :deleted
  defp mutation_value({:relationship_put, row}), do: row
  defp mutation_value({:relationship_delete, _id}), do: :deleted
  defp mutation_value({:group_apps_put, _id, field}), do: field
  defp mutation_value({:group_apps_delete, _id}), do: :deleted

  defp mutation_key({:entity_type, id, _type}), do: {:entity_types, id}
  defp mutation_key({:group_member_put, %{id: id}}), do: {:group_members_by_id, id}
  defp mutation_key({:group_member_delete, id}), do: {:group_members_by_id, id}
  defp mutation_key({:entity_group_put, %{id: id}}), do: {:entity_groups_by_id, id}
  defp mutation_key({:entity_group_delete, id}), do: {:entity_groups_by_id, id}
  defp mutation_key({:relationship_put, %{id: id}}), do: {:relationships_by_id, id}
  defp mutation_key({:relationship_delete, id}), do: {:relationships_by_id, id}
  defp mutation_key({:group_apps_put, id, _field}), do: {:group_apps, id}
  defp mutation_key({:group_apps_delete, id}), do: {:group_apps, id}
end
