defmodule EbbServer.Storage.PermissionHelper do
  @moduledoc """
  Utility functions for permission checking and the bootstrap exemption.

  ## Row mutations

  The wire names one component per Update; the rule engine was written
  against a whole row. Every function here that reads a row therefore takes
  `EbbServer.Storage.RowMutations` output — one mutation per subject with
  `model`, `kind`, `created?`, `deleted?`, and `data` a
  `%{"fields" => %{field => value}}` map — never a raw Update.

  A platform row's fields live in one atomic component value, so a row read
  is `EbbServer.Storage.SystemComponent.path/3` and the row's kind is the
  folded mutation's `kind`, never its model: all four commit under `ebb`.

  ## Permission subjects

  The subject a check names is the component the write names: a row create
  or delete checks the model, and an update checks every component on the
  wire. Grants match by ancestry
  (`EbbServer.Storage.PermissionHelper.check_permission/3`), so a model
  grant covers its components and `ebb.*` covers `ebb/grant`.

  ## Group bootstrap

  An actor creating a group has no prior membership to authorize against,
  so the Action that creates the group and adds the actor to it is
  partially exempt from the permission table. The exemption is
  **per row**, never whole-Action:

    - the `ebb/group` create for the new group;
    - the acting actor's own `ebb/grant` create in that group, for a row
      the existence index does not already know;
    - an `ebb/membership` create that files an entity the same Action
      creates into that group.

  Everything else in the same Action — third-party grants, link edges,
  writes to existing entities — is authorized against the table as usual,
  using the permissions the actor grants themselves in their own `ebb/grant`
  row (the grant row is not in the cache yet while the Action is being
  authorized).

  The exemption applies only to entities the Action is **creating**
  (`created?: true`, which the fold derives from an explicit `create`).
  A group qualifies only when the existence index does not already know
  its id, the `ebb/grant` exemption covers only row ids the index does
  not know, and the `ebb/membership` exemption covers only entities the
  Action is actually creating. Creating a committed group, a committed
  membership row or a committed entity is idempotent on the wire and
  still falls through to the permission table, and the actor's declared
  permissions are never unioned into the membership checks for existing
  entities.
  """

  alias EbbServer.Storage.{RowMutations, SystemComponent}

  @doc """
  Checks if actor has the required permission for `subject`.

  Grants match by ancestry. A grant `<grant_subject>.<verb|*>` covers
  `subject` when the subjects are equal or `subject` is a descendant —
  `note.*` covers `note/body`, while `note/title.*` covers only
  `note/title`. `ebb.*` therefore covers every platform component, and a
  model grant keeps working for components added to that model later.
  """
  @spec check_permission([String.t()], String.t(), String.t()) :: boolean()
  def check_permission(permissions, subject, permission) do
    Enum.any?(permissions, &covers?(&1, subject, permission))
  end

  # A grant names its subject before its last dot, so a subject may itself
  # contain dots or a `/`.
  defp covers?(grant, subject, permission) do
    case grant_parts(grant) do
      {grant_subject, verb} ->
        (verb == permission or verb == "*") and ancestor?(grant_subject, subject)

      :error ->
        false
    end
  end

  defp grant_parts(grant) do
    case String.split(grant, ".") do
      [_verb] -> :error
      parts -> {parts |> Enum.drop(-1) |> Enum.join("."), List.last(parts)}
    end
  end

  defp ancestor?(grant_subject, subject) do
    grant_subject == subject or String.starts_with?(subject, grant_subject <> "/")
  end

  @doc """
  Maps each subject this Action writes to the components the wire names for
  it, in wire order.

  An update is authorized against the components it names, not the row's
  model: `note/body` needs `note/body.update`. A delete names no component
  and a row create names its model, so both are absent here and are handled
  by the caller. A `drop` names its component like any other write — it
  removes a value from that component.
  """
  @spec written_components([map()]) :: %{String.t() => [String.t()]}
  def written_components(updates) do
    updates
    |> Enum.reject(&(&1.method == :delete))
    |> Enum.reduce(%{}, &add_component/2)
  end

  defp add_component(%{subject_id: subject_id, component: component}, acc)
       when is_binary(component) do
    Map.update(acc, subject_id, [component], &Enum.uniq(&1 ++ [component]))
  end

  defp add_component(_update, acc), do: acc

  @doc """
  Returns the groups an actor bootstraps in this Action, mapped to the
  permissions the actor grants themselves in each.

  A group qualifies only when the Action both creates the group and
  creates the acting actor's own `ebb/grant` in it **and** the group
  does not already exist (`exists?` is the authorizer's existence
  predicate, backed by the entity-model cache). Writing a committed
  group again is not a bootstrap: it falls through to the permission table.
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
    |> Enum.filter(&own_grant_created?(&1, actor_id, group_ids))
    |> Map.new(fn mutation ->
      {grant_field(mutation, "group_id"), List.wrap(grant_field(mutation, "permissions"))}
    end)
  end

  defp bootstrapped_group_ids(mutations, exists?) do
    mutations
    |> group_create_ids()
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  defp group_create_ids(mutations) do
    mutations
    |> Enum.filter(&creates_kind?(&1, :group))
    |> Enum.map(& &1.subject_id)
    |> MapSet.new()
  end

  defp own_grant_created?(mutation, actor_id, group_ids) do
    creates_kind?(mutation, :grant) and
      grant_field(mutation, "actor_id") == actor_id and
      MapSet.member?(group_ids, grant_field(mutation, "group_id"))
  end

  @doc """
  Returns the ids of the `ebb/grant` rows the actor bootstraps in this
  Action: the acting actor's own created rows in a group the Action
  creates, restricted to row ids the existence index does not already know.

  Anchors the `ebb/grant` exemption to rows the Action is creating, so
  an existing grant row cannot be re-filed into the new group by
  naming it (#625). Writing an existing row again excludes it here; the
  write is then authorized against the permission table, in the group the
  row already belongs to.
  """
  @spec bootstrap_membership_row_ids([map()], String.t(), (String.t() -> boolean())) ::
          MapSet.t(String.t())
  def bootstrap_membership_row_ids(mutations, actor_id, exists?) do
    group_ids = bootstrapped_group_ids(mutations, exists?)

    mutations
    |> Enum.filter(&own_grant_created?(&1, actor_id, group_ids))
    |> Enum.map(& &1.subject_id)
    |> Enum.reject(exists?)
    |> MapSet.new()
  end

  @doc """
  Returns the ids of the user entities this Action **actually creates**
  (an explicit create for an id the existence index does not already know).

  Anchors a bootstrap `ebb/membership` exemption to entities the Action is
  creating, so the exemption cannot graft an already-existing entity
  into a group the actor is bootstrapping. Re-writing an existing entity
  excludes it here; the membership write is then authorized against the
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

  The `ebb/membership` row carries only `entity_id`, so the authorizer
  recovers the entity's model from the same Action to pick the right
  `<model>.create` permission.
  """
  @spec created_models([map()]) :: %{String.t() => String.t()}
  def created_models(mutations) do
    mutations
    |> Enum.filter(&user_entity_created?/1)
    |> Map.new(fn mutation -> {mutation.subject_id, mutation.model} end)
  end

  # `ebb` is not a model an app declares, so a platform row is never a user
  # entity a permission or membership rule may claim.
  defp user_entity_created?(mutation) do
    mutation.created? and is_nil(Map.get(mutation, :kind))
  end

  @doc """
  Returns true when the row mutation is part of a bootstrap and is
  therefore exempt from the permission table.

  The exemption covers exactly the bootstrap's own writes:

    - `ebb/group` creates for the groups the actor is creating and joining;
    - the acting actor's own `ebb/grant` creates for rows
      `bootstrap_membership_row_ids/3` reports, in those groups;
    - `ebb/membership` creates targeting those groups whose entity the
      Action is creating.

  Every other mutation — third-party grants, writes to an existing
  grant row, link edges, writes to an existing group, entity updates — is
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
      entity_membership_bootstrap_update?(mutation, bootstrap, created_ids)
  end

  defp group_bootstrap_update?(mutation, bootstrap) do
    creates_kind?(mutation, :group) and Map.has_key?(bootstrap, mutation.subject_id)
  end

  defp own_membership_bootstrap_update?(mutation, actor_id, membership_row_ids) do
    creates_kind?(mutation, :grant) and
      grant_field(mutation, "actor_id") == actor_id and
      MapSet.member?(membership_row_ids, mutation.subject_id)
  end

  defp entity_membership_bootstrap_update?(mutation, bootstrap, created_ids) do
    creates_kind?(mutation, :membership) and
      Map.has_key?(bootstrap, membership_field(mutation, "group_id")) and
      MapSet.member?(created_ids, membership_field(mutation, "entity_id"))
  end

  @doc """
  Maps each `ebb/link` row this Action writes to the source entity id its
  atomic value carries.

  Read from the raw Updates rather than the folded row: a delete collapses
  the row in the fold and drops its `data`, while the write's source is the
  delete's only scope when the edge was not stored yet. A handler that
  links an edge and unlinks it again — or a client that creates and then
  removes one — sends the write and the delete in the same Action, and the
  write's `source_id` is the same scope the write was authorized against.
  """
  @spec build_intra_relationship_sources([map()]) :: %{String.t() => String.t()}
  def build_intra_relationship_sources(updates) do
    updates
    |> Enum.filter(&link_source_update?/1)
    |> Enum.reduce(%{}, fn update, acc ->
      # A raw Update carries its own field and the component's value, so the
      # accessor is handed the Update, not a folded row's data.
      case {update.subject_id, SystemComponent.path(update, :link, "source_id")} do
        {rel_id, source_id} when is_binary(rel_id) and is_binary(source_id) ->
          Map.put(acc, rel_id, source_id)

        _ ->
          acc
      end
    end)
  end

  defp link_source_update?(update) do
    update.method in [:merge, :replace] and
      SystemComponent.kind(Map.get(update, :component)) == :link
  end

  @doc """
  Builds an intra-action context map for membership resolution.

  Maps `entity_id` to the list of group ids carried by `ebb/membership`
  rows within the same action. Link rows do not move an entity into a
  group.
  """
  @spec build_intra_action_context([map()]) :: %{String.t() => [String.t()]}
  def build_intra_action_context(mutations) do
    mutations
    |> Enum.filter(&membership_write?/1)
    |> Enum.reduce(%{}, fn mutation, acc ->
      entity_id = membership_field(mutation, "entity_id")
      group_id = membership_field(mutation, "group_id")

      if entity_id && group_id do
        Map.update(acc, entity_id, [group_id], &Enum.sort(Enum.uniq([group_id | &1])))
      else
        acc
      end
    end)
  end

  defp membership_write?(mutation) do
    mutation.kind == :membership and RowMutations.write?(mutation)
  end

  defp creates_kind?(mutation, kind) do
    mutation.kind == kind and mutation.created?
  end

  defp membership_field(mutation, key), do: SystemComponent.path(mutation.data, :membership, key)

  defp grant_field(mutation, key), do: SystemComponent.path(mutation.data, :grant, key)
end
