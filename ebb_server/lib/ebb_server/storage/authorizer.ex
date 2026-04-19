defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Handles authorization of validated actions.

  Checks group membership, permissions, and handles special cases like
  group bootstrap. This module is stateless and relies on cache lookups.
  """

  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper
  alias EbbServer.Storage.RelationshipCache

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
  - System entities (group, groupMember, relationship) require group membership
  - User entities require group permissions
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

  defp authorize_system_entity_update(update, actor_id, ctx) do
    group_id = get_group_id_for_update(update)
    check_group_membership(actor_id, group_id, ctx)
  end

  defp get_group_id_for_update(%{subject_type: "group", subject_id: group_id}) do
    group_id
  end

  defp get_group_id_for_update(%{subject_type: "groupMember", data: data}) do
    raw_value = get_in(data, ["fields", "group_id", "value"]) || get_in(data, ["group_id"])
    unwrap_value(raw_value)
  end

  defp get_group_id_for_update(%{subject_type: "relationship", data: data}) do
    raw_value = get_in(data, ["target_id"])
    unwrap_value(raw_value)
  end

  defp check_group_membership(_actor_id, nil, _ctx) do
    {:error, "not_authorized", "actor is not a member of the group"}
  end

  defp check_group_membership(actor_id, group_id, ctx) do
    case GroupCache.get_permissions(actor_id, group_id, ctx.group_members_table) do
      nil -> {:error, "not_authorized", "actor is not a member of the group"}
      _perms -> :ok
    end
  end

  defp authorize_user_entity_update(update, actor_id, intra_ctx, ctx) do
    subject_id = update.subject_id
    subject_type = update.subject_type

    group_id =
      RelationshipCache.get_entity_group(subject_id, ctx.relationships_table) ||
        Map.get(intra_ctx, subject_id)

    if group_id do
      check_group_permissions(group_id, actor_id, subject_type, update.method, ctx)
    else
      check_actor_can_create_entity(actor_id, subject_type, update.method, ctx)
    end
  end

  defp check_group_permissions(group_id, actor_id, subject_type, method, ctx) do
    with {:ok, _} <- ensure_group(group_id),
         {:ok, permissions} <- fetch_permissions(actor_id, group_id, ctx),
         :ok <-
           ensure_has_permission(
             permissions,
             subject_type,
             PermissionHelper.method_to_permission(Atom.to_string(method))
           ) do
      :ok
    else
      {:error, reason, details} -> {:error, reason, details}
    end
  end

  defp check_actor_can_create_entity(actor_id, subject_type, method, ctx) do
    required_permission = PermissionHelper.method_to_permission(Atom.to_string(method))

    actor_groups = GroupCache.get_actor_groups(actor_id, ctx.group_members_table)

    has_permission =
      Enum.any?(actor_groups, fn group_entry ->
        %{group_id: group_id, permissions: permissions} = group_entry

        group_id != nil and
          PermissionHelper.check_permission(permissions, subject_type, required_permission)
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "actor has no group with required permission"}
    end
  end

  defp ensure_group(nil), do: {:error, "not_authorized", "entity has no group"}
  defp ensure_group(_), do: {:ok, :group_found}

  defp fetch_permissions(actor_id, group_id, ctx) do
    case GroupCache.get_permissions(actor_id, group_id, ctx.group_members_table) do
      nil -> {:error, "not_authorized", "actor is not a member of the group"}
      permissions -> {:ok, permissions}
    end
  end

  defp ensure_has_permission(permissions, subject_type, required_permission) do
    if PermissionHelper.check_permission(permissions, subject_type, required_permission),
      do: :ok,
      else: {:error, "not_authorized", "missing required permission"}
  end

  defp unwrap_value(%{"value" => value}), do: value
  defp unwrap_value(nil), do: nil
  defp unwrap_value(value), do: value
end
