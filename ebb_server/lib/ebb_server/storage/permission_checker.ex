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

  A third check runs after authorization succeeds:

  3. **Group scope** — does a content Action resolve every Update to one
     group set, so the Writer's union index and the fan-out router cannot
     push an Update to a subscriber outside its own group? A content
     Action that spans groups is rejected with `group_mismatch` (#461).

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
  alias EbbServer.Storage.Fields
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper

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

    case Authorizer.authorize(validated_actions, actor_id, ctx) do
      :ok ->
        {accepted, mismatched} = split_by_group_scope(validated_actions, ctx)
        {accepted, rejections ++ mismatched}

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

  # The group-scope check is per-Action: a mismatched Action is rejected
  # while its siblings in the same request still commit.
  defp split_by_group_scope(actions, ctx) do
    scope_opts = AuthorizationContext.to_opts(ctx)

    {accepted, rejected} =
      Enum.reduce(actions, {[], []}, fn action, {accepted, rejected} ->
        case check_group_scope(action, scope_opts) do
          :ok ->
            {[action | accepted], rejected}

          {:error, reason, details} ->
            {accepted, [%{action_id: action.id, reason: reason, details: details} | rejected]}
        end
      end)

    {Enum.reverse(accepted), Enum.reverse(rejected)}
  end

  # #127/#461: the Writer indexes an Action into the union of its Updates'
  # fan-out groups and the fan-out router pushes the whole Action to every
  # group in that union, so an Action stays fully visible or fully invisible
  # to a subscriber only when every Update resolves to the same group set.
  # Per-Update authorization is not enough — a content write in group A can
  # ride a membership write into group B and leak the group-B row to a
  # subscriber of A. A system-only Action may span groups: a `setGroups`
  # delta's union is the membership operation's visibility scope.
  defp check_group_scope(action, opts) do
    intra_opts =
      Keyword.put(
        opts,
        :intra_action,
        PermissionHelper.build_intra_action_context(action.updates)
      )

    scopes =
      Enum.map(action.updates, fn update ->
        {update, update |> EntityIndex.fan_out_groups(intra_opts) |> Enum.sort()}
      end)

    union =
      scopes |> Enum.flat_map(fn {_update, groups} -> groups end) |> Enum.uniq() |> Enum.sort()

    if Enum.any?(action.updates, &(not system_update?(&1))) do
      created_ids =
        PermissionHelper.created_subject_ids(action.updates, fn id ->
          EntityIndex.exists?(id, opts)
        end)

      case Enum.reject(scopes, &scope_matches?(&1, union, created_ids)) do
        [] -> :ok
        offenders -> {:error, "group_mismatch", render_scope_mismatch(offenders, union)}
      end
    else
      :ok
    end
  end

  defp system_update?(update),
    do: update.subject_type in PermissionHelper.system_entity_types()

  # A content Update must carry the Action's whole group set. A system
  # Update must too, except an `entityGroup` put that carries a content
  # entity's own membership: its group is one the entity is created into,
  # so it is in the union by construction. The exemption is for creates
  # alone; widening an existing entity's scope beside a content write is
  # the leak this check blocks.
  defp scope_matches?({update, groups}, union, created_ids) do
    groups == union or own_membership_put?(update, created_ids)
  end

  defp own_membership_put?(%{subject_type: "entityGroup", method: :put} = update, created_ids) do
    entity_id = Fields.get(update.data, "entity_id")
    is_binary(entity_id) and MapSet.member?(created_ids, entity_id)
  end

  defp own_membership_put?(_update, _created_ids), do: false

  defp render_scope_mismatch(offenders, union) do
    rendered =
      Enum.map_join(offenders, "; ", fn {update, groups} ->
        "#{update.subject_type} #{update.id} resolves to #{format_groups(groups)}"
      end)

    "#{rendered}; the Action spans #{format_groups(union)}"
  end

  defp format_groups(groups), do: "[" <> Enum.join(groups, ", ") <> "]"

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
