defmodule EbbServer.Storage.PermissionChecker do
  @moduledoc """
  Stateless module for validating and authorizing actions.

  All state comes from ETS lookups via SystemCache functions:
  - get_permissions/2
  - get_entity_group/1
  - get_actor_groups/1
  """

  import Bitwise

  alias EbbServer.Storage.SystemCache

  @type raw_action :: %{String.t() => term()}
  @type raw_update :: %{String.t() => term()}

  @type validated_action :: %{
          id: String.t(),
          actor_id: String.t(),
          hlc: non_neg_integer(),
          updates: [validated_update()]
        }

  @type validated_update :: %{
          id: String.t(),
          subject_id: String.t(),
          subject_type: String.t(),
          method: :put | :patch | :delete,
          data: map() | nil
        }

  @type rejection :: %{
          action_id: String.t(),
          reason: String.t(),
          details: String.t() | nil
        }

  @system_entity_types ["group", "groupMember", "relationship"]
  @method_atoms %{"put" => :put, "patch" => :patch, "delete" => :delete}

  @spec validate_and_authorize([raw_action()], String.t(), keyword()) ::
          {accepted :: [validated_action()], rejected :: [rejection()]}
  def validate_and_authorize(actions, actor_id, opts \\ []) do
    Enum.reduce(actions, {[], []}, fn action, {accepted, rejected} ->
      case run_checks(action, actor_id, opts) do
        {:ok, validated} ->
          {[validated | accepted], rejected}

        {:error, reason, details} ->
          rejection = %{action_id: action["id"], reason: reason, details: details}
          {accepted, [rejection | rejected]}
      end
    end)
    |> then(fn {accepted, rejected} -> {Enum.reverse(accepted), Enum.reverse(rejected)} end)
  end

  defp run_checks(action, actor_id, opts) do
    with :ok <- validate_structure(action),
         :ok <- validate_actor(action, actor_id),
         :ok <- validate_hlc(action, opts),
         :ok <- authorize_updates(action, actor_id, opts) do
      {:ok, to_validated_action(action)}
    end
  end

  @spec validate_structure(raw_action()) :: :ok | {:error, String.t(), String.t()}
  def validate_structure(action) do
    cond do
      not is_binary(action["id"]) or action["id"] == "" ->
        {:error, "invalid_structure", "action id must be a non-empty string"}

      not is_binary(action["actor_id"]) or action["actor_id"] == "" ->
        {:error, "invalid_structure", "action actor_id must be a non-empty string"}

      normalize_hlc(action["hlc"]) == nil ->
        {:error, "invalid_structure", "action hlc must be a positive integer"}

      not is_list(action["updates"]) or action["updates"] == [] ->
        {:error, "invalid_structure", "action updates must be a non-empty list"}

      true ->
        validate_updates_structure(action["updates"])
    end
  end

  defp validate_updates_structure(updates) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      case validate_update_structure(update) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp validate_update_structure(update) do
    with :ok <- validate_update_id(update["id"]),
         :ok <- validate_update_subject_id(update["subject_id"]),
         :ok <- validate_update_subject_type(update["subject_type"]),
         :ok <- validate_update_method(update["method"]) do
      validate_update_data(update)
    end
  end

  defp validate_update_id(id) do
    if is_binary(id) and id != "",
      do: :ok,
      else: {:error, "invalid_structure", "update id must be a non-empty string"}
  end

  defp validate_update_subject_id(subject_id) do
    if is_binary(subject_id) and subject_id != "",
      do: :ok,
      else: {:error, "invalid_structure", "update subject_id must be a non-empty string"}
  end

  defp validate_update_subject_type(subject_type) do
    if is_binary(subject_type) and subject_type != "",
      do: :ok,
      else: {:error, "invalid_structure", "update subject_type must be a non-empty string"}
  end

  defp validate_update_method(method) do
    if method in ["put", "patch", "delete"],
      do: :ok,
      else: {:error, "invalid_structure", "update method must be one of: put, patch, delete"}
  end

  defp validate_update_data(update) do
    if is_map(update["data"]) and well_formed_data?(update),
      do: :ok,
      else:
        {:error, "invalid_structure",
         "update data must be a well-formed map for put/patch/delete on user entities"}
  end

  defp well_formed_data?(update) do
    subject_type = update["subject_type"]
    method = update["method"]
    data = update["data"]

    if subject_type in @system_entity_types do
      true
    else
      case method do
        m when m in ["put", "patch"] -> is_map(data["fields"])
        "delete" -> true
        _ -> false
      end
    end
  end

  @spec validate_actor(raw_action(), String.t()) :: :ok | {:error, String.t(), String.t()}
  def validate_actor(action, actor_id) do
    if action["actor_id"] == actor_id do
      :ok
    else
      {:error, "actor_mismatch", "action actor_id does not match authenticated actor"}
    end
  end

  @spec validate_hlc(raw_action(), keyword()) :: :ok | {:error, String.t(), String.t()}
  def validate_hlc(action, opts \\ []) do
    hlc = normalize_hlc(action["hlc"])

    cond do
      hlc == nil ->
        {:error, "invalid_hlc", "hlc must be a positive integer"}

      hlc <= 0 ->
        {:error, "invalid_hlc", "hlc must be a positive integer"}

      true ->
        logical_time_ms = hlc >>> 16
        now = Keyword.get(opts, :now_ms, System.os_time(:millisecond))

        cond do
          logical_time_ms > now + 120_000 ->
            {:error, "hlc_future_drift", "logical time is more than 120s in the future"}

          logical_time_ms < now - 86_400_000 ->
            {:error, "hlc_stale", "logical time is more than 24h in the past"}

          true ->
            :ok
        end
    end
  end

  defp normalize_hlc(hlc) when is_integer(hlc), do: hlc

  defp normalize_hlc(hlc) when is_binary(hlc) do
    case Integer.parse(hlc) do
      {int, ""} when int > 0 -> int
      _ -> nil
    end
  end

  defp normalize_hlc(_), do: nil

  @spec authorize_updates(raw_action(), String.t(), keyword()) ::
          :ok | {:error, String.t(), String.t()}
  def authorize_updates(action, actor_id, opts \\ []) do
    updates = action["updates"]
    intra_ctx = build_intra_action_context(updates)

    if group_bootstrap?(updates, actor_id) do
      :ok
    else
      check_all_updates(updates, actor_id, intra_ctx, opts)
    end
  end

  defp build_intra_action_context(updates) do
    updates
    |> Enum.filter(fn u -> u["subject_type"] == "relationship" and u["method"] == "put" end)
    |> Enum.reduce(%{}, fn u, acc ->
      source_id = get_in(u, ["data", "source_id"])
      target_id = get_in(u, ["data", "target_id"])
      if source_id && target_id, do: Map.put(acc, source_id, target_id), else: acc
    end)
  end

  defp group_bootstrap?(updates, actor_id) do
    group_ids =
      updates
      |> Enum.filter(fn u -> u["subject_type"] == "group" and u["method"] == "put" end)
      |> Enum.map(fn u -> u["subject_id"] end)
      |> MapSet.new()

    has_matching_member =
      Enum.any?(updates, fn u ->
        u["subject_type"] == "groupMember" and
          u["method"] == "put" and
          get_in(u, ["data", "actor_id"]) == actor_id and
          MapSet.member?(group_ids, get_in(u, ["data", "group_id"]))
      end)

    has_matching_relationship =
      Enum.any?(updates, fn u ->
        u["subject_type"] == "relationship" and
          u["method"] == "put" and
          MapSet.member?(group_ids, get_in(u, ["data", "target_id"]))
      end)

    MapSet.size(group_ids) > 0 and has_matching_member and has_matching_relationship
  end

  defp check_all_updates(updates, actor_id, intra_ctx, opts) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      result =
        case update["subject_type"] do
          type when type in @system_entity_types ->
            authorize_system_entity_update(update, actor_id, intra_ctx, opts)

          _user_type ->
            authorize_user_entity_update(update, actor_id, intra_ctx, opts)
        end

      case result do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp authorize_system_entity_update(update, actor_id, _intra_ctx, opts) do
    group_id = get_group_id_for_update(update)
    check_group_membership(actor_id, group_id, opts)
  end

  defp get_group_id_for_update(%{"subject_type" => "group", "subject_id" => group_id}) do
    group_id
  end

  defp get_group_id_for_update(%{"subject_type" => "groupMember", "data" => data}) do
    get_in(data, ["fields", "group_id", "value"]) || get_in(data, ["group_id"])
  end

  defp get_group_id_for_update(%{"subject_type" => "relationship", "data" => data}) do
    get_in(data, ["target_id"])
  end

  defp check_group_membership(_actor_id, nil, _opts) do
    {:error, "not_authorized", "actor is not a member of the group"}
  end

  defp check_group_membership(actor_id, group_id, opts) do
    table =
      Keyword.get(opts, :group_members) || Application.get_env(:ebb_server, :group_members) ||
        :ebb_group_members

    case SystemCache.get_permissions(actor_id, group_id, table) do
      nil -> {:error, "not_authorized", "actor is not a member of the group"}
      _perms -> :ok
    end
  end

  defp authorize_user_entity_update(update, actor_id, intra_ctx, opts) do
    subject_id = update["subject_id"]
    subject_type = update["subject_type"]

    rel_table =
      Keyword.get(opts, :relationships) || Application.get_env(:ebb_server, :relationships) ||
        :ebb_relationships

    group_id =
      SystemCache.get_entity_group(subject_id, rel_table) ||
        Map.get(intra_ctx, subject_id)

    if group_id do
      check_group_permissions(group_id, actor_id, subject_type, update["method"], opts)
    else
      check_actor_can_create_entity(actor_id, subject_type, update["method"], opts)
    end
  end

  defp check_group_permissions(group_id, actor_id, subject_type, method, opts) do
    with {:ok, _} <- ensure_group(group_id),
         {:ok, permissions} <- fetch_permissions(actor_id, group_id, opts),
         :ok <-
           ensure_has_permission(
             permissions,
             subject_type,
             method_to_permission(method)
           ) do
      :ok
    else
      {:error, reason, details} -> {:error, reason, details}
    end
  end

  defp check_actor_can_create_entity(actor_id, subject_type, method, opts) do
    required_permission = method_to_permission(method)

    # Get actor's groups - use default table if not specified in opts
    table =
      Keyword.get(opts, :group_members) || Application.get_env(:ebb_server, :group_members) ||
        :ebb_group_members

    actor_groups = SystemCache.get_actor_groups(actor_id, table)

    has_permission =
      Enum.any?(actor_groups, fn group_entry ->
        %{group_id: group_id, permissions: permissions} = group_entry
        group_id != nil and check_permission(permissions, subject_type, required_permission)
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "actor has no group with required permission"}
    end
  end

  defp ensure_group(nil), do: {:error, "not_authorized", "entity has no group"}
  defp ensure_group(_), do: {:ok, :group_found}

  defp fetch_permissions(actor_id, group_id, opts) do
    table =
      Keyword.get(opts, :group_members) || Application.get_env(:ebb_server, :group_members) ||
        :ebb_group_members

    case SystemCache.get_permissions(actor_id, group_id, table) do
      nil -> {:error, "not_authorized", "actor is not a member of the group"}
      permissions -> {:ok, permissions}
    end
  end

  defp ensure_has_permission(permissions, subject_type, required_permission) do
    if check_permission(permissions, subject_type, required_permission),
      do: :ok,
      else: {:error, "not_authorized", "missing required permission"}
  end

  defp method_to_permission("put"), do: "create"
  defp method_to_permission("patch"), do: "update"
  defp method_to_permission("delete"), do: "delete"

  defp check_permission(permissions, type, permission) do
    Enum.any?(permissions, fn p ->
      p == "#{type}.#{permission}" or p == "#{type}.*"
    end)
  end

  defp to_validated_action(action) do
    %{
      id: action["id"],
      actor_id: action["actor_id"],
      hlc: normalize_hlc(action["hlc"]),
      updates: Enum.map(action["updates"], &to_validated_update/1)
    }
  end

  defp to_validated_update(update) do
    %{
      id: update["id"],
      subject_id: update["subject_id"],
      subject_type: update["subject_type"],
      method: Map.fetch!(@method_atoms, update["method"]),
      data: update["data"]
    }
  end
end
