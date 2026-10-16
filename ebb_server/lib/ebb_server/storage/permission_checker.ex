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

  Delivery scope is no longer a validation concern: the Writer persists
  each Update's own fan-out scope and the router delivers per Update
  (#473), so an Action may span groups.

  Both checks are per-Action: a rejected Action in a batch is reported
  in `rejected[]` while its siblings are still accepted (#469).

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

  ## Read authorization

  The same membership cache answers read-side checks, so a single
  module owns "is this actor allowed to see this?". Writes and reads
  share one definition of membership:

    - `member_of_group?/3` — the actor has any membership in the group.
    - `member_of_all_groups?/3` — the actor is a member of every group
      (subscription scoping for catch-up and the SSE stream).
    - `member_group_ids/3` — the subset of a group list the actor may
      read, used to narrow a presence broadcast.
    - `can_read?/3` — resolves an entity's groups through
      `EntityIndex.source_groups/2` and passes when the actor is a
      member of at least one. Group-scoped, matching the write model;
      there are no per-entity or per-field read permissions yet.

  Read checks take the same table options as the authorization
  pipeline; callers that omit them get the cache tables published by
  `CacheTables`.
  """

  alias EbbServer.Storage.ActionValidator
  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.Authorizer
  alias EbbServer.Storage.CacheTables
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.GroupCache

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
    ctx = AuthorizationContext.build(opts)

    {accepted, authz_rejections} = Authorizer.authorize(validated_actions, actor_id, ctx)

    {accepted, rejections ++ Enum.map(authz_rejections, &to_rejection/1)}
  end

  defp to_rejection(%{action: action, reason: reason, details: details}) do
    %{action_id: action.id, reason: reason, details: details}
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

    case Authorizer.authorize([validated_action], actor_id, ctx) do
      {[_ | _], []} -> :ok
      {_accepted, [rejection | _]} -> {:error, rejection.reason, rejection.details}
    end
  end

  @doc """
  Returns true when the actor holds a membership in the group.

  Mirrors `GroupCache.get_permissions/3`: a membership whose permission
  list is empty does not count, matching how the write pipeline decides
  group ownership.
  """
  @spec member_of_group?(String.t(), String.t(), keyword()) :: boolean()
  def member_of_group?(group_id, actor_id, opts \\ []) do
    GroupCache.get_permissions(actor_id, group_id, group_members_table(opts)) != nil
  end

  @doc """
  Returns true when the actor is a member of every listed group.

  Used to scope subscriptions (catch-up, the SSE stream) to groups the
  actor may read. An empty list passes vacuously; callers that need a
  non-empty selection validate that before calling.
  """
  @spec member_of_all_groups?([String.t()], String.t(), keyword()) :: boolean()
  def member_of_all_groups?(group_ids, actor_id, opts \\ []) do
    Enum.all?(group_ids, &member_of_group?(&1, actor_id, opts))
  end

  @doc """
  Returns the subset of `group_ids` the actor is a member of, preserving
  the input order. Used to narrow a broadcast to the groups that should
  receive it.
  """
  @spec member_group_ids([String.t()], String.t(), keyword()) :: [String.t()]
  def member_group_ids(group_ids, actor_id, opts \\ []) do
    Enum.filter(group_ids, &member_of_group?(&1, actor_id, opts))
  end

  @doc """
  Returns true when the actor may read the entity.

  Resolves the entity's groups with `EntityIndex.source_groups/2` and
  passes when the actor is a member of at least one. An entity in no
  group is readable by nobody — including its would-be author — matching
  the group scoping of the write model.

  Membership follows `GroupCache.get_permissions/3`, so a `groupMember`
  row whose permission list is empty does not grant read access. The
  `query/3` SQL JOIN matches on row presence instead, so the two read
  paths can still disagree for that edge case.
  """
  @spec can_read?(String.t(), String.t(), keyword()) :: boolean()
  def can_read?(entity_id, actor_id, opts \\ []) do
    group_ids = EntityIndex.source_groups(entity_id, entity_groups: entity_groups_table(opts))

    member_group_ids(group_ids, actor_id, opts) != []
  end

  defp group_members_table(opts),
    do: Keyword.get(opts, :group_members, CacheTables.group_members())

  defp entity_groups_table(opts),
    do: Keyword.get(opts, :entity_groups, CacheTables.entity_groups())
end
