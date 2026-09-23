defmodule EbbServer.Storage.PermissionChecker do
  @moduledoc """
  Facade for the action-level validation and authorization pipeline.
  Every committed Action from `POST /sync/actions` flows through here
  on its way into the Writer, so this is on the hot path.

  ## What it does

  Two checks, in order:

  1. **ActionValidator** — shape, actor, HLC bounds (logical time must be
     in `[now - 24h, now + 120s]`).
  2. **Authorizer** — for each Update, does the actor have the right
     `<type>.<verb>` (or `<type>.*`) on the entity's group?

  On success: returns the validated action to the Writer with the same
  shape it came in with, but populates server-side denormalized fields
  (`gsn`, `server_received_at_hlc`, etc.) so downstream code doesn't
  re-derive them.

  ## Stateless by design

  All state comes from ETS lookups via the cache modules (`GroupCache`,
  `RelationshipCache`, `EbbServer.Storage.AuthorizationContext`). The
  permission decision for an Action is a pure function of the Action
  + the actor's current group memberships. Keeping this stateless means
  no supervision coordination on the write path.

  ## What "permission" means here

  Permissions are stored on the Group system entity as a list of
  `<type>.<verb>` strings (e.g. `"todo.update"`, `"todo.*"`). The
  actor's per-group permissions are loaded into `GroupCache` on startup;
  a write to a Group updates the cache in place. Writes that arrive
  referencing an entity whose group the actor is not a member of, or
  referencing a permission the actor doesn't have, are rejected with
  `not_authorized`. The error shape mirrors the Writer's other reject
  reasons so the client can present a uniform error UI.
  """

  alias EbbServer.Storage.ActionValidator
  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.Authorizer

  @type raw_action :: ActionValidator.raw_action()
  @type raw_update :: ActionValidator.raw_update()
  @type validated_action :: ActionValidator.validated_action()
  @type validated_update :: ActionValidator.validated_update()

  @type rejection :: %{
          action_id: String.t(),
          reason: String.t(),
          details: String.t() | nil
        }

  @spec validate_and_authorize([raw_action()], String.t(), keyword()) ::
          {accepted :: [validated_action()], rejected :: [rejection()]}
  def validate_and_authorize(actions, actor_id, opts \\ []) do
    {validated_actions, rejections} = ActionValidator.validate(actions, actor_id, opts)

    case Authorizer.authorize(validated_actions, actor_id, AuthorizationContext.build(opts)) do
      :ok ->
        {validated_actions, rejections}

      {:error, reason, details} ->
        # Add authorization failure to all validated actions (they all fail together)
        updated_rejections =
          Enum.map(validated_actions, fn action ->
            %{action_id: action.id, reason: reason, details: details}
          end)
          |> Enum.concat(rejections)

        {[], updated_rejections}
    end
  end

  @spec validate_structure(raw_action()) :: :ok | {:error, String.t(), String.t()}
  defdelegate validate_structure(action), to: ActionValidator

  @spec validate_actor(raw_action(), String.t()) :: :ok | {:error, String.t(), String.t()}
  defdelegate validate_actor(action, actor_id), to: ActionValidator

  @spec validate_hlc(raw_action(), keyword()) :: :ok | {:error, String.t(), String.t()}
  defdelegate validate_hlc(action, opts \\ []), to: ActionValidator

  @spec authorize_updates(raw_action(), String.t(), keyword()) ::
          :ok | {:error, String.t(), String.t()}
  def authorize_updates(action, actor_id, opts \\ []) do
    ctx = AuthorizationContext.build(opts)

    validated_action = ActionValidator.to_validated_action(action)
    Authorizer.authorize([validated_action], actor_id, ctx)
  end
end
