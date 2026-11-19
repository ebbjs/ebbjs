defmodule EbbServer.Storage.RowMutations do
  @moduledoc """
  Projects one Action's Updates into row-shaped mutations.

  The wire names one `(entity, component)` per Update and one row-scoped
  `create`, while the rule engine — the authorizer's bootstrap, row-identity,
  last-membership and last-group-member checks, the system-cache projection,
  and the Writer's fan-out scope resolution — was written against a whole
  row. This module is the single projection between the two, so those
  consumers keep their meaning without a second write path.

  Nothing stored, returned, or delivered carries the folded shape: it is the
  internal input to the rule engine only.

  ## The fold

  One mutation per subject, in first-appearance order:

      %{id, subject_id, model, kind, created?: boolean, deleted?: boolean,
        data: %{"fields" => %{field => value}} | nil}

  - Any `delete` for the subject collapses the row to a single delete
    mutation: `deleted?: true`, `created?: false`, `data: nil`. A delete names
    the row, not a component, and it supersedes everything the Action wrote
    before it, so a row one Action creates and then deletes is not reported as
    created either.
  - Otherwise the component values fold in order: `merge` merges the field
    with `FieldMerge`, `replace` sets it whole, `drop` removes it. A `create`
    contributes no field.
  - `created?` iff the Action carries a `create` for the subject; a drop-only
    Action is an update. The explicit create is the only existence fact the
    wire carries, and it is what makes `<model>.create` mean "this Action
    creates the row" and `<model>.update` mean "a write to a row it already
    exists under".
  - Update ids and leaf stamps pass through untouched.

  The model is the create's when there is one, and otherwise the component's
  prefix. A `delete` names no component, so its model is the committed one,
  resolved through the `:model_resolver` option (the entity-model cache
  widened with the by-id caches, by default). A resolver that answers `nil`
  for an id nothing knows keeps the delete's model `nil` rather than
  inventing one.

  `kind` comes from the platform component the row carries. A zero-component
  create carries none, so it is a user row.

  This fold is a shim for the rule engine, not a property of rows: an Action
  says whether it creates or deletes a row, while a row carries no such
  vocabulary of its own. #815 removes the fold once the write path stops
  projecting to rows.
  """

  alias EbbServer.Storage.{Component, EntityScope, FieldMerge, SystemComponent}

  @typedoc """
  One whole-row projection of an Action's Updates: whether the Action
  creates or deletes the row, and the fields it folds to.

  `model` is `nil` only for a delete the server cannot resolve a committed
  model for; every consumer treats that as "nothing known", never as an
  identity claim. A delete reports `deleted?: true`, `created?: false` and
  `data: nil`.
  """
  @type mutation :: %{
          id: String.t(),
          subject_id: String.t(),
          model: String.t() | nil,
          kind: SystemComponent.kind() | nil,
          created?: boolean(),
          deleted?: boolean(),
          data: %{String.t() => %{String.t() => term()}} | nil
        }

  @doc """
  Whether the mutation writes the row rather than deleting it.

  Every caller that needs this as a boolean calls it, so the distinction has
  one definition. Function heads that dispatch on it match `deleted?:`
  directly, since a guard cannot call a function.
  """
  @spec write?(mutation()) :: boolean()
  def write?(%{deleted?: deleted?}), do: not deleted?

  @doc """
  Normalizes one decoded stored Update (string keys) into the internal shape.

  `ActionFormat` stores the wire keys so catch-up and export can deliver them;
  the fold needs the split `model`/`field` and the Update's method atom, so a
  replay path converts through here rather than parsing the component twice.
  """
  @spec from_stored(map()) :: map()
  def from_stored(%{"method" => "create"} = update) do
    %{
      id: update["id"],
      subject_id: update["subject_id"],
      component: nil,
      model: update["model"],
      field: nil,
      method: :create,
      data: nil,
      hlc: update["hlc"]
    }
  end

  def from_stored(update) do
    component = update["component"]
    {model, field} = split_component(component)

    %{
      id: update["id"],
      subject_id: update["subject_id"],
      component: component,
      model: model,
      field: field,
      method: Component.to_method(update["method"]),
      data: update["data"]
    }
  end

  @doc """
  Folds `updates` into one row mutation per subject.

  ## Options

  - `:model_resolver` — `(entity_id -> model | nil)` used for a delete, whose
    Update names no component. Defaults to `EntityScope.committed_model/2`
    against `:entity_models` and the by-id caches in the same options.
  - `:entity_models`, `:overlay` — the committed-model reads, passed through
    to `EntityScope`.

  A committed-model signal is required: without one a delete would forget the
  model it was authorized under.
  """
  @spec fold([map()], keyword()) :: [mutation()]
  def fold(updates, opts \\ []) do
    resolve_model = model_resolver!(opts)

    {order, by_subject} =
      Enum.reduce(updates, {[], %{}}, fn update, {order, acc} ->
        case Map.fetch(acc, update.subject_id) do
          {:ok, entry} ->
            {order, Map.put(acc, update.subject_id, fold_update(entry, update))}

          :error ->
            {[update.subject_id | order], Map.put(acc, update.subject_id, new_entry(update))}
        end
      end)

    order
    |> Enum.reverse()
    |> Enum.map(&finish(by_subject[&1], resolve_model))
    |> Enum.map(&resolve_kind(&1, opts))
  end

  # Only a delete's kind has to be resolved from the by-id caches: a create
  # names its model and carries no component, so a zero-component create is
  # a user row by construction.
  defp resolve_kind(%{deleted?: true, kind: nil} = mutation, opts),
    do: %{mutation | kind: EntityScope.kind_of(mutation, opts)}

  defp resolve_kind(mutation, _opts), do: mutation

  defp split_component(component) when is_binary(component), do: Component.split(component)
  defp split_component(nil), do: {nil, nil}

  defp new_entry(update) do
    %{
      id: update.id,
      subject_id: update.subject_id,
      model: nil,
      component: nil,
      created?: false,
      deleted?: false,
      fields: %{}
    }
    |> fold_update(update)
  end

  defp fold_update(entry, %{method: :create} = update) do
    %{entry | created?: true, model: update.model}
  end

  defp fold_update(entry, %{method: :delete}) do
    %{entry | deleted?: true, fields: %{}}
  end

  # The first component Update names the row's model when no create has yet;
  # the create overrides it when one arrives later.
  defp fold_update(entry, %{method: method} = update) do
    entry = %{
      entry
      | model: entry.model || update.model,
        component: entry.component || update.component
    }

    case method do
      :merge -> %{entry | fields: merge_field(entry.fields, update.field, update.data)}
      :replace -> %{entry | fields: Map.put(entry.fields, update.field, update.data)}
      :drop -> %{entry | fields: Map.delete(entry.fields, update.field)}
    end
  end

  defp merge_field(fields, field, data) do
    Map.update(fields, field, data, &FieldMerge.merge(&1, data))
  end

  defp finish(%{deleted?: true} = entry, resolve_model) do
    %{
      id: entry.id,
      subject_id: entry.subject_id,
      model: resolve_model.(entry.subject_id) || entry.model,
      kind: SystemComponent.kind(entry.component),
      created?: false,
      deleted?: true,
      data: nil
    }
  end

  defp finish(entry, resolve_model) do
    %{
      id: entry.id,
      subject_id: entry.subject_id,
      model: row_model(entry, resolve_model),
      kind: SystemComponent.kind(entry.component),
      created?: entry.created?,
      deleted?: false,
      data: %{"fields" => entry.fields}
    }
  end

  # The create's model is the row's committed model. Without a create, a row
  # is committed under the model it was **committed** under: a user component
  # names its own prefix, the three platform *rows* are `ebb` because that is
  # what they are, and an `ebb/link` overlay names no model at all — it is a
  # component of a row it does not re-model, so it keeps the committed model
  # and, when that is unknown, claims none rather than adopting `ebb`
  # (an overlay never supplies a model — CONTEXT.md).
  defp row_model(%{created?: true, model: model}, _resolve_model), do: model

  defp row_model(entry, resolve_model) do
    case SystemComponent.kind(entry.component) do
      nil -> entry.model
      :link -> resolve_model.(entry.subject_id)
      _platform -> resolve_model.(entry.subject_id) || SystemComponent.model()
    end
  end

  defp model_resolver!(opts) do
    case Keyword.get(opts, :model_resolver) do
      fun when is_function(fun, 1) ->
        fun

      nil ->
        require_model_read!(opts)
        fn subject_id -> EntityScope.committed_model(subject_id, opts) end

      other ->
        raise ArgumentError,
              "RowMutations.fold/2 :model_resolver must be a 1-arity function, " <>
                "got: #{inspect(other, limit: 4)}"
    end
  end

  # A fold without the read its delete model needs cannot answer it, and
  # guessing would silently change what the rule engine authorizes.
  defp require_model_read!(opts) do
    unless Keyword.has_key?(opts, :entity_models) do
      raise ArgumentError,
            "RowMutations.fold/2 needs a committed-model signal: " <>
              "pass :entity_models or :model_resolver"
    end

    :ok
  end
end
