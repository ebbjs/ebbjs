defmodule EbbServer.Storage.ActionValidator do
  @moduledoc """
  Validates action structure, actor, and HLC timestamps.

  A field leaf HLC may be arbitrarily old — such a leaf simply loses the
  merge — but never further in the future than the Action's own HLC may be,
  so a client cannot date one leaf far ahead of the clock and win that field
  forever, past the point where it loses the right to write. Out-of-bounds
  leaves are rejected rather than clamped, because the server and the client
  materializers must apply the same merge rule to the same values.

  A leaf is not held to its own Action's HLC. The client's `duplicate()`
  copies a row's leaves verbatim, so a copy can carry a peer's slightly newer
  stamp; the future drift window is what bounds the pin.

  Every Action is bounded before anything else reads it: at most 1 000
  Updates and 1 MiB in external term format. An Action over either cap is
  refused here, so it never reaches authorization, a prepare slot, or a
  flush; the rejection travels back through `rejected[]` while its siblings
  are still accepted. The Update count is checked first because counting is a
  shallow walk, while the size check traverses the whole term.

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
  @max_action_bytes 1_048_576
  @max_updates_per_action 1_000

  @doc """
  Validates a list of raw actions, returning validated actions and rejections.

  Each action is validated for:
  - Caps (at most 1 000 Updates and 1 MiB in external term format)
  - Structure (valid fields, non-empty values)
  - Actor (actor_id matches the authenticated actor)
  - HLC (valid timestamp within future drift bounds)
  - Field leaf HLCs (no leaf further in the future than the drift window)

  Note: HLC stale validation was removed because GSN provides total ordering
  and HLC is only used for conflict resolution during replica sync. The stale
  limit will be re-added when compaction watermark is implemented, since
  compaction overwrites entire entities and stale HLC updates would be lost.
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
    with :ok <- validate_caps(action),
         :ok <- validate_structure(action),
         :ok <- validate_actor(action, actor_id),
         :ok <- validate_hlc(action, now_ms),
         :ok <- validate_leaf_hlcs(action, now_ms) do
      {:ok, to_validated_action(action)}
    end
  end

  # Runs before structure and authorization: an Action over the caps is
  # refused here rather than after a walk over every Update, and long before
  # it can occupy a prepare or flush slot.
  defp validate_caps(action) do
    with :ok <- validate_update_count(action["updates"]) do
      validate_action_size(action)
    end
  end

  # Count before size: counting is a shallow walk of the Update list, while
  # the size check is a full ETF traversal of a term that may be megabytes.
  defp validate_update_count(updates) when is_list(updates) do
    count = length(updates)

    if count > @max_updates_per_action do
      {:error, "too_many_updates",
       "action has #{count} updates; the limit is #{@max_updates_per_action}"}
    else
      :ok
    end
  end

  defp validate_update_count(_updates), do: :ok

  defp validate_action_size(action) do
    size = :erlang.external_size(action)

    if size > @max_action_bytes do
      {:error, "action_too_large",
       "action is #{size} bytes encoded; the limit is #{@max_action_bytes}"}
    else
      :ok
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
    # System entities accept any data shape (including `nil`); the
    # server's update handler ignores `data` for these. For a delete
    # the data is dropped on the wire. For a user-entity put/patch
    # `data.fields` must be present. A field value that uses the `map`
    # discriminant is validated recursively; bare leaves are left to
    # the merge, which stamps their `update_id` on ingest.
    fields = if is_map(update["data"]), do: update["data"]["fields"], else: nil

    cond do
      update["subject_type"] in @system_entity_types ->
        :ok

      update["method"] == "delete" ->
        :ok

      update["method"] in ["put", "patch"] and is_map(update["data"]) and is_map(fields) and
          valid_map_fields?(fields) ->
        :ok

      true ->
        {:error, "invalid_structure",
         "update data must be a well-formed map for put/patch/delete on user entities"}
    end
  end

  defp valid_map_fields?(fields) do
    Enum.all?(fields, fn {_key, value} -> valid_map_field?(value) end)
  end

  # Only the map variant needs structural validation: its entries are
  # leaves or nested maps, and the merge assumes each leaf carries the
  # `update_id` the client stamped. A non-map value is a leaf the server
  # stamps itself, so it keeps the historical shape freedom.
  defp valid_map_field?(%{"map" => entries}) do
    is_map(entries) and Enum.all?(entries, fn {_key, value} -> valid_map_entry?(value) end)
  end

  defp valid_map_field?(_value), do: true

  defp valid_map_entry?(%{"map" => entries}) do
    is_map(entries) and Enum.all?(entries, fn {_key, value} -> valid_map_entry?(value) end)
  end

  defp valid_map_entry?(%{"value" => _} = leaf) do
    is_binary(leaf["update_id"]) and leaf["update_id"] != ""
  end

  defp valid_map_entry?(_value), do: false

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

  There is no stale bound: GSN provides total ordering (see
  `validate/3`). #123 reintroduces one with the compaction watermark.
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

      future_drift?(hlc, now_ms) ->
        {:error, "hlc_future_drift", "logical time is more than 120s in the future"}

      true ->
        :ok
    end
  end

  # A leaf may be older than the clock — a write that loses the merge — but
  # never past the window the Action's own HLC is held to. Leaves without an
  # HLC merge as 0, which is the historical wire shape.
  defp validate_leaf_hlcs(action, now_ms) do
    first_error(action["updates"], &update_leaf_hlc_error(&1, now_ms))
  end

  # A delete drops its data on the wire. A system row is exempt from the
  # `data` *shape* rules, not from the merge: its fields are materialized
  # and read like any other row's, so its leaves are bounded too.
  defp update_leaf_hlc_error(update, now_ms) do
    fields = if is_map(update["data"]), do: Map.get(update["data"], "fields"), else: nil

    if update["method"] in ["put", "patch"] and is_map(fields) do
      first_error(fields, fn {key, value} ->
        field_leaf_hlc_error(value, [key, "fields"], now_ms)
      end)
    else
      :ok
    end
  end

  # The `map` discriminant matches FieldMerge's, so the walk visits exactly
  # the values the merge will treat as leaves. `path` is reversed: a leaf
  # costs one cons cell, and the dotted path is built only for a rejection.
  defp field_leaf_hlc_error(%{"map" => entries}, path, now_ms) when is_map(entries) do
    first_error(entries, fn {key, value} ->
      field_leaf_hlc_error(value, [key, "map" | path], now_ms)
    end)
  end

  defp field_leaf_hlc_error(leaf, path, now_ms) when is_map(leaf) do
    leaf_hlc_error(leaf["hlc"], path, now_ms)
  end

  defp field_leaf_hlc_error(_leaf, _path, _now_ms), do: :ok

  defp leaf_hlc_error(nil, _path, _now_ms), do: :ok

  defp leaf_hlc_error(raw_hlc, path, now_ms) do
    case normalize_hlc(raw_hlc) do
      leaf_hlc when is_nil(leaf_hlc) or leaf_hlc <= 0 ->
        {:error, "invalid_field_hlc", "#{dotted(path)}.hlc must be a positive integer"}

      leaf_hlc ->
        if future_drift?(leaf_hlc, now_ms) do
          {:error, "invalid_field_hlc", "#{dotted(path)}.hlc is more than 120s in the future"}
        else
          :ok
        end
    end
  end

  defp dotted(path), do: path |> Enum.reverse() |> Enum.map_join(".", &to_string/1)

  defp first_error(items, fun) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case fun.(item) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp future_drift?(hlc, now_ms), do: logical_time_ms(hlc) > now_ms + @future_drift_limit_ms

  defp logical_time_ms(hlc), do: hlc >>> 16

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
