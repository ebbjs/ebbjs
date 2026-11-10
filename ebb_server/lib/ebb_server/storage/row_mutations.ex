defmodule EbbServer.Storage.RowMutations do
  @moduledoc """
  Projects one Action's per-component Updates into row-shaped mutations.

  The wire names one `(entity, component)` per Update, while the rule engine
  — the authorizer's bootstrap, row-identity, last-membership and
  last-group-member checks, the system-cache projection, and the Writer's
  fan-out scope resolution — was written against a whole row. This module is
  the single projection between the two, so those consumers keep their
  meaning without a second write path.

  Nothing stored, returned, or delivered carries the folded shape: it is the
  internal input to the rule engine only.

  ## The fold

  One mutation per subject, in first-appearance order:

      %{id, subject_id, model, method: :put | :patch | :delete,
        data: %{"fields" => %{field => value}} | nil}

  - Any `delete` for the subject collapses the row to a single `:delete`
    mutation with `data: nil`; a delete names the row, not a component.
  - Otherwise the component values fold in order: `merge` merges the field
    with `FieldMerge`, `replace` sets it whole, `drop` removes it.
  - `:put` when the row is new — the entity-type index does not know the id
    and no earlier Action of the same request created it — and `:patch` when
    it exists. Deriving the method from existence is what makes
    `<model>.create` mean "first write to a row" and `<model>.update` mean "a
    write to an existing row".
  - Update ids and leaf stamps pass through untouched.

  The model is the component's prefix. A `delete` names no component, so its
  model is the committed one, resolved through the `:model_resolver` option
  (the entity-type index by default). A resolver that answers `nil` for an id
  nothing knows keeps the delete's model `nil` rather than inventing one.
  """

  alias EbbServer.Storage.{EntityIndex, FieldMerge}

  @typedoc """
  One whole-row projection of an Action's component Updates.

  `model` is `nil` only for a delete the server cannot resolve a committed
  model for; every consumer treats that as "nothing known", never as an
  identity claim.
  """
  @type mutation :: %{
          id: String.t(),
          subject_id: String.t(),
          model: String.t() | nil,
          method: :put | :patch | :delete,
          data: %{String.t() => %{String.t() => term()}} | nil
        }

  @doc """
  Normalizes one decoded stored Update (string keys) into the internal shape.

  `ActionFormat` stores the wire keys so catch-up and export can deliver them;
  the fold needs the split `model`/`field` and an atom method, so a replay
  path converts through here rather than parsing the component twice.
  """
  @spec from_stored(map()) :: map()
  def from_stored(update) do
    component = update["component"]
    {model, field} = split_component(component)

    %{
      id: update["id"],
      subject_id: update["subject_id"],
      component: component,
      model: model,
      field: field,
      method: String.to_existing_atom(update["method"]),
      data: update["data"]
    }
  end

  @doc """
  Folds `updates` into one row mutation per subject.

  ## Options

  - `:created` — ids an earlier Action of the same request created, as a
    `MapSet` or a map keyed by id. A row in this set is not new.
  - `:exists?` — `(entity_id -> boolean)` deciding whether a row already
    exists. Defaults to the entity-type index. A caller that has existence
    signals the index can lag (the authorizer's by-id caches) passes its own
    predicate, so the verb keeps meaning what that caller's rules mean.
  - `:model_resolver` — `(entity_id -> model | nil)` used for a delete, whose
    Update names no component. Defaults to `EntityIndex.model/2` against
    `:entity_types` in the same options.
  - `:entity_types`, `:overlay` — the existence and committed-model reads,
    passed through to `EntityIndex`.
  """
  @spec fold([map()], keyword()) :: [mutation()]
  def fold(updates, opts \\ []) do
    created = Keyword.get(opts, :created, MapSet.new())
    resolve_model = Keyword.get(opts, :model_resolver, &committed_model(&1, opts))
    exists? = Keyword.get(opts, :exists?, &exists?(&1, opts))

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
    |> Enum.map(&finish(by_subject[&1], created, exists?, resolve_model))
  end

  defp split_component(nil), do: {nil, nil}

  defp split_component(component) do
    [model, field] = :binary.split(component, "/")
    {model, field}
  end

  defp new_entry(update) do
    %{
      id: update.id,
      subject_id: update.subject_id,
      model: update.model,
      deleted?: false,
      fields: %{}
    }
    |> fold_update(update)
  end

  defp fold_update(entry, %{method: :delete}) do
    %{entry | deleted?: true, fields: %{}}
  end

  # The first component Update names the row's model. A delete carries none,
  # so a sibling component writes down what the row was committed as.
  defp fold_update(entry, %{method: method} = update) do
    entry = %{entry | model: entry.model || update.model}

    case method do
      :merge -> %{entry | fields: merge_field(entry.fields, update.field, update.data)}
      :replace -> %{entry | fields: Map.put(entry.fields, update.field, update.data)}
      :drop -> %{entry | fields: Map.delete(entry.fields, update.field)}
    end
  end

  defp merge_field(fields, field, data) do
    Map.update(fields, field, data, &FieldMerge.merge(&1, data))
  end

  defp finish(%{deleted?: true} = entry, _created, _exists?, resolve_model) do
    %{
      id: entry.id,
      subject_id: entry.subject_id,
      model: resolve_model.(entry.subject_id) || entry.model,
      method: :delete,
      data: nil
    }
  end

  defp finish(entry, created, exists?, _resolve_model) do
    %{
      id: entry.id,
      subject_id: entry.subject_id,
      model: entry.model,
      method: if(new_row?(entry.subject_id, created, exists?), do: :put, else: :patch),
      data: %{"fields" => entry.fields}
    }
  end

  defp new_row?(subject_id, created, exists?) do
    not created?(subject_id, created) and not exists?.(subject_id)
  end

  defp exists?(subject_id, opts) do
    if Keyword.has_key?(opts, :entity_types) do
      EntityIndex.exists?(subject_id, opts)
    else
      false
    end
  end

  defp committed_model(subject_id, opts) do
    if Keyword.has_key?(opts, :entity_types) do
      EntityIndex.model(subject_id, opts)
    end
  end

  defp created?(subject_id, %MapSet{} = created), do: MapSet.member?(created, subject_id)
  defp created?(subject_id, created) when is_map(created), do: Map.has_key?(created, subject_id)
end
