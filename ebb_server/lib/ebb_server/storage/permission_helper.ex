defmodule EbbServer.Storage.PermissionHelper do
  @moduledoc """
  Utility functions for permission checking and method-to-permission mapping.
  """

  @system_entity_types ["group", "groupMember", "relationship"]
  @method_atoms %{"put" => :put, "patch" => :patch, "delete" => :delete}

  @doc """
  Returns the list of system entity type names.
  """
  @spec system_entity_types() :: [String.t()]
  def system_entity_types, do: @system_entity_types

  @doc """
  Returns the map of method strings to method atoms.
  """
  @spec method_atoms() :: %{String.t() => atom()}
  def method_atoms, do: @method_atoms

  @doc """
  Converts HTTP method to permission name.
  """
  @spec method_to_permission(String.t()) :: String.t()
  def method_to_permission("put"), do: "create"
  def method_to_permission("patch"), do: "update"
  def method_to_permission("delete"), do: "delete"

  @doc """
  Checks if actor has the required permission.

  Permissions can be exact match (e.g., "todo.create") or wildcard (e.g., "todo.*").
  """
  @spec check_permission([String.t()], String.t(), String.t()) :: boolean()
  def check_permission(permissions, type, permission) do
    required = "#{type}.#{permission}"

    Enum.any?(permissions, fn p ->
      p == required or p == "#{type}.*"
    end)
  end

  @doc """
  Checks if the given updates represent a valid group bootstrap.

  A valid group bootstrap requires:
  1. At least one group put
  2. A groupMember put for the actor in one of those groups
  3. A relationship put targeting one of those groups
  """
  @spec group_bootstrap?([map()], String.t()) :: boolean()
  def group_bootstrap?(updates, actor_id) do
    group_ids =
      updates
      |> Enum.filter(fn u ->
        get_subject_type(u) == "group" and normalize_method(get_method(u)) == "put"
      end)
      |> Enum.map(fn u -> get_subject_id(u) end)
      |> MapSet.new()

    has_matching_member =
      Enum.any?(updates, fn u ->
        get_subject_type(u) == "groupMember" and
          normalize_method(get_method(u)) == "put" and
          get_data_field(u, "actor_id") == actor_id and
          MapSet.member?(group_ids, get_data_field(u, "group_id"))
      end)

    has_matching_relationship =
      Enum.any?(updates, fn u ->
        get_subject_type(u) == "relationship" and
          normalize_method(get_method(u)) == "put" and
          MapSet.member?(group_ids, get_data_field(u, "target_id"))
      end)

    MapSet.size(group_ids) > 0 and has_matching_member and has_matching_relationship
  end

  defp get_subject_type(map) do
    Map.get(map, "subject_type") || Map.get(map, :subject_type)
  end

  defp get_method(map) do
    Map.get(map, "method") || Map.get(map, :method)
  end

  defp normalize_method(m) when is_binary(m), do: m
  defp normalize_method(m) when is_atom(m), do: Atom.to_string(m)
  defp normalize_method(_), do: nil

  defp get_subject_id(map) do
    Map.get(map, "subject_id") || Map.get(map, :subject_id)
  end

  defp get_data_field(map, key) do
    data = Map.get(map, "data") || Map.get(map, :data)

    if is_map(data) do
      atom_key = String.to_existing_atom(key)
      Map.get(data, key) || Map.get(data, atom_key)
    end
  end

  @doc """
  Builds an intra-action context map for relationship resolution.

  Maps source_id to target_id for relationship puts within the same action.
  This allows new entities to be linked in a single action.
  """
  @spec build_intra_action_context([map()]) :: %{String.t() => String.t()}
  def build_intra_action_context(updates) do
    updates
    |> Enum.filter(fn u ->
      get_subject_type(u) == "relationship" and normalize_method(get_method(u)) == "put"
    end)
    |> Enum.reduce(%{}, fn u, acc ->
      data = Map.get(u, "data") || Map.get(u, :data)

      source_id =
        if is_map(data) do
          Map.get(data, "source_id") || Map.get(data, :source_id)
        end

      target_id =
        if is_map(data) do
          Map.get(data, "target_id") || Map.get(data, :target_id)
        end

      if source_id && target_id, do: Map.put(acc, source_id, target_id), else: acc
    end)
  end
end
