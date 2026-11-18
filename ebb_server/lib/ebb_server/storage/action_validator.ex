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

  ## The component envelope

  One Update names one `(entity, component)`, or the row itself:

      %{"id", "subject_id", "component" => "note/title",
        "method" => "merge" | "replace" | "drop", "data" => field_value | nil}
      %{"id", "subject_id", "model" => "note", "method" => "create",
        "hlc" => created_hlc, "data" => nil}
      %{"id", "subject_id", "method" => "delete", "data" => nil}

  `component` is `<model>/<field>` and `data` is the component's own value,
  never a row's field record. A `create` names the row's `model` and the HLC
  the row was created at; a zero-component create is a complete row. A
  `delete` names the row and carries no component. `replace` is refused for
  a keyed component (any `data` carrying `map`), because a wholesale replace
  would discard a concurrent writer's siblings.

  ## The create decides the row's model

  A row has one model. Every component Update for a subject in an Action must
  name the create's model; a disagreement is a structure violation. A create
  may arrive after its components — the client can deliver out of order — so
  the create, not the first component, decides. One create per subject per
  Action, and a platform (`ebb`) create must carry exactly one `ebb/*`
  component in the same Action, because a platform row is one kind.

  An **overlay** component is the exception: `ebb/link` is a component of a
  row it does not model, so it is exempt from the one-model rule and may
  ride a row committed under any model (decision 13's storage consequence).
  The other `ebb/*` components still are the row's model — a `note` create
  cannot carry an `ebb/grant` — so the exemption is asked of
  `SystemComponent.overlay?/1` rather than of the namespace.

  The pre-component wire — a per-Update type name, `put`/`patch` methods,
  and `data.fields` — is rejected here rather than read through: there is
  no alias and no deprecation path.

  Every Action is bounded before anything else reads it: at most 1 000
  Updates and 1 MiB in external term format. An Action over either cap is
  refused here, so it never reaches authorization, a prepare slot, or a
  flush; the rejection travels back through `rejected[]` while its siblings
  are still accepted. The Update count is checked first because counting is a
  shallow walk, while the size check traverses the whole term.

  """

  import Bitwise
  alias EbbServer.Storage.{Component, SystemComponent}

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
          component: String.t() | nil,
          model: String.t() | nil,
          field: String.t() | nil,
          method: :create | :merge | :replace | :drop | :delete,
          data: map() | nil,
          hlc: non_neg_integer() | nil
        }

  @type rejection :: %{
          action_id: String.t(),
          reason: String.t(),
          details: String.t() | nil
        }

  @future_drift_limit_ms 120_000
  # Operator-facing text quotes the window, so it cannot drift from the check.
  @future_drift_window "#{div(@future_drift_limit_ms, 1000)}s"
  @max_action_bytes 1_048_576
  @max_updates_per_action 1_000

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
        validate_updates(action["updates"])
    end
  end

  # Ordered: the per-Update shape first, so every component below is well
  # formed; then one create per subject; the model check next, because it
  # reads the create and the prefix; and the platform-component counts last.
  # A create's own HLC is validated with the leaf HLCs, where the clock is
  # available.
  defp validate_updates(updates) do
    with :ok <- validate_updates_structure(updates),
         :ok <- validate_create_uniqueness(updates),
         :ok <- validate_subject_models(updates),
         :ok <- validate_subject_components(updates) do
      validate_platform_creates(updates)
    end
  end

  # One explicit create per subject: a second one cannot be ordered against
  # the first, so it would leave the row's model and creation time ambiguous.
  defp validate_create_uniqueness(updates) do
    Enum.reduce_while(updates, MapSet.new(), fn
      %{"method" => "create", "subject_id" => subject_id}, seen ->
        if MapSet.member?(seen, subject_id) do
          {:halt,
           {:error, "invalid_structure",
            "a row is created once per action: #{inspect(subject_id)} has more than one create"}}
        else
          {:cont, MapSet.put(seen, subject_id)}
        end

      _update, seen ->
        {:cont, seen}
    end)
    |> case do
      {:error, _reason, _details} = error -> error
      _seen -> :ok
    end
  end

  # A platform row is one kind, so an `ebb` create without exactly one
  # `ebb/*` component would materialize a row with no way to tell which.
  defp validate_platform_creates(updates) do
    case Enum.find(updates, &platform_create_without_component?(&1, updates)) do
      nil ->
        :ok

      create ->
        {:error, "invalid_structure",
         "an ebb create must carry exactly one ebb/* component: " <>
           inspect(create["subject_id"])}
    end
  end

  defp platform_create_without_component?(%{"method" => "create"} = create, updates) do
    create["model"] == SystemComponent.model() and
      Enum.count(updates, &platform_component_of?(&1, create["subject_id"])) != 1
  end

  defp platform_create_without_component?(_update, _updates), do: false

  # An overlay is not a kind of platform row: `ebb/link` rides a row it does
  # not model, so it cannot be the component that makes an `ebb` create legal.
  defp platform_component_of?(%{"component" => component, "subject_id" => subject_id}, subject_id)
       when is_binary(component) do
    SystemComponent.component?(component) and not overlay?(component)
  end

  defp platform_component_of?(_update, _subject_id), do: false

  # A row has one model. Every component Update for one subject in an Action
  # must name the same prefix, and the create (when there is one) decides it,
  # or the fold could materialize, say, a `note` row carrying a `group_id`
  # field. A delete names no component, so it constrains nothing, and an
  # overlay component names no model of the row's: it may sit on any of them.
  #
  # Runs after the per-Update checks, so each component here is well formed
  # and `Component.split/1` cannot raise.
  defp validate_subject_models(updates) do
    with :ok <- component_subject_models(updates) do
      create_subject_models(updates)
    end
  end

  defp component_subject_models(updates) do
    case Enum.reduce_while(updates, %{}, &check_subject_model/2) do
      {:error, _reason, _details} = error -> error
      _models -> :ok
    end
  end

  defp create_subject_models(updates) do
    models = component_models(updates)

    Enum.reduce_while(updates, :ok, fn
      %{"method" => "create", "subject_id" => subject_id, "model" => model}, :ok ->
        case Map.fetch(models, subject_id) do
          {:ok, component_model} when component_model != model ->
            {:halt, create_model_error(subject_id, model, component_model)}

          _ ->
            {:cont, :ok}
        end

      _update, :ok ->
        {:cont, :ok}
    end)
  end

  defp component_models(updates) do
    Enum.reduce(updates, %{}, fn
      %{"component" => component, "subject_id" => subject_id}, models
      when is_binary(component) ->
        if overlay?(component) do
          models
        else
          Map.put_new(models, subject_id, Component.model(component))
        end

      _update, models ->
        models
    end)
  end

  defp create_model_error(subject_id, create_model, component_model) do
    {:error, "invalid_structure",
     "the create's model and every component of a row must be one model: " <>
       "#{inspect(subject_id)} names #{inspect(create_model)} and " <>
       inspect(component_model)}
  end

  defp check_subject_model(%{"component" => component} = update, models)
       when is_binary(component) do
    if overlay?(component), do: {:cont, models}, else: check_committed_model(update, models)
  end

  defp check_subject_model(_update, models), do: {:cont, models}

  defp check_committed_model(%{"component" => component, "subject_id" => subject_id}, models) do
    model = Component.model(component)

    case Map.fetch(models, subject_id) do
      :error ->
        {:cont, Map.put(models, subject_id, model)}

      {:ok, ^model} ->
        {:cont, models}

      {:ok, other} ->
        {:halt,
         {:error, "invalid_structure",
          "every component of a row must name one model: " <>
            "#{inspect(subject_id)} names both #{inspect(other)} and #{inspect(model)}"}}
    end
  end

  defp overlay?(component), do: SystemComponent.overlay?(SystemComponent.kind(component))

  # A row carries at most one platform component (decision 13), so a second
  # one would make its kind — and its cache projection — a guess.
  defp validate_subject_components(updates) do
    case Enum.reduce_while(updates, %{}, &check_subject_component/2) do
      {:error, _reason, _details} = error -> error
      _components -> :ok
    end
  end

  defp check_subject_component(%{"component" => component, "subject_id" => subject_id}, seen)
       when is_binary(component) do
    case SystemComponent.kind(component) do
      nil ->
        {:cont, seen}

      _kind ->
        case Map.fetch(seen, subject_id) do
          :error ->
            {:cont, Map.put(seen, subject_id, component)}

          {:ok, ^component} ->
            {:cont, seen}

          {:ok, other} ->
            {:halt,
             {:error, "invalid_structure",
              "a row carries one platform component: #{inspect(subject_id)} names both " <>
                "#{inspect(other)} and #{inspect(component)}"}}
        end
    end
  end

  defp check_subject_component(_update, seen), do: {:cont, seen}

  defp validate_updates_structure(updates) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      case validate_update_structure(update) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp validate_update_structure(update) do
    with :ok <- validate_update_keys(update),
         :ok <- validate_update_id(update["id"]),
         :ok <- validate_update_subject_id(update["subject_id"]),
         :ok <- validate_update_method(update["method"]),
         :ok <- validate_update_component(update),
         :ok <- validate_create_fields(update),
         :ok <- validate_update_data(update) do
      validate_replace_target(update)
    end
  end

  # Each method has its exact key set. A per-Update type name or a row's
  # field record cannot ride along unrecognised: the pre-component wire is
  # refused here, and a stored frame in that shape raises on decode. A
  # `model` or `hlc` on a component Update is refused the same way.
  defp validate_update_keys(update) do
    case Map.keys(update) -- Component.update_keys_for(update["method"]) do
      [] ->
        :ok

      unknown ->
        {:error, "invalid_structure",
         "update has unknown keys: #{unknown |> Enum.sort() |> Enum.join(", ")}"}
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

  defp validate_update_method(method) do
    if Component.method?(method),
      do: :ok,
      else:
        {:error, "invalid_structure",
         "update method must be one of: " <> Enum.join(Component.method_names(), ", ")}
  end

  defp validate_update_component(%{"method" => method} = update)
       when method in ["create", "delete"] do
    if Map.has_key?(update, "component") do
      {:error, "invalid_structure", "a #{method} names the row and carries no component"}
    else
      :ok
    end
  end

  defp validate_update_component(update) do
    if Component.valid?(update["component"]) do
      :ok
    else
      component_error(update["component"])
    end
  end

  defp component_error(component) do
    {:error, "invalid_structure",
     "update component must be <model>/<field>, got: #{inspect(component, limit: 4)}"}
  end

  # A create names its model and the HLC the row was created at. The model
  # is a model name (no `/`); the field segment of a component is not one.
  defp validate_create_fields(%{"method" => "create"} = update) do
    model = update["model"]

    cond do
      not is_binary(model) or model == "" or :binary.match(model, "/") != :nomatch ->
        {:error, "invalid_structure",
         "a create's model must be a model name, got: " <>
           inspect(model, limit: 4)}

      normalize_hlc(update["hlc"]) == nil ->
        {:error, "invalid_structure", "a create's hlc must be a positive integer"}

      true ->
        :ok
    end
  end

  defp validate_create_fields(_update), do: :ok

  defp validate_update_data(%{"method" => method} = update) when method in ["merge", "replace"] do
    data = update["data"]

    cond do
      not is_map(data) ->
        {:error, "invalid_structure", "update data must be a field value for #{method}"}

      Map.has_key?(data, "fields") ->
        {:error, "invalid_structure",
         "update data is the component's value; a row's fields record is not accepted"}

      Map.has_key?(data, "map") ->
        if valid_map_entries?(data), do: :ok, else: field_value_error()

      true ->
        :ok
    end
  end

  defp validate_update_data(update) do
    if is_nil(update["data"]) do
      :ok
    else
      {:error, "invalid_structure", "update data must be null for #{update["method"]}"}
    end
  end

  defp field_value_error do
    {:error, "invalid_structure",
     "update data must be a well-formed field value: a leaf map or a map of leaves"}
  end

  # Only the map variant needs structural validation: its entries are leaves
  # or nested maps, and the merge assumes each leaf carries the `update_id` the
  # client stamped. A non-map value is a leaf the server stamps itself, so it
  # keeps its historical shape freedom.
  defp valid_map_entries?(%{"map" => entries}) do
    is_map(entries) and Enum.all?(entries, fn {_key, value} -> valid_map_entry?(value) end)
  end

  defp valid_map_entry?(%{"map" => entries}) do
    is_map(entries) and Enum.all?(entries, fn {_key, value} -> valid_map_entry?(value) end)
  end

  defp valid_map_entry?(%{"value" => _} = leaf) do
    is_binary(leaf["update_id"]) and leaf["update_id"] != ""
  end

  defp valid_map_entry?(_value), do: false

  @spec validate_actor(raw_action(), String.t()) :: :ok | {:error, String.t(), String.t()}
  def validate_actor(action, actor_id) do
    if action["actor_id"] == actor_id do
      :ok
    else
      {:error, "actor_mismatch", "action actor_id does not match authenticated actor"}
    end
  end

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
        {:error, "hlc_future_drift",
         "logical time is more than #{@future_drift_window} in the future"}

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

  # A delete or drop carries no value. Every other method's data is the
  # component's own value, so the walk starts at the component name. A
  # create's own `hlc` is the row's creation time, so it is held to the same
  # future-drift window as a leaf.
  defp update_leaf_hlc_error(%{"method" => "create"} = update, now_ms) do
    leaf_hlc_error(update["hlc"], ["create"], now_ms)
  end

  defp update_leaf_hlc_error(update, now_ms) do
    data = update["data"]

    if Component.value_method?(update["method"]) and is_map(data) do
      field_leaf_hlc_error(data, [update["component"]], now_ms)
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
          {:error, "invalid_field_hlc",
           "#{dotted(path)}.hlc is more than #{@future_drift_window} in the future"}
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

  @spec to_validated_action(raw_action()) :: validated_action()
  def to_validated_action(action) do
    %{
      id: action["id"],
      actor_id: action["actor_id"],
      hlc: normalize_hlc(action["hlc"]),
      updates: Enum.map(action["updates"], &to_validated_update/1)
    }
  end

  defp to_validated_update(%{"method" => "create"} = update) do
    %{
      id: update["id"],
      subject_id: update["subject_id"],
      component: nil,
      model: update["model"],
      field: nil,
      method: :create,
      data: nil,
      hlc: normalize_hlc(update["hlc"])
    }
  end

  defp to_validated_update(update) do
    {model, field} = split_component(update["component"])

    %{
      id: update["id"],
      subject_id: update["subject_id"],
      component: update["component"],
      model: model,
      field: field,
      method: Component.to_method(update["method"]),
      data: update["data"]
    }
  end

  defp split_component(component) when is_binary(component), do: Component.split(component)
  defp split_component(nil), do: {nil, nil}

  # `replace` sets a component's value whole, so it is refused for a keyed
  # component: the client's key set is not this writer's to discard.
  defp validate_replace_target(%{"method" => "replace"} = update) do
    case update["data"] do
      %{"map" => _entries} ->
        {:error, "invalid_structure",
         "component #{inspect(update["component"])} is a keyed component; replace is refused"}

      _ ->
        :ok
    end
  end

  defp validate_replace_target(_update), do: :ok
end
