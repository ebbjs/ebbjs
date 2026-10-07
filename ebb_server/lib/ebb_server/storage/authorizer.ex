defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Authorizes validated actions against the #121 permission table.

  Every Update in an Action is checked individually; the first failure
  rejects the whole Action.

  ## Bootstrap

  An actor creating a group has no membership to check against, so the
  `group` put and the actor's own `groupMember` put cannot be authorized
  by the table. Those two — plus the `entityGroup` edge filing an entity
  the same Action creates into the new group — are exempt
  (`PermissionHelper.bootstrap_update?/4`). Everything else in the
  Action is authorized normally, using the permissions the actor grants
  themselves in their own `groupMember` put: while the Action is being
  authorized the actor's new membership is not in the cache yet, so the
  declared permissions stand in for it.

  This is deliberately per-Update rather than a whole-Action
  short-circuit (#246): a third-party `groupMember`, a link edge for an
  unrelated entity, or a patch to an existing entity all fall through
  to the table even when they ride along with a bootstrap.

  ## System entities

  `group`, `groupMember`, `entityGroup` and `relationship` rows carry
  `<type>.<verb>` permissions like user entities:

    - `group` put/patch/delete → `group.create` / `group.update` /
      `group.delete` in the group. A `group` put only passes through the
      bootstrap exemption; minting a group and handing it to somebody
      else is not allowed.
    - `groupMember` put/patch/delete → `groupMember.create` /
      `groupMember.update` / `groupMember.delete` in the target group.
      Adding an actor to a group is `groupMember.create` in that group;
      the bootstrap covers only the acting actor's own membership.
    - `entityGroup` put → the added entity's `<type>.create` in the
      target group: the group(s) the put files the entity into (#121's
      "Add Entity to Group" row), not the entity's whole group set. The
      type is recovered from a same-Action entity put; when the entity is
      not in the Action the system-entity permission
      `entityGroup.create` in the target group applies instead.
      `entityGroup` patch/delete → `entityGroup.update` /
      `entityGroup.delete` in the membership's group: the delete wire
      form drops the entity reference, so the entity's type is not
      available.
    - `relationship` put (always a domain edge; membership is
      `entityGroup`) → the source entity's `<type>.update` in the
      source's group set, where `<type>` is the wire `data.type` field,
      not a resolved source-entity type. That field defaults to the
      source entity name (matching #121) but apps may override it;
      resolving the source entity's true type is #155. `relationship`
      patch/delete → `relationship.update` / `relationship.delete` in the
      edge's source group set.

  ## User entities

  User-entity writes require `<type>.<verb>` in at least one group of
  the entity's group set (union/any-match). A write whose resolved set
  is empty — an unowned entity, or an id that does not exist — is a
  structural rejection (`missing_ownership`), not a permission failure.

  ## Residuals (known limitations)

  `AuthorizationContext` carries no group/entity **existence** signal,
  so two gaps remain. Both are pre-existing and closing them needs an
  existence source plumbed into the authorization context:

    - A bootstrap Action may re-`put` an **existing** group id and
      self-grant permissions:
      `PermissionHelper.bootstrap_group_permissions/2` checks only that
      the Action puts that group id, not that the group is new.
    - A same-Action `entityGroup` put may file an **existing** entity:
      `PermissionHelper.created_subject_ids/1` counts every user-entity
      `put` id as created without checking existence.
  """

  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.Fields
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper

  @typep validated_action :: %{
           id: String.t(),
           actor_id: String.t(),
           hlc: non_neg_integer(),
           updates: [validated_update()]
         }

  @typep validated_update :: %{
           id: String.t(),
           subject_id: String.t(),
           subject_type: String.t(),
           method: atom(),
           data: map() | nil
         }

  @doc """
  Authorizes a list of validated actions.

  Each action must pass authorization checks; the first failure is
  returned and the Action fails as a whole.
  """
  @spec authorize([validated_action()], String.t(), AuthorizationContext.t()) ::
          :ok | {:error, String.t(), String.t()}
  def authorize([], _actor_id, _ctx), do: :ok

  def authorize([action | rest], actor_id, ctx) do
    case authorize_action(action, actor_id, ctx) do
      :ok -> authorize(rest, actor_id, ctx)
      error -> error
    end
  end

  defp authorize_action(action, actor_id, ctx) do
    updates = action.updates

    authz = %{
      intra: PermissionHelper.build_intra_action_context(updates),
      bootstrap: PermissionHelper.bootstrap_group_permissions(updates, actor_id),
      created_ids: PermissionHelper.created_subject_ids(updates),
      created_types: PermissionHelper.created_entity_types(updates),
      ctx: ctx
    }

    check_all_updates(updates, actor_id, authz)
  end

  defp check_all_updates(updates, actor_id, authz) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      result =
        if PermissionHelper.bootstrap_update?(
             update,
             actor_id,
             authz.bootstrap,
             authz.created_ids
           ) do
          :ok
        else
          authorize_update(update, actor_id, authz)
        end

      case result do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp authorize_update(update, actor_id, authz) do
    case update.subject_type do
      "group" -> authorize_group_update(update, actor_id, authz)
      "groupMember" -> authorize_group_member_update(update, actor_id, authz)
      "entityGroup" -> authorize_entity_group_update(update, actor_id, authz)
      "relationship" -> authorize_relationship_update(update, actor_id, authz)
      type -> authorize_user_entity_update(type, update, actor_id, authz)
    end
  end

  defp authorize_group_update(update, actor_id, authz) do
    check_group_permission(
      [update.subject_id],
      actor_id,
      "group",
      permission_for(update.method),
      authz
    )
  end

  defp authorize_group_member_update(update, actor_id, authz) do
    group_ids = system_entity_group_ids(update, "groupMember", authz)

    if group_ids == [] do
      {:error, "not_authorized", "cannot resolve the group for this groupMember"}
    else
      check_group_permission(
        group_ids,
        actor_id,
        "groupMember",
        permission_for(update.method),
        authz
      )
    end
  end

  # Adding an entity to a group is gated by the entity's own
  # `<type>.create` in the target group (#121 "Add Entity to Group"), not
  # by the entity's whole group set. The type comes from a same-Action
  # entity put; when the entity is not in the Action the system-entity
  # permission stands in.
  defp authorize_entity_group_update(%{method: :put} = update, actor_id, authz) do
    entity_id = Fields.get(update.data, "entity_id")

    case Map.get(authz.created_types, entity_id) do
      nil ->
        check_group_permission(
          wire_group_ids(update),
          actor_id,
          "entityGroup",
          "create",
          authz
        )

      type ->
        check_group_permission(wire_group_ids(update), actor_id, type, "create", authz)
    end
  end

  defp authorize_entity_group_update(update, actor_id, authz) do
    check_group_permission(
      system_entity_group_ids(update, "entityGroup", authz),
      actor_id,
      "entityGroup",
      permission_for(update.method),
      authz
    )
  end

  # A relationship is always a domain edge, and is authorized against its
  # source's membership set, never its own `target_id`: an app may hold a
  # domain link to a group entity. Puts carry the source on the wire;
  # patch/delete drop the data, so the by-id index supplies the source.
  defp authorize_relationship_update(%{method: :put} = update, actor_id, authz) do
    source_type = Fields.get(update.data, "type")

    if is_nil(source_type) do
      {:error, "not_authorized", "relationship is missing its source type"}
    else
      check_group_permission(
        relationship_group_ids(update, authz),
        actor_id,
        source_type,
        "update",
        authz
      )
    end
  end

  defp authorize_relationship_update(update, actor_id, authz) do
    check_group_permission(
      relationship_group_ids(update, authz),
      actor_id,
      "relationship",
      permission_for(update.method),
      authz
    )
  end

  defp authorize_user_entity_update(type, update, actor_id, authz) do
    opts = Keyword.put(ctx_to_opts(authz.ctx), :intra_action, authz.intra)

    case EntityIndex.resolve_groups(type, update.subject_id, opts) do
      [] ->
        {:error, "missing_ownership",
         "entity has no group membership; every write must resolve at least one owning group"}

      group_ids ->
        check_group_permission(group_ids, actor_id, type, permission_for(update.method), authz)
    end
  end

  # Union semantics: the actor may hold the permission in any group of
  # the entity's set; the write is indexed into every group separately.
  defp check_group_permission(group_ids, actor_id, type, permission, authz) do
    has_permission =
      group_ids
      |> Enum.reject(&is_nil/1)
      |> Enum.any?(fn group_id ->
        case permissions_for(actor_id, group_id, authz) do
          nil ->
            false

          permissions ->
            PermissionHelper.check_permission(permissions, type, permission)
        end
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "missing required permission"}
    end
  end

  # The actor's declared bootstrap permissions are unioned with the
  # cache: the membership row is written after authorization, so during
  # the bootstrap Action the cache has nothing for the new group.
  defp permissions_for(actor_id, group_id, authz) do
    cached = GroupCache.get_permissions(actor_id, group_id, authz.ctx.group_members_table)
    declared = Map.get(authz.bootstrap, group_id)

    if is_nil(cached) and is_nil(declared) do
      nil
    else
      Enum.uniq((cached || []) ++ (declared || []))
    end
  end

  # When the data envelope carries the group id, prefer it (first-wins);
  # otherwise resolve via the by-id index — required for system-entity
  # deletes, whose wire form drops the data fields.
  defp system_entity_group_ids(%{data: data, subject_id: id}, type, authz) do
    case Fields.get(data, "group_id") do
      nil -> EntityIndex.resolve_groups(type, id, ctx_to_opts(authz.ctx))
      group_id -> [group_id]
    end
  end

  defp wire_group_ids(update), do: [Fields.get(update.data, "group_id")]

  defp relationship_group_ids(update, authz) do
    opts = Keyword.put(ctx_to_opts(authz.ctx), :intra_action, authz.intra)
    EntityIndex.relationship_groups(Fields.get(update.data, "source_id"), update.subject_id, opts)
  end

  defp permission_for(method), do: PermissionHelper.method_to_permission(Atom.to_string(method))

  defp ctx_to_opts(ctx) do
    [
      entity_groups: ctx.entity_groups_table,
      entity_groups_by_id: ctx.entity_groups_by_id_table,
      relationships_by_id: ctx.relationships_by_id_table,
      group_members_by_id: ctx.group_members_by_id_table
    ]
  end
end
