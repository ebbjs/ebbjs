defmodule EbbServer.Storage.CacheMutationPlanner.Overlay do
  @moduledoc """
  The planned future state of the system caches, plus the projections
  `EntityScope` needs to resolve a successor batch against it.

  `rows` stores one entry per touched `{cache, id}`. `membership_ids`
  inverts the `membership` rows so an entity's groups can be resolved
  without scanning the whole overlay, and `group_entity_ids` keeps
  the entity a deleted membership belonged to. Treat the struct as
  opaque: read it through `fetch/3`, `memberships/3`, and
  `entity_for_membership/2`.
  """

  alias __MODULE__, as: Overlay

  @type cache ::
          :grants_by_id
          | :memberships_by_id
          | :relationships_by_id
          | :entity_models
          | :group_apps

  @type cache_key :: {cache(), String.t()}
  @type row :: map() | :deleted | String.t() | nil

  @type t :: %__MODULE__{
          rows: %{optional(cache_key()) => row()},
          membership_ids: %{optional(String.t()) => MapSet.t(String.t())},
          group_entity_ids: %{optional(String.t()) => String.t()}
        }

  defstruct rows: %{}, membership_ids: %{}, group_entity_ids: %{}

  @spec empty() :: t()
  def empty, do: %Overlay{}

  @spec normalize(t() | nil) :: t()
  def normalize(nil), do: empty()
  def normalize(%Overlay{} = overlay), do: overlay

  @spec fetch(t(), cache(), String.t()) :: {:ok, row()} | :error
  def fetch(%Overlay{rows: rows}, cache, id) do
    Map.fetch(rows, {cache, id})
  end

  @spec memberships(t(), String.t(), [map()]) :: {:ok, [String.t()]} | :error
  def memberships(%Overlay{} = overlay, entity_id, cached_entries) do
    case Map.fetch(overlay.membership_ids, entity_id) do
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
    case Map.fetch(overlay.rows, {:memberships_by_id, membership_id}) do
      {:ok, %{} = row} -> [row]
      _ -> []
    end
  end

  @doc """
  True when the overlay changes a cache group resolution reads.

  Entity-type entries are carried for the next batch's committed-model
  lookup, but they do not move an entity between groups, so a batch whose
  predecessor only recorded models can still commit alongside it.
  """
  @spec group_resolution_affected?(t()) :: boolean()
  def group_resolution_affected?(%Overlay{rows: rows}) do
    Enum.any?(Map.keys(rows), fn
      {:grants_by_id, _id} -> true
      {:memberships_by_id, _id} -> true
      {:relationships_by_id, _id} -> true
      _ -> false
    end)
  end

  @spec entity_for_membership(t(), String.t()) :: String.t() | nil
  def entity_for_membership(%Overlay{} = overlay, membership_id) do
    case Map.fetch(overlay.rows, {:memberships_by_id, membership_id}) do
      {:ok, %{} = row} -> field(row, :entity_id)
      _ -> Map.get(overlay.group_entity_ids, membership_id)
    end
  end

  @spec put(t(), cache_key(), row()) :: t()
  def put(%Overlay{} = overlay, {:memberships_by_id, id} = key, %{} = row) do
    overlay = drop_entity_membership(overlay, id)
    overlay = %{overlay | rows: Map.put(overlay.rows, key, row)}
    add_entity_membership(overlay, id, field(row, :entity_id))
  end

  def put(%Overlay{} = overlay, key, value) do
    %{overlay | rows: Map.put(overlay.rows, key, value)}
  end

  @spec delete_membership(t(), String.t(), String.t() | nil) :: t()
  def delete_membership(%Overlay{} = overlay, id, entity_id \\ nil) do
    entity_id = entity_id || entity_for_membership(overlay, id)
    overlay = drop_entity_membership(overlay, id)
    overlay = %{overlay | rows: Map.put(overlay.rows, {:memberships_by_id, id}, :deleted)}
    add_entity_membership(overlay, id, entity_id)
  end

  @spec merge(t(), t()) :: t()
  def merge(%Overlay{} = base, %Overlay{} = overlay) do
    rows = Map.merge(base.rows, overlay.rows)
    entities = Map.merge(base.group_entity_ids, overlay.group_entity_ids)

    Enum.reduce(entities, %Overlay{rows: rows}, fn {id, entity_id}, merged ->
      merged = %{
        merged
        | group_entity_ids: Map.put(merged.group_entity_ids, id, entity_id)
      }

      add_entity_membership(merged, id, entity_id)
    end)
  end

  defp drop_entity_membership(%Overlay{} = overlay, id) do
    case entity_for_membership(overlay, id) do
      nil ->
        overlay

      entity_id ->
        ids = Map.get(overlay.membership_ids, entity_id, MapSet.new()) |> MapSet.delete(id)

        membership_ids =
          if MapSet.size(ids) == 0,
            do: Map.delete(overlay.membership_ids, entity_id),
            else: Map.put(overlay.membership_ids, entity_id, ids)

        %{
          overlay
          | membership_ids: membership_ids,
            group_entity_ids: Map.delete(overlay.group_entity_ids, id)
        }
    end
  end

  defp add_entity_membership(overlay, _id, nil), do: overlay

  defp add_entity_membership(%Overlay{} = overlay, id, entity_id) do
    ids = Map.get(overlay.membership_ids, entity_id, MapSet.new()) |> MapSet.put(id)

    %{
      overlay
      | membership_ids: Map.put(overlay.membership_ids, entity_id, ids),
        group_entity_ids: Map.put(overlay.group_entity_ids, id, entity_id)
    }
  end

  defp field(map, key), do: map[key] || map[to_string(key)]
end
