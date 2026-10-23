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
