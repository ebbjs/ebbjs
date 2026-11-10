defmodule EbbServer.Storage.PermissionHelper do
  @moduledoc """
  Utility functions for permission checking and method-to-permission mapping.

  ## Row mutations

  The wire names one component per Update; the rule engine was written
  against a whole row. Every function here that reads a row therefore takes
  `EbbServer.Storage.RowMutations` output — one mutation per subject with
  `model`, `method: :put | :patch | :delete`, and `data` a
  `%{"fields" => %{field => value}}` map — never a raw Update.

  ## Group bootstrap

  An actor creating a group has no prior membership to authorize against,
  so the Action that creates the group and adds the actor to it is
  partially exempt from the permission table. The exemption is
  **per row**, never whole-Action:

    - the `group` put for the new group;
    - the acting actor's own `groupMember` put in that group, for a row
      the existence index does not already know;
    - an `entityGroup` put that files an entity the same Action `put`s
      into that group.

  Everything else in the same Action — third-party `groupMember`s, link
  edges, patches to existing entities — is authorized against the table
  as usual, using the permissions the actor grants themselves in their
  own `groupMember` put (the membership row is not in the cache yet
  while the Action is being authorized).

  The exemption applies only to entities the Action is **creating**.
  A group qualifies only when the existence index does not already know
  its id, the `groupMember` exemption covers only row ids the index does
  not know, and the `entityGroup` exemption covers only entities the
  Action is actually creating. Re-`put`ting a committed group, a
  committed membership row or a committed entity therefore falls through
  to the permission table, and the actor's declared permissions are
  never unioned into the membership checks for existing entities.
  """

  alias EbbServer.Storage.Fields

  @system_models ["group", "groupMember", "relationship", "entityGroup"]

  @doc """
  Returns the list of system model names.
  """
  @spec system_models() :: [String.t()]
  def system_models, do: @system_models

  @doc """
  Converts an internal row-mutation method to its permission verb.
  """
  @spec method_to_permission(atom()) :: String.t()
  def method_to_permission(:put), do: "create"
  def method_to_permission(:patch), do: "update"
  def method_to_permission(:delete), do: "delete"

  @doc """
  Checks if actor has the required permission.

  Permissions can be exact match (e.g., "todo.create") or wildcard (e.g., "todo.*").
  """
  @spec check_permission([String.t()], String.t(), String.t()) :: boolean()
  def check_permission(permissions, model, permission) do
    required = "#{model}.#{permission}"

    Enum.any?(permissions, fn p ->
      p == required or p == "#{model}.*"
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
  def bootstrap_group_permissions(mutations, actor_id, exists?) do
    group_ids = bootstrapped_group_ids(mutations, exists?)

    mutations
    |> Enum.filter(&own_group_member_put?(&1, actor_id, group_ids))
    |> Map.new(fn mutation ->
      {get_data_field(mutation, "group_id"), List.wrap(get_data_field(mutation, "permissions"))}
    end)
  end

  defp bootstrapped_group_ids(mutations, exists?) do
    mutations
    |> group_put_ids()
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  defp group_put_ids(mutations) do
    mutations
    |> Enum.filter(&put_of?(&1, "group"))
    |> Enum.map(& &1.subject_id)
    |> MapSet.new()
  end

  defp own_group_member_put?(mutation, actor_id, group_ids) do
    put_of?(mutation, "groupMember") and
      get_data_field(mutation, "actor_id") == actor_id and
      MapSet.member?(group_ids, get_data_field(mutation, "group_id"))
  end

  @doc """
  Returns the ids of the `groupMember` rows the actor bootstraps in this
  Action: the acting actor's own puts in a group the Action creates,
  restricted to row ids the existence index does not already know.

  Anchors the `groupMember` exemption to rows the Action is creating, so
  an existing membership row cannot be re-filed into the new group by
  naming it (#625). Re-`put`ting an existing row excludes it here; the
  put is then authorized against the permission table, in the group the
  row already belongs to.
  """
  @spec bootstrap_membership_row_ids([map()], String.t(), (String.t() -> boolean())) ::
          MapSet.t(String.t())
  def bootstrap_membership_row_ids(mutations, actor_id, exists?) do
    group_ids = bootstrapped_group_ids(mutations, exists?)

    mutations
    |> Enum.filter(&own_group_member_put?(&1, actor_id, group_ids))
    |> Enum.map(& &1.subject_id)
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  @doc """
  Returns the ids of the user entities this Action **actually creates**
  (a first write for an id the existence index does not already know).

  Anchors a bootstrap `entityGroup` exemption to entities the Action is
  creating, so the exemption cannot graft an already-existing entity
  into a group the actor is bootstrapping. Re-writing an existing entity
  excludes it here; the membership put is then authorized against the
  permission table.
  """
  @spec created_subject_ids([map()], (String.t() -> boolean())) :: MapSet.t(String.t())
  def created_subject_ids(mutations, exists?) do
    mutations
    |> created_models()
    |> Map.keys()
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  @doc """
  Returns the model of every user entity this Action creates.

  The `entityGroup` row carries only `entity_id`, so the authorizer
  recovers the entity's model from the same Action to pick the right
  `<model>.create` permission.
  """
  @spec created_models([map()]) :: %{String.t() => String.t()}
  def created_models(mutations) do
    mutations
    |> Enum.filter(&user_entity_put?/1)
    |> Map.new(fn mutation -> {mutation.subject_id, mutation.model} end)
  end

  defp user_entity_put?(mutation) do
    mutation.method == :put and mutation.model not in @system_models
  end

  @doc """
  Returns true when the row mutation is part of a bootstrap and is
  therefore exempt from the permission table.

  The exemption covers exactly the bootstrap's own writes:

    - `group` puts for the groups the actor is creating and joining;
    - the acting actor's own `groupMember` puts for rows
      `bootstrap_membership_row_ids/3` reports, in those groups;
    - `entityGroup` puts targeting those groups whose entity the Action
      is creating.

  Every other mutation — third-party memberships, re-puts of an existing
  membership row, link edges, group patches, entity updates — is
  authorized normally.
  """
  @spec bootstrap_update?(
          map(),
          String.t(),
          %{String.t() => [String.t()]},
          MapSet.t(String.t()),
          MapSet.t(String.t())
        ) :: boolean()
  def bootstrap_update?(mutation, actor_id, bootstrap, created_ids, membership_row_ids) do
    group_bootstrap_update?(mutation, bootstrap) or
      own_membership_bootstrap_update?(mutation, actor_id, membership_row_ids) or
      entity_group_bootstrap_update?(mutation, bootstrap, created_ids)
  end

  defp group_bootstrap_update?(mutation, bootstrap) do
    put_of?(mutation, "group") and Map.has_key?(bootstrap, mutation.subject_id)
  end

  defp own_membership_bootstrap_update?(mutation, actor_id, membership_row_ids) do
    put_of?(mutation, "groupMember") and
      get_data_field(mutation, "actor_id") == actor_id and
      MapSet.member?(membership_row_ids, mutation.subject_id)
  end

  defp entity_group_bootstrap_update?(mutation, bootstrap, created_ids) do
    put_of?(mutation, "entityGroup") and
      Map.has_key?(bootstrap, get_data_field(mutation, "group_id")) and
      MapSet.member?(created_ids, get_data_field(mutation, "entity_id"))
  end

  @doc """
  Maps each `relationship` row this Action writes to the source entity id
  its component Updates carry.

  Read from the raw Updates rather than the folded row: a delete collapses
  the row in the fold and drops its `data`, while the put's source is the
  delete's only scope when the edge was not stored yet. A handler that
  links an edge and unlinks it again — or a client that creates and then
  removes one — sends the put and the delete in the same Action, and the
  put's `source_id` is the same scope the put was authorized against.
  """
  @spec build_intra_relationship_sources([map()]) :: %{String.t() => String.t()}
  def build_intra_relationship_sources(updates) do
    updates
    |> Enum.filter(&relationship_source_update?/1)
    |> Enum.reduce(%{}, fn update, acc ->
      # A raw component Update carries its own field name, so the source is
      # the `relationship/source_id` Update's value rather than a row record.
      case {update.subject_id, Fields.component_value(update, "source_id")} do
        {rel_id, source_id} when is_binary(rel_id) and is_binary(source_id) ->
          Map.put(acc, rel_id, source_id)

        _ ->
          acc
      end
    end)
  end

  defp relationship_source_update?(update) do
    update.method in [:merge, :replace] and update.model == "relationship"
  end

  @doc """
  Builds an intra-action context map for membership resolution.

  Maps `entity_id` to the list of group ids carried by `entityGroup`
  rows within the same action. Domain relationship rows do not move an
  entity into a group.
  """
  @spec build_intra_action_context([map()]) :: %{String.t() => [String.t()]}
  def build_intra_action_context(mutations) do
    mutations
    |> Enum.filter(&entity_group_put?/1)
    |> Enum.reduce(%{}, fn mutation, acc ->
      entity_id = get_data_field(mutation, "entity_id")
      group_id = get_data_field(mutation, "group_id")

      if entity_id && group_id do
        Map.update(acc, entity_id, [group_id], &Enum.sort(Enum.uniq([group_id | &1])))
      else
        acc
      end
    end)
  end

  defp entity_group_put?(mutation) do
    mutation.model == "entityGroup" and mutation.method in [:put, :patch]
  end

  defp put_of?(mutation, model) do
    mutation.model == model and mutation.method == :put
  end

  defp get_data_field(mutation, key) do
    Fields.get(mutation.data, key)
  end
end
