defmodule EbbServer.Storage.PermissionHelper do
  @moduledoc """
  Utility functions for permission checking and method-to-permission mapping.

  ## Group bootstrap

  An actor creating a group has no prior membership to authorize against,
  so the Action that creates the group and adds the actor to it is
  partially exempt from the permission table. The exemption is
  **per Update**, never whole-Action:

    - the `group` put for the new group;
    - the acting actor's own `groupMember` put in that group;
    - an `entityGroup` put that files an entity the same Action `put`s
      into that group.

  Everything else in the same Action — third-party `groupMember`s, link
  edges, patches to existing entities — is authorized against the table
  as usual, using the permissions the actor grants themselves in their
  own `groupMember` put (the membership row is not in the cache yet
  while the Action is being authorized).

  The exemption applies only to entities the Action is **creating**.
  A group qualifies only when the existence index does not already know
  its id, and the `entityGroup` exemption covers only entities the
  Action is actually creating. Re-`put`ting a committed group or
  re-filing a committed entity therefore falls through to the
  permission table, and the actor's declared permissions are never
  unioned into the membership checks for existing entities.
  """

  alias EbbServer.Storage.Fields

  @system_entity_types ["group", "groupMember", "relationship", "entityGroup"]
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
  Returns the groups an actor bootstraps in this Action, mapped to the
  permissions the actor grants themselves in each.

  A group qualifies only when the Action both `put`s the group and
  `put`s the acting actor's own `groupMember` in it **and** the group
  does not already exist (`exists?` is the authorizer's existence
  predicate, backed by the entity-type index). Re-`put`ting a committed
  group is not a bootstrap: it falls through to the permission table.
  Creating a group for somebody else is not a bootstrap.

  The returned permissions stand in for the actor's membership until
  the Action is written, so the actor can create the initial entities
  in the group they just created without holding a prior membership.
  """
  @spec bootstrap_group_permissions([map()], String.t(), (String.t() -> boolean())) ::
          %{String.t() => [String.t()]}
  def bootstrap_group_permissions(updates, actor_id, exists?) do
    group_ids =
      updates
      |> group_put_ids()
      |> Enum.reject(exists?)
      |> MapSet.new()

    updates
    |> Enum.filter(&own_group_member_put?(&1, actor_id, group_ids))
    |> Map.new(fn update ->
      {get_data_field(update, "group_id"), List.wrap(get_data_field(update, "permissions"))}
    end)
  end

  defp group_put_ids(updates) do
    updates
    |> Enum.filter(&put_of?(&1, "group"))
    |> Enum.map(&get_subject_id/1)
    |> MapSet.new()
  end

  defp own_group_member_put?(update, actor_id, group_ids) do
    put_of?(update, "groupMember") and
      get_data_field(update, "actor_id") == actor_id and
      MapSet.member?(group_ids, get_data_field(update, "group_id"))
  end

  @doc """
  Returns the ids of the user entities this Action **actually creates**
  (`put` for an id the existence index does not already know).

  Anchors a bootstrap `entityGroup` exemption to entities the Action is
  creating, so the exemption cannot graft an already-existing entity
  into a group the actor is bootstrapping. Re-`put`ting an existing
  entity excludes it here; the membership put is then authorized
  against the permission table.
  """
  @spec created_subject_ids([map()], (String.t() -> boolean())) :: MapSet.t(String.t())
  def created_subject_ids(updates, exists?) do
    updates
    |> created_entity_types()
    |> Map.keys()
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  @doc """
  Returns the type of every user entity this Action creates (`put`).

  The `entityGroup` wire form carries only `entity_id`, so the authorizer
  recovers the entity's type from the same Action to pick the right
  `<type>.create` permission.
  """
  @spec created_entity_types([map()]) :: %{String.t() => String.t()}
  def created_entity_types(updates) do
    updates
    |> Enum.filter(&user_entity_put?/1)
    |> Map.new(fn update -> {get_subject_id(update), get_subject_type(update)} end)
  end

  defp user_entity_put?(update) do
    normalize_method(get_method(update)) == "put" and
      get_subject_type(update) not in @system_entity_types
  end

  @doc """
  Returns true when the update is part of a bootstrap and is therefore
  exempt from the permission table.

  The exemption covers exactly the bootstrap's own writes:

    - `group` puts for the groups the actor is creating and joining;
    - the acting actor's own `groupMember` puts in those groups;
    - `entityGroup` puts targeting those groups whose entity the Action
      is creating.

  Every other update — third-party memberships, link edges, group
  patches, entity updates — is authorized normally.
  """
  @spec bootstrap_update?(map(), String.t(), %{String.t() => [String.t()]}, MapSet.t(String.t())) ::
          boolean()
  def bootstrap_update?(update, actor_id, bootstrap, created_ids) do
    group_bootstrap_update?(update, bootstrap) or
      own_membership_bootstrap_update?(update, actor_id, bootstrap) or
      entity_group_bootstrap_update?(update, bootstrap, created_ids)
  end

  defp group_bootstrap_update?(update, bootstrap) do
    put_of?(update, "group") and Map.has_key?(bootstrap, get_subject_id(update))
  end

  defp own_membership_bootstrap_update?(update, actor_id, bootstrap) do
    put_of?(update, "groupMember") and
      get_data_field(update, "actor_id") == actor_id and
      Map.has_key?(bootstrap, get_data_field(update, "group_id"))
  end

  defp entity_group_bootstrap_update?(update, bootstrap, created_ids) do
    put_of?(update, "entityGroup") and
      Map.has_key?(bootstrap, get_data_field(update, "group_id")) and
      MapSet.member?(created_ids, get_data_field(update, "entity_id"))
  end

  @doc """
  Builds an intra-action context map for membership resolution.

  Maps `entity_id` to the list of group ids carried by `entityGroup`
  puts within the same action. Domain relationship puts do not move an
  entity into a group.
  """
  @spec build_intra_action_context([map()]) :: %{String.t() => [String.t()]}
  def build_intra_action_context(updates) do
    updates
    |> Enum.filter(&put_of?(&1, "entityGroup"))
    |> Enum.reduce(%{}, fn update, acc ->
      entity_id = get_data_field(update, "entity_id")
      group_id = get_data_field(update, "group_id")

      if entity_id && group_id do
        Map.update(acc, entity_id, [group_id], &Enum.sort(Enum.uniq([group_id | &1])))
      else
        acc
      end
    end)
  end

  defp get_subject_type(map) do
    Map.get(map, "subject_type") || Map.get(map, :subject_type)
  end

  defp put_of?(update, type) do
    get_subject_type(update) == type and normalize_method(get_method(update)) == "put"
  end

  defp get_method(map) do
    Map.get(map, "method") || Map.get(map, :method)
  end

  defp normalize_method(method) when is_binary(method), do: method
  defp normalize_method(method) when is_atom(method), do: Atom.to_string(method)
  defp normalize_method(_), do: nil

  defp get_subject_id(map) do
    Map.get(map, "subject_id") || Map.get(map, :subject_id)
  end

  defp get_data_field(map, key) do
    data = Map.get(map, "data") || Map.get(map, :data)

    if is_map(data) do
      Fields.get(data, key)
    end
  end
end
