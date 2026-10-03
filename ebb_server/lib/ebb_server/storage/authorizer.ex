defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Handles authorization of validated actions.

  Checks group membership, permissions, and handles special cases like
  group bootstrap. This module is stateless and relies on cache lookups.
  """

  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.Fields
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper

  @system_entity_types PermissionHelper.system_entity_types()

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

  Each action must pass authorization checks:
  - Group bootstrap allowed without prior permissions
  - `group` / `groupMember` updates require membership in the entity's group
  - `relationship` updates require membership in the edge's **source** group set
  - User entities require the permission in at least one group of the entity's set;
    an entity with no group set at all is rejected as `missing_ownership`, a
    structural failure distinct from a permission failure
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
    intra_ctx = PermissionHelper.build_intra_action_context(updates)

    if PermissionHelper.group_bootstrap?(updates, actor_id) do
      :ok
    else
      check_all_updates(updates, actor_id, intra_ctx, ctx)
    end
  end

  defp check_all_updates(updates, actor_id, intra_ctx, ctx) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      result =
        case update.subject_type do
          "relationship" ->
            authorize_relationship_update(update, actor_id, intra_ctx, ctx)

          type when type in @system_entity_types ->
            authorize_system_entity_update(update, actor_id, ctx)

          _user_type ->
            authorize_user_entity_update(update, actor_id, intra_ctx, ctx)
        end

      case result do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  # A relationship is authorized against its source's membership set,
  # never its own `target_id`: an app may hold a domain link to a group
  # entity. Puts and patches carry the source on the wire; deletes drop
  # the data, so the by-id index supplies the source instead.
  defp authorize_relationship_update(update, actor_id, intra_ctx, ctx) do
    wire_source_id = Fields.get(update.data, "source_id")
    opts = Keyword.put(ctx_to_opts(ctx), :intra_action, intra_ctx)

    check_any_group_membership(
      actor_id,
      EntityIndex.relationship_groups(wire_source_id, update.subject_id, opts),
      ctx
    )
  end

  defp authorize_system_entity_update(update, actor_id, ctx) do
    check_any_group_membership(actor_id, system_entity_group_ids(update, ctx), ctx)
  end

  # When the data envelope carries the group id, prefer it (first-wins);
  # otherwise resolve via the by-id index — required for system-entity
  # deletes, whose wire form drops the data fields.
  defp system_entity_group_ids(%{subject_type: "group", subject_id: group_id}, _ctx) do
    [group_id]
  end

  defp system_entity_group_ids(%{subject_type: type, data: data, subject_id: id}, ctx) do
    case Fields.get(data, "group_id") do
      nil -> EntityIndex.resolve_groups(type, id, ctx_to_opts(ctx))
      group_id -> [group_id]
    end
  end

  defp check_any_group_membership(actor_id, group_ids, ctx) do
    if Enum.any?(group_ids, fn group_id ->
         GroupCache.get_permissions(actor_id, group_id, ctx.group_members_table) != nil
       end) do
      :ok
    else
      {:error, "not_authorized", "actor is not a member of the group"}
    end
  end

  defp authorize_user_entity_update(update, actor_id, intra_ctx, ctx) do
    opts = Keyword.put(ctx_to_opts(ctx), :intra_action, intra_ctx)

    case EntityIndex.resolve_groups(update.subject_type, update.subject_id, opts) do
      [] ->
        {:error, "missing_ownership",
         "entity has no group membership; a kind: \"member\" edge to at least one group " <>
           "must be part of the same action"}

      group_ids ->
        check_any_group_permission(group_ids, actor_id, update, ctx)
    end
  end

  # Union semantics: the actor may hold the permission in any group of
  # the entity's set; the write is indexed into every group separately.
  defp check_any_group_permission(group_ids, actor_id, update, ctx) do
    required_permission = PermissionHelper.method_to_permission(Atom.to_string(update.method))

    has_permission =
      Enum.any?(group_ids, fn group_id ->
        case GroupCache.get_permissions(actor_id, group_id, ctx.group_members_table) do
          nil ->
            false

          permissions ->
            PermissionHelper.check_permission(
              permissions,
              update.subject_type,
              required_permission
            )
        end
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "missing required permission"}
    end
  end

  defp ctx_to_opts(ctx) do
    [
      relationships: ctx.relationships_table,
      relationships_by_id: ctx.relationships_by_id_table,
      group_members_by_id: ctx.group_members_by_id_table
    ]
  end
end
