defmodule EbbServer.Storage.PermissionChecker do
  @moduledoc """
  Stateless module for validating and authorizing actions.

  This is a facade module that delegates to specialized modules:
  - ActionValidator: validates action structure, actor, and HLC
  - Authorizer: performs authorization checks

  All state comes from ETS lookups via cache modules:
  - GroupCache.get_permissions/3
  - RelationshipCache.get_entity_group/2
  - GroupCache.get_actor_groups/2
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
