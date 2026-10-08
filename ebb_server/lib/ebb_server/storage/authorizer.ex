defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Authorizes validated actions against the #121 permission table.

  Every Update in an Action is checked individually; the first failure
  rejects the whole Action.

  ## Bootstrap

  An actor creating a group has no membership to check against, so the
  `group` put and the actor's own `groupMember` put cannot be authorized
  by the table. Those two — plus the `entityGroup` edge filing an entity
  the same Action creates into the new group — are exempt
  (`PermissionHelper.bootstrap_update?/4`). Everything else in the
  Action is authorized normally, using the permissions the actor grants
  themselves in their own `groupMember` put: while the Action is being
  authorized the actor's new membership is not in the cache yet, so the
  declared permissions stand in for it.

  The exemption applies only to entities the Action is **creating**: a
  `group` put qualifies only when the entity-type index does not know
  the id, and the `entityGroup` exemption covers only user entities the
  Action actually creates. Re-`put`ting a committed group or filing a
  committed entity falls through to the permission table like any other
  write (#289), and the declared permissions are never unioned into the
  membership checks for entities that already exist.

  This is deliberately per-Update rather than a whole-Action
  short-circuit (#246): a third-party `groupMember`, a link edge for an
  unrelated entity, or a patch to an existing entity all fall through
  to the table even when they ride along with a bootstrap.

  ## System entities

  `group`, `groupMember`, `entityGroup` and `relationship` rows carry
  `<type>.<verb>` permissions like user entities:

    - `group` put/patch/delete → `group.create` / `group.update` /
      `group.delete` in the group. A `group` put only passes through the
      bootstrap exemption; minting a group and handing it to somebody
      else is not allowed.
    - `groupMember` put/patch/delete → `groupMember.create` /
      `groupMember.update` / `groupMember.delete` in the target group.
      Adding an actor to a group is `groupMember.create` in that group;
      the bootstrap covers only the acting actor's own membership.
    - `entityGroup` put → the added entity's `<type>.create` in the
      target group: the group(s) the put files the entity into (#121's
      "Add Entity to Group" row), not the entity's whole group set. The
      type is the committed entity-type index's when the entity already
      exists, otherwise a type created by the same Action or by an
      earlier Action of the same request. An unresolvable type is
      refused (`not_authorized`) rather than falling back to the
      `entityGroup.create` system permission. Membership mutations of
      an existing entity are checked against cached memberships only —
      the bootstrap's declared permissions stand in only for the
      membership the same Action creates.
    - `entityGroup` delete → the entity's `<type>.update` in any group of
      the entity's current set (union/any-match). The delete wire form
      drops the entity reference, so the row is resolved from the
      membership index. `entityGroup` patch → `entityGroup.update` in the
      membership's group.
    - `relationship` put (always a domain edge; membership is
      `entityGroup`) → the source entity's `<type>.update` in the
      source's group set, where `<type>` is the source entity's true
      type resolved from the entity index (#323). The wire `data.type`
      field is a descriptive label and is never consulted for
      authorization, so a forged value cannot borrow another type's
      permission. `relationship` patch/delete → `relationship.update` /
      `relationship.delete` in the edge's source group set.

  ## User entities

  User-entity writes require `<type>.<verb>` in at least one group of
  the entity's group set (union/any-match). A write whose resolved set
  is empty — an unowned entity, or an id that does not exist — is a
  structural rejection (`missing_ownership`), not a permission failure.

  ## Last membership

  An entity must keep at least one owning group. Anything that would
  leave it with none is a structural rejection (`last_membership`),
  beside `missing_ownership` (#264). The check is a per-entity net
  delta: the entity's cached membership set, plus the `entityGroup`
  puts seen in the request, minus its `entityGroup` deletes, with a
  removed group cancelled when a put re-adds it. Membership is per
  **row**, so putting a second row for a group the entity already
  belongs to keeps that group even when the same Action (or a later
  Action of the request) deletes the old row. The delta is carried
  across the Actions of one request, so two Actions that each remove
  one of an entity's two memberships cannot both pass against the same
  cache snapshot — caches only advance once the Writer commits. The
  entity types the earlier Actions create are carried too, so a
  membership add in a later Action resolves the type the same request
  introduced.

  ## Bootstrap existence

  Existence is read from the entity-type index (`EntityIndex.exists?/2`),
  which the Writer maintains for every committed Update and retains for
  tombstones — so a deleted id still reads as existing and cannot be
  re-bootstrapped. The index only advances when the Writer commits, so a
  group created earlier in the same request still reads as new; that is
  acceptable because a request carries a single actor and that actor
  minted the group.
  """

  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.Fields
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper

  @typep validated_action :: %{
           id: String.t(),
           actor_id: String.t(),
           hlc: non_neg_integer(),
           updates: [validated_update()]
         }

  @typep validated_update :: %{
           id: String.t(),
           subject_id: String.t(),
           subject_type: String.t(),
           method: atom(),
           data: map() | nil
         }

  # What the request knows so far on top of the cache snapshot. Caches
  # only advance once the Writer commits, so the last-membership delta
  # and the entity types the earlier Actions resolve travel here.
  @typep request_sim :: %{
           additions: %{String.t() => [String.t()]},
           removals: %{String.t() => [String.t()]},
           types: %{String.t() => String.t()}
         }

  @doc """
  Authorizes a list of validated actions.

  Each action must pass authorization checks; the first failure is
  returned and the Action fails as a whole.
  """
  @spec authorize([validated_action()], String.t(), AuthorizationContext.t()) ::
          :ok | {:error, String.t(), String.t()}
  def authorize(actions, actor_id, ctx),
    do: authorize(actions, actor_id, ctx, new_sim())

  # The fourth argument is the running simulation of what the request's
  # earlier Actions added, removed and created. Caches only advance once
  # the Writer commits, so the last-membership delta and the entity
  # types must travel here (see `check_last_membership/2`).
  defp authorize([], _actor_id, _ctx, _sim), do: :ok

  defp authorize([action | rest], actor_id, ctx, sim) do
    case authorize_action(action, actor_id, ctx, sim) do
      {:ok, sim} -> authorize(rest, actor_id, ctx, sim)
      error -> error
    end
  end

  @spec new_sim() :: request_sim()
  defp new_sim, do: %{additions: %{}, removals: %{}, types: %{}}

  defp authorize_action(action, actor_id, ctx, sim) do
    updates = action.updates
    intra = PermissionHelper.build_intra_action_context(updates)
    opts = ctx_to_opts(ctx)
    exists? = fn entity_id -> EntityIndex.exists?(entity_id, opts) end

    authz = %{
      intra: intra,
      intra_opts: Keyword.put(opts, :intra_action, intra),
      bootstrap: PermissionHelper.bootstrap_group_permissions(updates, actor_id, exists?),
      created_ids: PermissionHelper.created_subject_ids(updates, exists?),
      created_types: Map.merge(sim.types, PermissionHelper.created_entity_types(updates)),
      deleted_memberships: resolve_deleted_memberships(updates, opts),
      opts: opts,
      ctx: ctx
    }

    with :ok <- check_all_updates(updates, actor_id, authz),
         {:ok, sim} <- check_last_membership(authz, sim) do
      {:ok, %{sim | types: authz.created_types}}
    end
  end

  defp check_all_updates(updates, actor_id, authz) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      result =
        if PermissionHelper.bootstrap_update?(
             update,
             actor_id,
             authz.bootstrap,
             authz.created_ids
           ) do
          :ok
        else
          authorize_update(update, actor_id, authz)
        end

      case result do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp authorize_update(update, actor_id, authz) do
    case update.subject_type do
      "group" -> authorize_group_update(update, actor_id, authz)
      "groupMember" -> authorize_group_member_update(update, actor_id, authz)
      "entityGroup" -> authorize_entity_group_update(update, actor_id, authz)
      "relationship" -> authorize_relationship_update(update, actor_id, authz)
      type -> authorize_user_entity_update(type, update, actor_id, authz)
    end
  end

  defp authorize_group_update(update, actor_id, authz) do
    check_group_permission(
      [update.subject_id],
      actor_id,
      "group",
      permission_for(update.method),
      authz
    )
  end

  defp authorize_group_member_update(update, actor_id, authz) do
    group_ids = system_entity_group_ids(update, "groupMember", authz)

    if group_ids == [] do
      {:error, "not_authorized", "cannot resolve the group for this groupMember"}
    else
      check_group_permission(
        group_ids,
        actor_id,
        "groupMember",
        permission_for(update.method),
        authz
      )
    end
  end

  # #264: an entity must never resolve to zero owning groups. The check
  # is a net delta per entity — its cached membership, plus the request's
  # `entityGroup` puts, minus its deletes, with re-added groups cancelled.
  # `build_intra_action_context/1` stays puts-only because other callers
  # rely on it being cache-free; the delete half is resolved here from the
  # membership index.
  defp check_last_membership(authz, sim) do
    additions = merge_additions(sim.additions, authz.intra)
    removals = merge_removals(sim.removals, deleted_group_ids(authz.deleted_memberships))
    touched = Enum.uniq(Map.keys(additions) ++ Map.keys(removals))

    if Enum.any?(touched, &(resulting_groups(&1, additions, removals, authz.opts) == [])) do
      {:error, "last_membership",
       "removing this membership would leave the entity with no owning group"}
    else
      {:ok, %{sim | additions: additions, removals: removals}}
    end
  end

  # A removed group is only subtracted when no put in the request re-adds
  # it: membership is per row, so a new row for a group the entity still
  # holds cancels the removal of the stale row.
  defp resulting_groups(entity_id, additions, removals, opts) do
    cached = EntityIndex.source_groups(entity_id, opts)
    added = Map.get(additions, entity_id, [])
    removed = Map.get(removals, entity_id, [])
    Enum.uniq(cached ++ added) -- removed -- added
  end

  defp merge_additions(prior, added) do
    Map.merge(prior, added, fn _entity_id, a, b -> Enum.uniq(a ++ b) end)
  end

  # Removals stay a multiset: each deleted row contributes one entry, so
  # a group removed twice within the request still nets to a removal.
  defp merge_removals(prior, removed) do
    Map.merge(prior, removed, fn _entity_id, a, b -> a ++ b end)
  end

  defp deleted_group_ids(deleted_memberships) do
    deleted_memberships
    |> Map.values()
    |> Enum.reject(&is_nil/1)
    |> Enum.reduce(%{}, fn {entity_id, group_id}, acc ->
      Map.update(acc, entity_id, [group_id], &[group_id | &1])
    end)
  end

  # Resolve every `entityGroup` delete once; the delete authorization and
  # the last-membership delta both read the resolved pair from `authz`.
  defp resolve_deleted_memberships(updates, opts) do
    updates
    |> Enum.filter(&(&1.subject_type == "entityGroup" and &1.method == :delete))
    |> Map.new(fn update ->
      {update.id, EntityIndex.membership(update.subject_id, opts)}
    end)
  end

  # Adding an entity to a group is gated by the entity's own
  # `<type>.create` in the target group (#121 "Add Entity to Group"), not
  # by the entity's whole group set. The type is the committed
  # entity-type index's when the entity already exists, otherwise a type
  # created by this Action or an earlier Action of the request; an
  # unresolvable type is a refusal (`entityGroup.create` would let any
  # group member graft an entity whose type they may not create). The
  # check is cache-only: the bootstrap's declared permissions stand in
  # only for the membership the same Action creates, and this update is
  # exempt only when the entity is created by that same Action (#289).
  defp authorize_entity_group_update(%{method: :put} = update, actor_id, authz) do
    entity_id = Fields.get(update.data, "entity_id")

    case entity_type(entity_id, authz) do
      nil ->
        {:error, "not_authorized", "cannot resolve the type of the entity being added to a group"}

      type ->
        check_group_permission(
          wire_group_ids(update),
          actor_id,
          type,
          "create",
          authz,
          &cached_permissions/3
        )
    end
  end

  # Removing membership is gated by the entity's `<type>.update` in any
  # group of its current set (union semantics), not by `entityGroup.delete`
  # in the removed group — the delete wire form drops the entity reference,
  # so the row is resolved from the membership index.
  defp authorize_entity_group_update(%{method: :delete} = update, actor_id, authz) do
    case Map.get(authz.deleted_memberships, update.id) do
      nil ->
        {:error, "not_authorized", "cannot resolve the entity for this membership"}

      {entity_id, _group_id} ->
        authorize_membership_delete(entity_id, actor_id, authz)
    end
  end

  defp authorize_entity_group_update(update, actor_id, authz) do
    check_group_permission(
      system_entity_group_ids(update, "entityGroup", authz),
      actor_id,
      "entityGroup",
      permission_for(update.method),
      authz,
      &cached_permissions/3
    )
  end

  defp authorize_membership_delete(entity_id, actor_id, authz) do
    case entity_type(entity_id, authz) do
      nil ->
        {:error, "not_authorized", "cannot resolve the type of the entity owning this membership"}

      type ->
        check_group_permission(
          EntityIndex.source_groups(entity_id, authz.opts),
          actor_id,
          type,
          "update",
          authz,
          &cached_permissions/3
        )
    end
  end

  # The resolved type of an entity. A committed type wins: an id the
  # entity-type index knows exists, so its recorded type is
  # authoritative and a re-`put` cannot spoof it. Types created earlier
  # in the request resolve only ids the index does not know yet.
  defp entity_type(entity_id, authz) do
    EntityIndex.subject_type(entity_id, authz.opts) || Map.get(authz.created_types, entity_id)
  end

  # A relationship is always a domain edge, and is authorized against its
  # source's membership set, never its own `target_id`: an app may hold a
  # domain link to a group entity. Puts carry the source on the wire;
  # patch/delete drop the data, so the by-id index supplies the source.
  # The permission type follows the source's **true** type, resolved from
  # the entity index — never the wire `data.type` label, which a client
  # can forge to borrow another type's permission (#323).
  defp authorize_relationship_update(%{method: :put} = update, actor_id, authz) do
    case source_entity_type(update, authz) do
      nil ->
        {:error, "not_authorized", "relationship source type is unresolvable"}

      source_type ->
        check_group_permission(
          relationship_group_ids(update, authz),
          actor_id,
          source_type,
          "update",
          authz
        )
    end
  end

  defp authorize_relationship_update(update, actor_id, authz) do
    check_group_permission(
      relationship_group_ids(update, authz),
      actor_id,
      "relationship",
      permission_for(update.method),
      authz
    )
  end

  # The source entity's committed type, or the type the same request
  # created when the index does not know the id yet. A put with no
  # `source_id`, or one the request cannot type, is unresolvable.
  defp source_entity_type(update, authz) do
    case Fields.get(update.data, "source_id") do
      nil -> nil
      source_id -> entity_type(source_id, authz)
    end
  end

  defp authorize_user_entity_update(type, update, actor_id, authz) do
    case EntityIndex.resolve_groups(type, update.subject_id, authz.intra_opts) do
      [] ->
        {:error, "missing_ownership",
         "entity has no group membership; every write must resolve at least one owning group"}

      group_ids ->
        check_group_permission(group_ids, actor_id, type, permission_for(update.method), authz)
    end
  end

  # Union semantics: the actor may hold the permission in any group of
  # the entity's set; the write is indexed into every group separately.
  # `permissions_fun` selects the source: the cache unioned with the
  # Action's declared bootstrap permissions by default, or the cache
  # alone for membership mutations of an existing entity.
  defp check_group_permission(
         group_ids,
         actor_id,
         type,
         permission,
         authz,
         permissions_fun \\ &permissions_for/3
       ) do
    has_permission =
      group_ids
      |> Enum.reject(&is_nil/1)
      |> Enum.any?(fn group_id ->
        case permissions_fun.(actor_id, group_id, authz) do
          nil ->
            false

          permissions ->
            PermissionHelper.check_permission(permissions, type, permission)
        end
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "missing required permission"}
    end
  end

  # Membership mutations of an **existing** entity require a real
  # membership holding `<type>.create` / `<type>.update` in the target
  # group. The bootstrap's declared permissions stand in only for the
  # membership the same Action creates and cover only the entities that
  # bootstrap creates (`bootstrap_update?/4`), so they must not be
  # unioned here — unioning them would let an actor file an existing
  # entity into their new group and write to it under the self-grant
  # (#289). Cache-only and deliberately blind to `authz.bootstrap`.
  defp cached_permissions(actor_id, group_id, authz) do
    GroupCache.get_permissions(actor_id, group_id, authz.ctx.group_members_table)
  end

  # The actor's declared bootstrap permissions are unioned with the
  # cache: the membership row is written after authorization, so during
  # the bootstrap Action the cache has nothing for the new group.
  defp permissions_for(actor_id, group_id, authz) do
    cached = GroupCache.get_permissions(actor_id, group_id, authz.ctx.group_members_table)
    declared = Map.get(authz.bootstrap, group_id)

    if is_nil(cached) and is_nil(declared) do
      nil
    else
      Enum.uniq((cached || []) ++ (declared || []))
    end
  end

  # When the data envelope carries the group id, prefer it (first-wins);
  # otherwise resolve via the by-id index — required for system-entity
  # deletes, whose wire form drops the data fields.
  defp system_entity_group_ids(%{data: data, subject_id: id}, type, authz) do
    case Fields.get(data, "group_id") do
      nil -> EntityIndex.resolve_groups(type, id, authz.opts)
      group_id -> [group_id]
    end
  end

  defp wire_group_ids(update), do: [Fields.get(update.data, "group_id")]

  defp relationship_group_ids(update, authz) do
    EntityIndex.relationship_groups(
      Fields.get(update.data, "source_id"),
      update.subject_id,
      authz.intra_opts
    )
  end

  defp permission_for(method), do: PermissionHelper.method_to_permission(Atom.to_string(method))

  defp ctx_to_opts(ctx) do
    [
      entity_groups: ctx.entity_groups_table,
      entity_groups_by_id: ctx.entity_groups_by_id_table,
      entity_types: ctx.entity_types_table,
      relationships_by_id: ctx.relationships_by_id_table,
      group_members_by_id: ctx.group_members_by_id_table
    ]
  end
end
