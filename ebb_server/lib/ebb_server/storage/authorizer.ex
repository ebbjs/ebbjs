defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Authorizes validated actions against the #121 permission table.

  Every Update in an Action is checked individually; the first failure
  rejects that Action. Authorization is per-Action: a rejected Action is
  reported beside its accepted siblings instead of failing the batch
  (#469). Only accepted Actions advance the request simulation, so a
  rejected Action's created entity types and membership delta never
  resolve for a later Action.

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
  the id, the `groupMember` exemption only covers row ids the caches and
  the index do not know, and the `entityGroup` exemption covers only
  user entities the Action actually creates. Re-`put`ting a committed
  group, a committed membership row or a committed entity falls through
  to the permission table like any other write (#289, #625), and the
  declared permissions are never unioned into the membership checks for
  entities that already exist.

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
      the bootstrap covers only the acting actor's own membership row,
      and only while that row is new. A mutation of an existing row is
      bound to the group the row already belongs to (#625): a row that
      moves groups needs the permission in both the group it leaves and
      the group it enters, and a `groupMember` mutation never runs on the
      Action's declared bootstrap permissions.
    - `entityGroup` put → the added entity's `<type>.create` in the
      target group: the group(s) the put files the entity into (#121's
      "Add Entity to Group" row), not the entity's whole group set. The
      type is the committed entity-type index's when the entity already
      exists, otherwise a type created by the same Action or by an
      earlier Action of the same request. An unresolvable type is
      refused (`not_authorized`) rather than falling back to the
      `entityGroup.create` system permission. Filing an existing entity
      into a group is the share/invite primitive: the target group's
      `<type>.create` is the whole gate, so an inviter does not need
      write access to the entity's current group (#623 tracks whether
      that primitive needs a consent step). Re-putting a membership row
      may move it to another group but may not re-point it at a different
      entity, and an entity the index knows but that owns no group is
      refused rather than claimed. Membership mutations of an existing
      entity are checked against cached memberships only —
      the bootstrap's declared permissions stand in only for the
      membership the same Action creates.
    - `entityGroup` delete → the entity's `<type>.update` in any group of
      the entity's current set (union/any-match). The delete wire form
      drops the entity reference, so the row is resolved from the
      membership index.
    - `entityGroup` patch → refused. It is authorized against the group
      named on the wire and mints a membership row when the row id is
      unknown, so it can file an arbitrary entity into the caller's group
      (#623). Express the same change as a delete plus a put.
    - `relationship` put (always a domain edge; membership is
      `entityGroup`) → the source entity's `<type>.update` in the
      source's group set, where `<type>` is the source entity's true
      type resolved from the entity index (#323). The wire `data.type`
      field is a descriptive label and is never consulted for
      authorization, so a forged value cannot borrow another type's
      permission. A relationship row's source is its row identity: a put
      or patch whose wire `source_id` differs from the stored row's
      source is refused (#624), whatever permission the caller holds for
      the new source. Changing the target, type or field of an edge keeps
      the source and stays a normal write. `relationship` patch/delete →
      `relationship.update` / `relationship.delete` in the edge's source
      group set.
    - A `relationship` delete is scoped by the **stored row's** source,
      never by a wire `source_id`. The delete wire form may carry the
      data envelope, and honouring it would let a caller delete another
      group's edge with their own group's permissions (#624). Only a
      delete with no stored row — an edge created earlier in the request,
      or one already tombstoned — falls back to the wire source.

  Moving an edge to another source is a delete plus a put, in one Action
  or in two Actions of the same request: the request's own accepted
  delete releases the row's source binding, so the put is a create in the
  new source's groups. The delete still has to pass against the stored
  row's groups, so naming the row as deleted is not a way around that
  permission.

  ## User entities

  User-entity writes require `<type>.<verb>` in at least one group of
  the entity's group set (union/any-match), where `<type>` is the type
  the id was **committed** under, not the wire `subject_type`: the wire
  type is client input, and an existing id may not change type (#624). An
  id that exists but whose type cannot be resolved — a membership row the
  entity-type index has not caught up with — is refused rather than
  written under the wire type. A write whose resolved set is empty — an
  unowned entity, or an id that does not exist — is a structural
  rejection (`missing_ownership`), not a permission failure.

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

  ## Last group member

  A group must keep at least one membership holding a non-empty
  permission list. Anything a `groupMember` put, patch or delete would
  do to leave it with none is a structural rejection
  (`last_group_member`), beside `last_membership` (#479). Permissions
  live only on `groupMember` rows and `GroupCache.get_permissions/3`
  treats an empty list as no membership, so a group with no capable
  row is unreachable through the API.

  The check mirrors `last_membership`: the affected groups' cached
  members, plus the request's puts and patches, minus its deletes, with
  a member's group change moving it between groups. The delta is
  carried across the Actions of one request, so two Actions that each
  remove one of a group's two capable members cannot both pass against
  the same cache snapshot.

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
  alias EbbServer.Storage.EntityGroupCache
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.Fields
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.PermissionHelper
  alias EbbServer.Storage.RelationshipCache

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
  @typep group_member_row :: %{
           id: String.t(),
           group_id: String.t(),
           permissions: [String.t()]
         }

  # A touched group's members as the request leaves them.
  @typep members_by_group :: %{String.t() => %{String.t() => [String.t()]}}

  @typep request_sim :: %{
           additions: %{String.t() => [String.t()]},
           removals: %{String.t() => [String.t()]},
           types: %{String.t() => String.t()},
           member_overlay: %{String.t() => group_member_row() | nil},
           members_by_group: members_by_group(),
           deleted_relationships: MapSet.t(String.t())
         }

  @type rejection :: %{
          action: validated_action(),
          reason: String.t(),
          details: String.t() | nil
        }

  @doc """
  Authorizes a list of validated actions, returning the accepted Actions
  and the per-Action rejections.

  A rejected Action is reported and left out of the accepted list while
  its siblings proceed. The request simulation advances only for
  accepted Actions, so a rejected Action contributes neither its created
  entity types nor its membership delta to a later Action.
  """
  @spec authorize([validated_action()], String.t(), AuthorizationContext.t()) ::
          {accepted :: [validated_action()], rejected :: [rejection()]}
  def authorize(actions, actor_id, ctx),
    do: authorize(actions, actor_id, ctx, new_sim(), [], [])

  # The fourth argument is the running simulation of what the request's
  # earlier **accepted** Actions added, removed and created. Caches only
  # advance once the Writer commits, so the last-membership delta and the
  # entity types must travel here (see `check_last_membership/2`).
  defp authorize([], _actor_id, _ctx, _sim, accepted, rejected),
    do: {Enum.reverse(accepted), Enum.reverse(rejected)}

  defp authorize([action | rest], actor_id, ctx, sim, accepted, rejected) do
    case authorize_action(action, actor_id, ctx, sim) do
      {:ok, next_sim} ->
        authorize(rest, actor_id, ctx, next_sim, [action | accepted], rejected)

      {:error, reason, details} ->
        authorize(rest, actor_id, ctx, sim, accepted, [
          %{action: action, reason: reason, details: details} | rejected
        ])
    end
  end

  @spec new_sim() :: request_sim()
  defp new_sim,
    do: %{
      additions: %{},
      removals: %{},
      types: %{},
      member_overlay: %{},
      members_by_group: %{},
      deleted_relationships: MapSet.new()
    }

  defp authorize_action(action, actor_id, ctx, sim) do
    updates = action.updates
    intra = PermissionHelper.build_intra_action_context(updates)
    opts = ctx_to_opts(ctx)
    exists? = fn entity_id -> EntityIndex.exists?(entity_id, opts) end

    # A membership row's existence must not depend on the type index alone:
    # that index is repaired asynchronously and can lag the group cache, and
    # a lagging index would re-open the bootstrap exemption for a row that
    # already exists (#625).
    member_exists? = fn member_id ->
      exists?.(member_id) or
        GroupCache.get_group_member(member_id, ctx.group_members_by_id_table) != nil
    end

    authz = %{
      intra: intra,
      intra_opts: Keyword.put(opts, :intra_action, intra),
      bootstrap: PermissionHelper.bootstrap_group_permissions(updates, actor_id, exists?),
      bootstrap_membership_ids:
        PermissionHelper.bootstrap_membership_row_ids(updates, actor_id, member_exists?),
      created_ids: PermissionHelper.created_subject_ids(updates, exists?),
      # An id the request already typed keeps that type: a later Action may
      # only type ids the simulation does not know.
      created_types: Map.merge(PermissionHelper.created_entity_types(updates), sim.types),
      deleted_memberships: resolve_deleted_memberships(updates, opts),
      deleted_relationships:
        MapSet.union(sim.deleted_relationships, deleted_relationship_ids(updates)),
      updates: updates,
      opts: opts,
      ctx: ctx
    }

    with :ok <- check_all_updates(updates, actor_id, authz),
         {:ok, sim} <- check_last_membership(authz, sim),
         {:ok, sim} <- check_last_group_member(authz, sim) do
      {:ok,
       %{sim | types: authz.created_types, deleted_relationships: authz.deleted_relationships}}
    end
  end

  defp check_all_updates(updates, actor_id, authz) do
    Enum.reduce_while(updates, :ok, fn update, _acc ->
      case check_update(update, actor_id, authz) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  # Row identity is not a permission: the bootstrap exemption covers
  # *creating* a membership, never re-pointing an existing row, so this
  # check runs before the exemption (#623). A relationship row's source is
  # identity too (#624). An id's type is identity too: the wire
  # `subject_type` is client input, so a relabel may not ride the
  # bootstrap either (#624).
  defp check_update(update, actor_id, authz) do
    with :ok <- check_update_row_identity(update, authz),
         :ok <- check_update_type_identity(update, authz) do
      authorize_or_exempt(update, actor_id, authz)
    end
  end

  defp authorize_or_exempt(update, actor_id, authz) do
    if PermissionHelper.bootstrap_update?(
         update,
         actor_id,
         authz.bootstrap,
         authz.created_ids,
         authz.bootstrap_membership_ids
       ) do
      :ok
    else
      authorize_update(update, actor_id, authz)
    end
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
    case existing_group_member(update.subject_id, authz) do
      :new ->
        authorize_new_group_member_update(update, actor_id, authz)

      :unresolved ->
        {:error, "not_authorized", "cannot resolve the group of this groupMember row"}

      {:existing, group_id} ->
        authorize_existing_group_member_update(update, group_id, actor_id, authz)
    end
  end

  defp authorize_new_group_member_update(update, actor_id, authz) do
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

  # #625: an existing row stays bound to the group it belongs to. The
  # cache is consulted without the bootstrap's declared permissions,
  # which cover only the membership the same Action creates. A move is
  # checked in both the group the row leaves and the one it enters.
  defp authorize_existing_group_member_update(update, existing_group, actor_id, authz) do
    group_ids = Enum.uniq([existing_group | wire_group_ids(update)])

    check_every_group_permission(
      group_ids,
      actor_id,
      "groupMember",
      permission_for(update.method),
      authz
    )
  end

  # `:new` when nothing knows the id, `{:existing, group_id}` when the
  # by-id index can place the row. `:unresolved` is an id the existence
  # index still knows after the cache dropped it: a tombstone must not be
  # re-filed as a fresh row.
  defp existing_group_member(member_id, authz) do
    case GroupCache.get_group_member(member_id, authz.ctx.group_members_by_id_table) do
      nil ->
        if EntityIndex.exists?(member_id, authz.opts), do: :unresolved, else: :new

      row ->
        {:existing, row.group_id}
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

  # #479: a group must never resolve to zero memberships holding a
  # non-empty permission list. Permissions live only on `groupMember`
  # rows and `get_permissions/3` treats an empty list as no membership,
  # so a group with no capable row is unreachable through the API. The
  # check is a net delta per touched group, carried across the request's
  # Actions because caches only advance once the Writer commits.
  defp check_last_group_member(authz, sim) do
    sim =
      authz.updates
      |> Enum.filter(&(&1.subject_type == "groupMember"))
      |> Enum.reduce(sim, fn update, acc -> apply_group_member(update, authz, acc) end)

    if Enum.any?(sim.members_by_group, fn {_group_id, members} -> not capable_group?(members) end) do
      {:error, "last_group_member",
       "removing this membership would leave the group with no member that can administer it"}
    else
      {:ok, sim}
    end
  end

  defp apply_group_member(%{method: method} = update, authz, sim) when method in [:put, :patch] do
    data = update.data || %{}
    existing = resolve_group_member(update.subject_id, authz, sim)
    group_id = member_group_id(method, data, existing)

    if is_nil(group_id) do
      sim
    else
      row = %{
        id: update.subject_id,
        group_id: group_id,
        permissions: resulting_permissions(method, data, existing)
      }

      sim =
        sim
        |> remove_moved_member(existing, row, authz)
        |> add_group_member(row, authz)

      %{sim | member_overlay: Map.put(sim.member_overlay, row.id, row)}
    end
  end

  defp apply_group_member(%{method: :delete} = update, authz, sim) do
    case resolve_group_member(update.subject_id, authz, sim) do
      nil ->
        sim

      row ->
        sim = remove_group_member(sim, row.id, row.group_id, authz)
        %{sim | member_overlay: Map.put(sim.member_overlay, row.id, nil)}
    end
  end

  # A put's wire fields are authoritative, so a put that drops the group
  # is a no-op, matching the Writer. A patch falls back to the row it
  # names.
  defp member_group_id(:put, data, _existing), do: Fields.get(data, "group_id")

  defp member_group_id(:patch, data, existing),
    do: Fields.get(data, "group_id") || (existing && existing.group_id)

  defp resulting_permissions(:put, data, _existing),
    do: List.wrap(Fields.get(data, "permissions"))

  defp resulting_permissions(:patch, data, existing) do
    case Fields.get(data, "permissions") do
      nil -> List.wrap(existing && existing.permissions)
      permissions -> List.wrap(permissions)
    end
  end

  # The request's own prior effect first, the committed cache otherwise.
  defp resolve_group_member(member_id, authz, sim) do
    case Map.fetch(sim.member_overlay, member_id) do
      {:ok, row} -> row
      :error -> cached_group_member(member_id, authz)
    end
  end

  defp cached_group_member(member_id, authz) do
    case GroupCache.get_group_member(member_id, authz.ctx.group_members_by_id_table) do
      nil ->
        nil

      row ->
        %{id: member_id, group_id: row.group_id, permissions: List.wrap(row.permissions)}
    end
  end

  defp remove_moved_member(sim, %{group_id: old_group, id: id}, %{group_id: new_group}, authz)
       when old_group != new_group,
       do: remove_group_member(sim, id, old_group, authz)

  defp remove_moved_member(sim, _existing, _row, _authz), do: sim

  defp remove_group_member(sim, member_id, group_id, authz) do
    members = ensure_group(sim.members_by_group, group_id, authz)

    %{
      sim
      | members_by_group: Map.put(sim.members_by_group, group_id, Map.delete(members, member_id))
    }
  end

  defp add_group_member(sim, row, authz) do
    members = ensure_group(sim.members_by_group, row.group_id, authz)

    %{
      sim
      | members_by_group:
          Map.put(sim.members_by_group, row.group_id, Map.put(members, row.id, row.permissions))
    }
  end

  defp ensure_group(members_by_group, group_id, authz) do
    Map.get_lazy(members_by_group, group_id, fn -> load_group(group_id, authz) end)
  end

  defp load_group(group_id, authz) do
    group_id
    |> GroupCache.group_member_ids(authz.ctx.group_members_by_group_table)
    |> Enum.reduce(%{}, fn member_id, acc ->
      case cached_group_member(member_id, authz) do
        nil -> acc
        row -> Map.put(acc, member_id, row.permissions)
      end
    end)
  end

  defp capable_group?(members) do
    Enum.any?(members, fn {_member_id, permissions} -> permissions != [] end)
  end

  # Resolve every `entityGroup` delete once; the delete authorization and
  # the last-membership delta both read the resolved pair from `authz`.
  # Keyed by the membership row id, not the update id: two deletes with a
  # duplicate update id name different rows, and collapsing them would
  # authorize one against the other's entity and hide one removal from the
  # last-membership guard (#623).
  defp resolve_deleted_memberships(updates, opts) do
    updates
    |> Enum.filter(&(&1.subject_type == "entityGroup" and &1.method == :delete))
    |> Map.new(fn update ->
      {update.subject_id, EntityIndex.membership(update.subject_id, opts)}
    end)
  end

  # Adding an entity to a group is gated by the entity's own
  # `<type>.create` in the target group (#121 "Add Entity to Group"), not
  # by the entity's whole group set. The type is the committed
  # entity-type index's when the entity already exists, otherwise a type
  # created by this Action or an earlier Action of the request; an
  # unresolvable type is a refusal (`entityGroup.create` would let any
  # group member graft an entity whose type they may not create).
  #
  # `create` in the target group alone is not enough for an entity that
  # already has an owner: an actor can self-grant `<type>.create` in a
  # group they bootstrapped, so otherwise they could file another
  # tenant's entity into it and read or write it through the normal group
  # resolution paths (#623). When the entity is already owned elsewhere,
  # filing it is also a membership change, so it needs `<type>.update` in
  # one of its current groups. Re-filing an entity into a group it is
  # already in grants nothing new and stays allowed.
  #
  # Both checks are cache-only: the bootstrap's declared permissions
  # stand in only for the membership the same Action creates, and this
  # update is exempt only when the entity is created by that same Action
  # (#289).
  defp authorize_entity_group_update(%{method: :put} = update, actor_id, authz) do
    with {:ok, entity_id, group_id} <- membership_identity(update) do
      authorize_entity_group_put(entity_id, group_id, actor_id, authz)
    end
  end

  # Removing membership is gated by the entity's `<type>.update` in any
  # group of its current set (union semantics), not by `entityGroup.delete`
  # in the removed group — the delete wire form drops the entity reference,
  # so the row is resolved from the membership index.
  defp authorize_entity_group_update(%{method: :delete} = update, actor_id, authz) do
    case Map.get(authz.deleted_memberships, update.subject_id) do
      nil ->
        {:error, "not_authorized", "cannot resolve the entity for this membership"}

      {entity_id, _group_id} ->
        authorize_membership_delete(entity_id, actor_id, authz)
    end
  end

  # #623: a patch is authorized against the group named on the wire and
  # writes a membership row when the row id is unknown, so it can file any
  # entity into the caller's group. Refusing the method is the interim fix
  # until the patch path is bound to the row it targets.
  defp authorize_entity_group_update(update, _actor_id, _authz) do
    {:error, "not_authorized",
     "entityGroup #{update.method} is not supported: delete and re-put the membership instead"}
  end

  # A list or map here would be stored verbatim by the mutation planner and
  # corrupt the membership indices; a membership names one entity and one
  # group.
  defp membership_identity(update) do
    entity_id = Fields.get(update.data, "entity_id")
    group_id = Fields.get(update.data, "group_id")

    if is_binary(entity_id) and entity_id != "" and is_binary(group_id) and group_id != "" do
      {:ok, entity_id, group_id}
    else
      {:error, "not_authorized", "entityGroup put needs a string entity_id and group_id"}
    end
  end

  defp authorize_entity_group_put(entity_id, group_id, actor_id, authz) do
    case entity_type(entity_id, authz) do
      nil ->
        {:error, "not_authorized", "cannot resolve the type of the entity being added to a group"}

      type ->
        with :ok <-
               check_group_permission(
                 [group_id],
                 actor_id,
                 type,
                 "create",
                 authz,
                 &cached_permissions/3
               ) do
          check_not_ownerless(entity_id, authz)
        end
    end
  end

  defp check_update_row_identity(%{subject_type: "entityGroup", method: :put} = update, authz) do
    check_membership_row_entity(update.subject_id, Fields.get(update.data, "entity_id"), authz)
  end

  defp check_update_row_identity(%{subject_type: "relationship", method: method} = update, authz)
       when method in [:put, :patch] do
    check_relationship_row_source(update.subject_id, Fields.get(update.data, "source_id"), authz)
  end

  defp check_update_row_identity(_update, _authz), do: :ok

  # A relationship row's source is its identity, like an `entityGroup`
  # row's entity (#623): the row fans out to the source's group set, so
  # re-pointing it would drop the edge out of its owner's projections and
  # hand it to the caller (#624). A put or patch that keeps the source
  # stays a normal write (target/type/field may change); moving an edge to
  # another source is a delete plus a put. The delete is scoped by the
  # stored row's source, never by a wire `source_id`, so it cannot reach a
  # row in another group. A patch that omits `source_id` cannot be applied
  # (`CacheMutationPlanner` drops it), so there is nothing to re-point: the
  # check answers about the source the request declares, and the stored
  # row's groups authorize the no-op as before.
  #
  # No committed source is not a refusal. A by-id row can be missing because
  # the edge is new, because this request deleted it, or because it is
  # already a tombstone — deleted rows keep their entity-type entry, so the
  # type index cannot tell those apart. All three authorize as a fresh row;
  # failing closed here would refuse the delete-plus-put that moves an edge.
  # A delete in the request releases the binding only: the delete itself is
  # authorized against the stored row's groups, so a put cannot ride a
  # delete the caller may not perform.
  defp check_relationship_row_source(relationship_id, source_id, authz) do
    committed = committed_relationship_source(relationship_id, authz)

    cond do
      is_nil(source_id) ->
        :ok

      is_nil(committed) ->
        :ok

      committed == source_id ->
        :ok

      true ->
        {:error, "not_authorized", "a relationship row cannot be re-pointed at another source"}
    end
  end

  defp committed_relationship_source(relationship_id, authz) do
    if MapSet.member?(authz.deleted_relationships, relationship_id) do
      nil
    else
      EntityIndex.relationship_source(relationship_id, authz.opts)
    end
  end

  # Unlike `entityGroup` deletes, which resolve their row up front because
  # the authorization and the last-membership delta both need it, a
  # `relationship` delete only has to release the row's source binding, so
  # the ids suffice: delete plus put is how an edge moves (#624), and the
  # caches do not advance until the Writer commits, so without this the id
  # would still look bound to the source it was just deleted from.
  defp deleted_relationship_ids(updates) do
    updates
    |> Enum.filter(&(&1.subject_type == "relationship" and &1.method == :delete))
    |> MapSet.new(& &1.subject_id)
  end

  # The type an id was committed under is authoritative; the wire
  # `subject_type` is client input. Every stage downstream — the
  # permission lookup, the materialized row's type, the entity-type index
  # — keys on the wire type, so a mismatch lets a permission on one type
  # in the group rewrite, delete or relabel every other type's entities
  # there (#624). Fail closed: the wire type stands only for an id nothing
  # has committed yet, and the committed type is never echoed back.
  defp check_update_type_identity(update, authz) do
    id = update.subject_id

    case committed_type(id, authz) do
      nil -> check_unresolved_type(update, authz)
      committed -> require_wire_type(committed, update)
    end
  end

  # A committed id can reach here untyped: the type index is a projection
  # that an ablation (`EBB_ABLATE=type_entities`) or an unfinished rebuild
  # can omit an entry from. A membership row proves the id is not new and
  # nothing types it, so the wire type cannot stand in for a committed one
  # (#624). An id nothing records is new, and the type the request gave it —
  # an earlier Action's create or this Action's own put — is the only type
  # there is.
  defp check_unresolved_type(update, authz) do
    if EntityIndex.source_groups(update.subject_id, authz.opts) != [] do
      {:error, "not_authorized", "cannot resolve the type this entity was committed under"}
    else
      case Map.get(authz.created_types, update.subject_id) do
        nil -> :ok
        request_type -> require_wire_type(request_type, update)
      end
    end
  end

  defp require_wire_type(type, %{subject_type: type}), do: :ok

  defp require_wire_type(_committed, _update) do
    {:error, "not_authorized",
     "update subject_type does not match the type this entity was committed under"}
  end

  # The entity-type index wins whenever it has an entry; failing that, a by-id
  # cache row carries its system type by construction.
  defp committed_type(entity_id, authz) do
    EntityIndex.subject_type(entity_id, authz.opts) || cached_system_type(entity_id, authz)
  end

  # A membership row only says some entity owns the id and types nothing.
  defp cached_system_type(entity_id, authz) do
    cond do
      GroupCache.get_group_member(entity_id, Keyword.fetch!(authz.opts, :group_members_by_id)) !=
          nil ->
        "groupMember"

      EntityGroupCache.get_entity_group(
        entity_id,
        Keyword.fetch!(authz.opts, :entity_groups_by_id)
      ) != nil ->
        "entityGroup"

      RelationshipCache.get_relationship(
        entity_id,
        Keyword.fetch!(authz.opts, :relationships_by_id)
      ) != nil ->
        "relationship"

      true ->
        nil
    end
  end

  # A membership row names one `(entity, group)` pair. A re-put may move
  # the row to another group, but it must not re-point it at a different
  # entity: the row's old owner would silently lose that membership
  # without the last-membership guard seeing it, and an orphaned entity
  # could then be claimed by anyone (#623).
  defp check_membership_row_entity(membership_id, entity_id, authz) do
    case EntityIndex.membership(membership_id, authz.opts) do
      nil ->
        :ok

      {^entity_id, _group_id} ->
        :ok

      {_other_entity_id, _group_id} ->
        {:error, "not_authorized", "a membership row cannot be re-pointed at another entity"}
    end
  end

  # An entity the existence index does not know is new to the read model
  # (created by this request), and the target-group `create` is the whole
  # gate. An entity it knows but that resolves to no group is an orphan
  # or a tombstone: fail closed rather than letting the first caller claim
  # it. An owned entity stays the share/invite primitive (#623).
  defp check_not_ownerless(entity_id, authz) do
    if EntityIndex.source_groups(entity_id, authz.opts) == [] and
         EntityIndex.exists?(entity_id, authz.opts) do
      {:error, "not_authorized", "cannot file an entity that has no owning group"}
    else
      :ok
    end
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

  # Every group must grant the permission: a mutation that moves a row
  # between groups needs it on both sides, so the union semantics of
  # `check_group_permission/6` are not enough here.
  defp check_every_group_permission(group_ids, actor_id, type, permission, authz) do
    Enum.reduce_while(group_ids, :ok, fn group_id, :ok ->
      case check_group_permission(
             [group_id],
             actor_id,
             type,
             permission,
             authz,
             &cached_permissions/3
           ) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
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

  defp wire_group_ids(update) do
    update.data
    |> Fields.get("group_id")
    |> List.wrap()
  end

  defp relationship_group_ids(update, authz) do
    EntityIndex.relationship_groups(
      update.method,
      Fields.get(update.data, "source_id"),
      update.subject_id,
      authz.intra_opts
    )
  end

  defp permission_for(method), do: PermissionHelper.method_to_permission(Atom.to_string(method))

  defp ctx_to_opts(ctx) do
    AuthorizationContext.to_opts(ctx)
  end
end
