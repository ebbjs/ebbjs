defmodule EbbServer.Storage.CacheMutationPlanner.Overlay do
  @moduledoc """
  The planned future state of the system caches, plus the projections
  `EntityIndex` needs to resolve a successor batch against it.

  `rows` stores one entry per touched `{cache, id}`. `entity_group_ids`
  inverts the `entityGroup` rows so an entity's groups can be resolved
  without scanning the whole overlay, and `entity_group_entities` keeps
  the entity a deleted membership belonged to. Treat the struct as
  opaque: read it through `fetch/3`, `entity_groups/3`, and
  `entity_for_membership/2`.
  """

  alias __MODULE__, as: Overlay

  @type cache ::
          :group_members_by_id
          | :entity_groups_by_id
          | :relationships_by_id
          | :entity_types

  @type cache_key :: {cache(), String.t()}
  @type row :: map() | :deleted | String.t()

  @type t :: %__MODULE__{
          rows: %{optional(cache_key()) => row()},
          entity_group_ids: %{optional(String.t()) => MapSet.t(String.t())},
          entity_group_entities: %{optional(String.t()) => String.t()}
        }

  defstruct rows: %{}, entity_group_ids: %{}, entity_group_entities: %{}

  @doc "An empty overlay."
  @spec empty() :: t()
  def empty, do: %Overlay{}

  @doc "Normalizes a caller-supplied overlay; `nil` is the empty overlay."
  @spec normalize(t() | nil) :: t()
  def normalize(nil), do: empty()
  def normalize(%Overlay{} = overlay), do: overlay

  @doc """
  Fetches a planned row, distinguishing a tombstone from an untouched key.
  """
  @spec fetch(t(), cache(), String.t()) :: {:ok, row()} | :error
  def fetch(%Overlay{rows: rows}, cache, id) do
    Map.fetch(rows, {cache, id})
  end

  @doc """
  Returns the groups an entity would have after the overlay is applied.

  The cached entries are the ones `EntityGroupCache` holds for the same
  entity. Any membership id the overlay touches replaces its cached row;
  an untouched entity returns `:error` so the caller reads the cache
  directly.
  """
  @spec entity_groups(t(), String.t(), [map()]) :: {:ok, [String.t()]} | :error
  def entity_groups(%Overlay{} = overlay, entity_id, cached_entries) do
    case Map.fetch(overlay.entity_group_ids, entity_id) do
      :error -> :error
      {:ok, membership_ids} -> {:ok, merged_groups(overlay, membership_ids, cached_entries)}
    end
  end

  defp merged_groups(overlay, membership_ids, cached_entries) do
    cached =
      Enum.reject(cached_entries, fn entry ->
        MapSet.member?(membership_ids, field(entry, :id))
      end)

    (cached ++ Enum.flat_map(membership_ids, &planned_row(overlay, &1)))
    |> Enum.map(&field(&1, :group_id))
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp planned_row(overlay, membership_id) do
    case Map.fetch(overlay.rows, {:entity_groups_by_id, membership_id}) do
      {:ok, %{} = row} -> [row]
      _ -> []
    end
  end

  @doc """
  True when the overlay changes a cache group resolution reads.

  Entity-type entries are carried for the next batch's `subject_type`
  lookup, but they do not move an entity between groups, so a batch whose
  predecessor only recorded types can still commit alongside it.
  """
  @spec group_resolution_affected?(t()) :: boolean()
  def group_resolution_affected?(%Overlay{rows: rows}) do
    Enum.any?(Map.keys(rows), fn
      {:group_members_by_id, _id} -> true
      {:entity_groups_by_id, _id} -> true
      {:relationships_by_id, _id} -> true
      _ -> false
    end)
  end

  @doc "The entity a touched `entityGroup` row belongs to, alive or deleted."
  @spec entity_for_membership(t(), String.t()) :: String.t() | nil
  def entity_for_membership(%Overlay{} = overlay, membership_id) do
    case Map.fetch(overlay.rows, {:entity_groups_by_id, membership_id}) do
      {:ok, %{} = row} -> field(row, :entity_id)
      _ -> Map.get(overlay.entity_group_entities, membership_id)
    end
  end

  @doc "Puts a row or tombstone and maintains the entity-membership projection."
  @spec put(t(), cache_key(), row()) :: t()
  def put(%Overlay{} = overlay, {:entity_groups_by_id, id} = key, %{} = row) do
    overlay = drop_entity_membership(overlay, id)
    overlay = %{overlay | rows: Map.put(overlay.rows, key, row)}
    add_entity_membership(overlay, id, field(row, :entity_id))
  end

  def put(%Overlay{} = overlay, key, value) do
    %{overlay | rows: Map.put(overlay.rows, key, value)}
  end

  @doc "Tombstones an `entityGroup` row and records the entity it belonged to."
  @spec delete_entity_group(t(), String.t(), String.t() | nil) :: t()
  def delete_entity_group(%Overlay{} = overlay, id, entity_id \\ nil) do
    entity_id = entity_id || entity_for_membership(overlay, id)
    overlay = drop_entity_membership(overlay, id)
    overlay = %{overlay | rows: Map.put(overlay.rows, {:entity_groups_by_id, id}, :deleted)}
    add_entity_membership(overlay, id, entity_id)
  end

  @doc "Merges `overlay` over `base`, later rows winning."
  @spec merge(t(), t()) :: t()
  def merge(%Overlay{} = base, %Overlay{} = overlay) do
    rows = Map.merge(base.rows, overlay.rows)
    entities = Map.merge(base.entity_group_entities, overlay.entity_group_entities)

    Enum.reduce(entities, %Overlay{rows: rows}, fn {id, entity_id}, merged ->
      merged = %{
        merged
        | entity_group_entities: Map.put(merged.entity_group_entities, id, entity_id)
      }

      add_entity_membership(merged, id, entity_id)
    end)
  end

  defp drop_entity_membership(%Overlay{} = overlay, id) do
    case entity_for_membership(overlay, id) do
      nil ->
        overlay

      entity_id ->
        ids = Map.get(overlay.entity_group_ids, entity_id, MapSet.new()) |> MapSet.delete(id)

        entity_group_ids =
          if MapSet.size(ids) == 0,
            do: Map.delete(overlay.entity_group_ids, entity_id),
            else: Map.put(overlay.entity_group_ids, entity_id, ids)

        %{
          overlay
          | entity_group_ids: entity_group_ids,
            entity_group_entities: Map.delete(overlay.entity_group_entities, id)
        }
    end
  end

  defp add_entity_membership(overlay, _id, nil), do: overlay

  defp add_entity_membership(%Overlay{} = overlay, id, entity_id) do
    ids = Map.get(overlay.entity_group_ids, entity_id, MapSet.new()) |> MapSet.put(id)

    %{
      overlay
      | entity_group_ids: Map.put(overlay.entity_group_ids, entity_id, ids),
        entity_group_entities: Map.put(overlay.entity_group_entities, id, entity_id)
    }
  end

  defp field(map, key), do: map[key] || map[to_string(key)]
end
