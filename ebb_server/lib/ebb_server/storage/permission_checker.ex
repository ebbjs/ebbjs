defmodule EbbServer.Storage.PermissionChecker do
  @moduledoc """
  Stateless module for validating and authorizing actions.

  All state comes from ETS lookups via SystemCache functions:
  - get_permissions/2
  - get_entity_group/1
  - get_actor_groups/1
  """

  import Bitwise

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
    cond do
      not is_binary(update["id"]) or update["id"] == "" ->
        {:error, "invalid_structure", "update id must be a non-empty string"}

      not is_binary(update["subject_id"]) or update["subject_id"] == "" ->
        {:error, "invalid_structure", "update subject_id must be a non-empty string"}

      not is_binary(update["subject_type"]) or update["subject_type"] == "" ->
        {:error, "invalid_structure", "update subject_type must be a non-empty string"}

      update["method"] not in ["put", "patch", "delete"] ->
        {:error, "invalid_structure", "update method must be one of: put, patch, delete"}

      not is_map(update["data"]) ->
        {:error, "invalid_structure", "update data must be a map"}

      (update["method"] in ["put", "patch"] and
         update["subject_type"] not in @system_entity_types and
         not is_map(update["data"]["fields"])) or
          (update["method"] == "delete" and
             update["subject_type"] not in @system_entity_types and
             not is_map(update["data"])) ->
        {:error, "invalid_structure",
         "update data must be a well-formed map for put/patch/delete on user entities"}

      true ->
        :ok
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

    if is_group_bootstrap?(updates, actor_id) do
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

  defp is_group_bootstrap?(updates, actor_id) do
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
    case update["subject_type"] do
      "group" ->
        group_id = update["subject_id"]

        case EbbServer.Storage.SystemCache.get_permissions(actor_id, group_id, opts) do
          nil -> {:error, "not_authorized", "actor is not a member of the group"}
          _perms -> :ok
        end

      "groupMember" ->
        group_id =
          get_in(update, ["data", "fields", "group_id", "value"]) ||
            get_in(update, ["data", "group_id"])

        case EbbServer.Storage.SystemCache.get_permissions(actor_id, group_id, opts) do
          nil -> {:error, "not_authorized", "actor is not a member of the target group"}
          _perms -> :ok
        end

      "relationship" ->
        target_id = get_in(update, ["data", "target_id"])

        case EbbServer.Storage.SystemCache.get_permissions(actor_id, target_id, opts) do
          nil -> {:error, "not_authorized", "actor is not a member of the target group"}
          _perms -> :ok
        end
    end
  end

  defp authorize_user_entity_update(update, actor_id, intra_ctx, opts) do
    subject_id = update["subject_id"]
    subject_type = update["subject_type"]

    group_id =
      EbbServer.Storage.SystemCache.get_entity_group(subject_id, opts) ||
        Map.get(intra_ctx, subject_id)

    if group_id == nil do
      {:error, "not_authorized", "entity has no group"}
    else
      case EbbServer.Storage.SystemCache.get_permissions(actor_id, group_id, opts) do
        nil ->
          {:error, "not_authorized", "actor is not a member of the group"}

        permissions ->
          required_permission = method_to_permission(update["method"])
          has_permission = check_permission(permissions, subject_type, required_permission)

          if has_permission,
            do: :ok,
            else: {:error, "not_authorized", "missing required permission"}
      end
    end
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
