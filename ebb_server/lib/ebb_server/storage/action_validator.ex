defmodule EbbServer.Storage.ActionValidator do
  @moduledoc """
  Validates action structure, actor, and HLC timestamp.

  This module is stateless and focuses purely on validation and transformation.
  It does NOT perform authorization - that's handled by the Authorizer.
  """

  import Bitwise
  alias EbbServer.Storage.PermissionHelper

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

  @system_entity_types PermissionHelper.system_entity_types()
  @method_atoms PermissionHelper.method_atoms()

  @future_drift_limit_ms 120_000
  @stale_limit_ms 86_400_000

  @doc """
  Validates a list of raw actions, returning validated actions and rejections.

  Each action is validated for:
  - Structure (valid fields, non-empty values)
  - Actor (actor_id matches the authenticated actor)
  - HLC (valid timestamp within bounds)
  """
  @spec validate([raw_action()], String.t(), keyword()) ::
          {accepted :: [validated_action()], rejected :: [rejection()]}
  def validate(actions, actor_id, opts \\ []) do
    now_ms = Keyword.get(opts, :now_ms, System.os_time(:millisecond))

    Enum.reduce(actions, {[], []}, fn action, {accepted, rejected} ->
      case run_validation(action, actor_id, now_ms) do
        {:ok, validated} ->
          {[validated | accepted], rejected}

        {:error, reason, details} ->
          rejection = %{action_id: action["id"], reason: reason, details: details}
          {accepted, [rejection | rejected]}
      end
    end)
    |> then(fn {accepted, rejected} -> {Enum.reverse(accepted), Enum.reverse(rejected)} end)
  end

  defp run_validation(action, actor_id, now_ms) do
    with :ok <- validate_structure(action),
         :ok <- validate_actor(action, actor_id),
         :ok <- validate_hlc(action, now_ms) do
      {:ok, to_validated_action(action)}
    end
  end

  @doc """
  Validates the structure of a raw action.

  Checks that:
  - id is a non-empty string
  - actor_id is a non-empty string
  - hlc is a positive integer (or parsable string)
  - updates is a non-empty list
  - each update has valid id, subject_id, subject_type, method, and data
  """
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

  @doc """
  Validates that the action's actor_id matches the authenticated actor.
  """
  @spec validate_actor(raw_action(), String.t()) :: :ok | {:error, String.t(), String.t()}
  def validate_actor(action, actor_id) do
    if action["actor_id"] == actor_id do
      :ok
    else
      {:error, "actor_mismatch", "action actor_id does not match authenticated actor"}
    end
  end

  @doc """
  Validates the HLC timestamp.

  Checks that:
  - hlc is a positive integer
  - logical time is not more than 120s in the future
  - logical time is not more than 24h in the past
  """
  @spec validate_hlc(raw_action(), keyword() | non_neg_integer()) ::
          :ok | {:error, String.t(), String.t()}
  def validate_hlc(action, opts \\ [])

  def validate_hlc(action, opts) when is_list(opts) do
    now_ms = Keyword.get(opts, :now_ms, System.os_time(:millisecond))
    validate_hlc(action, now_ms)
  end

  def validate_hlc(action, now_ms) when is_integer(now_ms) do
    hlc = normalize_hlc(action["hlc"])

    cond do
      hlc == nil ->
        {:error, "invalid_hlc", "hlc must be a positive integer"}

      hlc <= 0 ->
        {:error, "invalid_hlc", "hlc must be a positive integer"}

      true ->
        logical_time_ms = hlc >>> 16

        cond do
          logical_time_ms > now_ms + @future_drift_limit_ms ->
            {:error, "hlc_future_drift", "logical time is more than 120s in the future"}

          logical_time_ms < now_ms - @stale_limit_ms ->
            {:error, "hlc_stale", "logical time is more than 24h in the past"}

          true ->
            :ok
        end
    end
  end

  @doc """
  Normalizes an HLC value to an integer.

  Accepts integers or string representations of positive integers.
  """
  @spec normalize_hlc(non_neg_integer() | String.t() | nil) :: non_neg_integer() | nil
  def normalize_hlc(hlc)

  def normalize_hlc(hlc) when is_integer(hlc), do: hlc

  def normalize_hlc(hlc) when is_binary(hlc) do
    case Integer.parse(hlc) do
      {int, ""} when int > 0 -> int
      _ -> nil
    end
  end

  def normalize_hlc(_), do: nil

  @doc """
  Converts a raw action to validated action format.

  Transforms string keys to atoms where appropriate (e.g., method).
  """
  @spec to_validated_action(raw_action()) :: validated_action()
  def to_validated_action(action) do
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
