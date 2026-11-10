defmodule EbbServer.Storage.EntityView do
  @moduledoc """
  The wire view of an entity and the authorized read that produces it.

  `for_actor/3` is where the read permission rule is applied.
  `EntityStore.get/3` takes an actor id and ignores it — reads are
  unfiltered — so any caller that reads without going through this module
  serves rows the actor may not see. `/entities/:id` and the function
  runtime's `ctx.get` can share this module, so their view and their
  permission rule are the same by construction.

  `json/1` is the one mapping from entity columns to wire keys;
  `GroupListing` rows are formatted with it too, and
  `Router.OperationSchema.entity/0` publishes the same field list to
  OpenAPI clients.
  """

  alias EbbServer.Storage.{EntityStore, PermissionChecker}

  @type view :: %{String.t() => term()}

  @doc """
  Reads an entity on behalf of an actor and formats it.

  A denied read is reported as `:not_found`, the same as a missing entity:
  a distinct result would turn the read into an existence oracle for ids
  the actor cannot read.
  """
  @spec for_actor(String.t(), String.t(), keyword()) ::
          {:ok, view()} | :not_found | {:error, :materialization_failed}
  def for_actor(entity_id, actor_id, opts \\ []) do
    if PermissionChecker.can_read?(entity_id, actor_id, opts) do
      case EntityStore.get(entity_id, actor_id, opts) do
        {:ok, entity} -> {:ok, json(entity)}
        :not_found -> :not_found
        {:error, _reason} = error -> error
      end
    else
      :not_found
    end
  end

  @doc """
  Narrows a row view to the components a caller asked for.

  `components` is a set of `<model>/<field>` names, or `nil` for the whole
  row. A field survives only when the row's own model names it, so a
  component of another model cannot address a same-named field, and an
  unknown name simply matches nothing. The row shape — `data.fields` — stays
  as it is; this is a read filter, not a wire change.
  """
  @spec filter_components(view(), MapSet.t(String.t()) | nil) :: view()
  def filter_components(view, nil), do: view

  def filter_components(%{"data" => %{"fields" => fields}} = view, components)
      when is_map(fields) do
    model = view["type"]

    kept =
      Map.filter(fields, fn {field, _value} ->
        MapSet.member?(components, component_name(model, field))
      end)

    Map.put(view, "data", Map.put(view["data"], "fields", kept))
  end

  def filter_components(view, _components), do: view

  defp component_name(model, field) when is_binary(model) and is_binary(field),
    do: model <> "/" <> field

  defp component_name(_model, _field), do: nil

  @spec json(map()) :: view()
  def json(entity) do
    %{
      "id" => entity.id,
      "type" => entity.type,
      "data" => entity.data,
      "created_hlc" => entity.created_hlc,
      "updated_hlc" => entity.updated_hlc,
      "deleted_hlc" => entity.deleted_hlc,
      "last_gsn" => entity.last_gsn
    }
  end
end
