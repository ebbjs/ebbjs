defmodule EbbServer.Storage.CacheMutationPlanner do
  @moduledoc """
  Computes the system-cache writes a batch's rows imply, and the overlay of
  rows those writes would leave behind. Its input is the folded row
  projection (`EbbServer.Storage.RowMutations`), because the system caches
  are projections of whole rows: a row's delivered scope and its cache row
  are properties of the row.

  Each platform component is **atomic**, so a plan projects its value
  directly; there is no "wire value wins, cached row supplies the rest"
  merge to get wrong. A folded row that does not carry the component (a
  `drop`, or a row delete) deletes that kind's cache row.

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
    RowMutations,
    SystemComponent
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

  # The entity-type cache mirrors the derived component index's model entries,
  # which the Writer applies for every row (including deletes, whose entry
  # stays). A delete's model is the committed one the fold resolved; an id
  # nothing records has nothing to index, and an Action cannot invent a model
  # for it.
  defp plan_update(%{model: nil} = update, tables, {mutations, overlay}) do
    plan_system_mutation(update, tables, mutations, overlay)
  end

  defp plan_update(update, tables, {mutations, overlay}) do
    overlay = Overlay.put(overlay, {:entity_types, update.subject_id}, update.model)
    mutations = [{:entity_type, update.subject_id, update.model} | mutations]
    plan_system_mutation(update, tables, mutations, overlay)
  end

  defp plan_system_mutation(%{kind: :grant} = update, _tables, mutations, overlay) do
    key = {:group_members_by_id, update.subject_id}

    case SystemComponent.value(update.data, :grant) do
      %{} = value ->
        row = %{
          id: update.subject_id,
          actor_id: Map.get(value, "actor_id"),
          group_id: Map.get(value, "group_id"),
          permissions: Map.get(value, "permissions")
        }

        if is_nil(row.actor_id) or is_nil(row.group_id) do
          {mutations, overlay}
        else
          {[{:group_member_put, row} | mutations], Overlay.put(overlay, key, row)}
        end

      nil ->
        {[{:group_member_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(%{kind: :membership} = update, tables, mutations, overlay) do
    key = {:entity_groups_by_id, update.subject_id}

    case SystemComponent.value(update.data, :membership) do
      %{} = value ->
        row = %{
          id: update.subject_id,
          entity_id: Map.get(value, "entity_id"),
          group_id: Map.get(value, "group_id")
        }

        if is_nil(row.entity_id) or is_nil(row.group_id) do
          {mutations, overlay}
        else
          {[{:entity_group_put, row} | mutations], Overlay.put(overlay, key, row)}
        end

      nil ->
        entity_id = entity_group_entity(overlay, update.subject_id, tables)

        {[{:entity_group_delete, update.subject_id} | mutations],
         Overlay.delete_entity_group(overlay, update.subject_id, entity_id)}
    end
  end

  # App scope is one key of the atomic group value, so the wire value is the
  # whole scope. A sync filter must not serialize successors in the overlay.
  defp plan_system_mutation(%{kind: :group} = update, _tables, mutations, overlay) do
    key = {:group_apps, update.subject_id}

    case SystemComponent.value(update.data, :group) do
      %{} = value ->
        apps = Map.get(value, "apps")

        {[{:group_apps_put, update.subject_id, apps} | mutations],
         Overlay.put(overlay, key, apps)}

      nil ->
        {[{:group_apps_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  # A value missing a source or target cannot be projected.
  defp plan_system_mutation(%{kind: :link} = update, _tables, mutations, overlay) do
    key = {:relationships_by_id, update.subject_id}

    case SystemComponent.value(update.data, :link) do
      %{} = value ->
        row = %{
          id: update.subject_id,
          source_id: Map.get(value, "source_id"),
          target_id: Map.get(value, "target_id"),
          type: Map.get(value, "type"),
          field: Map.get(value, "field")
        }

        if is_nil(row.source_id) or is_nil(row.target_id) do
          {mutations, overlay}
        else
          {[{:relationship_put, row} | mutations], Overlay.put(overlay, key, row)}
        end

      nil ->
        {[{:relationship_delete, update.subject_id} | mutations],
         Overlay.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(_update, _tables, mutations, overlay), do: {mutations, overlay}

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
