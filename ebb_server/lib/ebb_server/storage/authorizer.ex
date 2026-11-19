defmodule EbbServer.Storage.Authorizer do
  @moduledoc """
  Authorizes validated actions against the #121 permission table.

  The wire names one component or the row per Update, but every rule here is a
  rule about a row, so authorization runs against the Action's folded row
  mutations (`EbbServer.Storage.RowMutations`). The first failure rejects
  that Action. Authorization is per-Action: a rejected Action is reported
  beside its accepted siblings instead of failing the batch (#469). Only
  accepted Actions advance the request simulation, so a rejected Action's
  created models and membership delta never resolve for a later Action.

  ## Bootstrap

  An actor creating a group has no membership to check against, so the
  `ebb/group` create and the actor's own `ebb/grant` create cannot be
  authorized by the table. Those two — plus the `ebb/membership` row filing
  an entity the same Action creates into the new group — are exempt
  (`PermissionHelper.bootstrap_update?/5`). Everything else in the
  Action is authorized normally, using the permissions the actor grants
  themselves in their own `ebb/grant` row: while the Action is being
  authorized the actor's new grant row is not in the cache yet, so the
  declared permissions stand in for it.

  The exemption applies only to entities the Action is **creating**: a
  `ebb/group` create qualifies only when the entity-model cache does not know
  the id, the `ebb/grant` exemption only covers row ids the caches and
  the index do not know, and the `ebb/membership` exemption covers only
  user entities the Action actually creates. Writing a committed group,
  a committed grant row or a committed entity again falls through
  to the permission table like any other write (#289, #625), and the
  declared permissions are never unioned into the membership checks for
  entities that already exist.

  This is deliberately per-row rather than a whole-Action short-circuit
  (#246): a third-party `ebb/grant`, a link edge for an unrelated entity,
  or a write to an existing entity all fall through to the table even when
  they ride along with a bootstrap.

  ## System components

  `ebb/` is the platform namespace. `ebb/group`, `ebb/grant` and
  `ebb/membership` are the components of rows committed under the model
  `ebb`, and such a row carries exactly one of them. `ebb/link` is
  different ([#820](https://github.com/ebbjs/ebbjs/issues/820)): it is a
  **keyed component of its source row**, so the row carrying it is an
  ordinary row of its own model and the edge's key is its source. Every rule
  below dispatches on that **kind**, never on a model. Which group set a
  write resolves to is not a rule here — it is declared on the component and
  read through `SystemComponent` and `EntityScope` (`fan_out_groups/2`) — so
  these are the **permission** rules that ride on that scope. The subject is
  the component the write names — `ebb/<kind>`, e.g. `ebb/grant.create` —
  and grants match by ancestry, so `ebb.*` covers all four without a special
  case. The permission verb follows from the two facts: a create asks for
  `<subject>.create`, a delete asks for `<subject>.delete`, and a write to
  an existing row asks for `<subject>.update`.

    - `ebb/group` → `ebb/group.create` / `ebb/group.update` /
      `ebb/group.delete` in the group. A group create
      only passes through the bootstrap exemption; minting a group and
      handing it to somebody else is not allowed.
    - `ebb/grant` → `ebb/grant.create` / `ebb/grant.update` /
      `ebb/grant.delete` in the target group.
      Adding an actor to a group is `ebb/grant.create` in that group;
      the bootstrap covers only the acting actor's own grant row, and
      only while that row is new. A write to an existing row is bound
      to the group the row already belongs to (#625), and that group is
      immutable (a system component's key never moves): moving an actor between groups is a delete
      plus a create, so a grant write never runs on the Action's
      declared bootstrap permissions.
    - `ebb/membership` create → the added entity's `<model>.create` in the
      target group: the group(s) the write files the entity into (#121's
      "Add Entity to Group" row), not the entity's whole group set. The
      model is the committed entity-model cache's when the entity already
      exists, otherwise one created by the same Action or by an earlier
      Action of the same request. An unresolvable model is refused
      (`not_authorized`) rather than falling back to the
      `ebb/membership.create` system permission. Filing an entity the
      index already places in a group is a write to that entity — it adds
      the target group to the set that authorizes updates and deletes —
      so it also needs `<model>.update` in one of the entity's current
      groups; a known id is not authority (#623). Two shapes keep the
      target gate alone: an entity new to the index, because the same
      Action is creating it, and a write naming the pair the row already
      has, because a no-op adds nothing to the group set and a retried
      Action (#285) was authored without the write permission it would
      need. `(entity_id, group_id)` is immutable (a system component's key never moves): a
      re-write may name the pair the row already has, and any other pair is
      refused rather than applied. An entity the index knows but that
      owns no group is refused rather than claimed. A write may re-write the
      pair's live row but never mint a second row for the same
      `(entity, group)`, whatever permission the caller holds (#623).
      Membership writes to an existing entity are checked against
      cached memberships only — the bootstrap's declared permissions
      stand in only for the membership the same Action creates.
    - `ebb/membership` delete → the entity's `<model>.update` in any
      group of the entity's current set (union/any-match). The delete
      names no component, so the row is resolved from the membership
      index.
    - `ebb/link` → `ebb/link.<verb>` in the **source's** group set. The
      source is the Update's subject: an edge is a keyed component of the
      row it leaves, so the write is scoped and delivered exactly as that
      row is, and its target never lends it a scope (an edge may point at a
      `group` entity). The value's `type` is a descriptive label and is
      never consulted for authorization, so a forged value cannot borrow
      another model's permission (#323). Nothing is re-pointed: an edge
      keyed on its source has no source field to move, so moving one is two
      keys — a removal under the old source and an addition under the new —
      not one row with two identities.

  An `ebb/*` write to a user row is an overlay: it adds a component and
  leaves the row's committed model alone, so an overlay write is authorized
  as `ebb/link.*` and never as a grant on the row's model. That is the point
  of naming the component rather than reusing a declared field — a
  model-level grant for a row's data does not authorize an edge.

  ## User entities

  A user row's write names its subject: a create or a delete checks the
  model (`note.create`, `note.delete`) because neither names a component,
  and an update checks **every** component the wire names
  (`note/body.update`). Grants match by ancestry, so a model grant still
  covers its components — `note.*` covers `note/body`, while
  `note/title.*` covers only `note/title`. That is what keeps a whole-model
  grant, a mirror with no existing data, and a field added after the grant
  was written all working, and it lets an app separate fields by granting
  the field and never the model. The server holds no schema, so it cannot
  reject a component under a committed model that it has never seen; the
  client refuses those.

  The permission is required in at least one group of the entity's group
  set (union/any-match), where `<model>` is the model the id was
  **committed** under, not the one its component prefix names:
  the prefix is client input, and an existing id may not change model
  (#624). An id that exists but whose model cannot be resolved — a
  membership row the entity-model cache has not caught up with — is
  refused rather than written under the prefix's model. A write whose
  resolved set is empty — an unowned entity, or an id that does not exist
  — is a structural rejection (`missing_ownership`), not a permission
  failure.

  ## Last membership

  An entity must keep at least one owning group. Anything that would
  leave it with none is a structural rejection (`last_membership`),
  beside `missing_ownership` (#264). The check is a per-entity net
  delta: the entity's cached membership set, plus the `ebb/membership`
  writes seen in the request, minus its `ebb/membership` deletes, with a
  removed group cancelled when a write re-adds it. Membership is per
  **row**, so writing a second row for a group the entity already
  belongs to keeps that group even when the same Action (or a later
  Action of the request) deletes the old row. The delta is carried
  across the Actions of one request, so two Actions that each remove
  one of an entity's two memberships cannot both pass against the same
  cache snapshot — caches only advance once the Writer commits. The
  models the earlier Actions create are carried too, so a
  membership add in a later Action resolves the type the same request
  introduced.

  ## Last group member

  A group must keep at least one membership holding a non-empty
  permission list. Anything an `ebb/grant` create, write or delete would
  do to leave it with none is a structural rejection
  (`last_grant`), beside `last_membership` (#479). Permissions
  live only on `ebb/grant` rows and `GrantCache.get_permissions/3`
  treats an empty list as no membership, so a group with no capable
  row is unreachable through the API.

  The check mirrors `last_membership`: the affected groups' cached
  members, plus the request's writes, minus its deletes. A
  grant's group is immutable (a system component's key never moves), so a member never moves
  between groups: moving one is a delete plus a create. The delta is
  carried across the Actions of one request, so two Actions that each
  remove one of a group's two capable members cannot both pass against
  the same cache snapshot.

  ## Bootstrap existence

  Existence is read from the entity-model cache (`EntityScope.exists?/2`),
  which the Writer maintains for every committed row and retains for
  tombstones — so a deleted id still reads as existing and cannot be
  re-bootstrapped. The index only advances when the Writer commits, so a
  group created earlier in the same request still reads as new; that is
  acceptable because a request carries a single actor and that actor
  minted the group.
  """

  alias EbbServer.Storage.AuthorizationContext
  alias EbbServer.Storage.EntityScope
  alias EbbServer.Storage.GrantCache
  alias EbbServer.Storage.MembershipCache
  alias EbbServer.Storage.PermissionHelper
  alias EbbServer.Storage.RowMutations
  alias EbbServer.Storage.SystemComponent

  @typep validated_action :: %{
           id: String.t(),
           actor_id: String.t(),
           hlc: non_neg_integer(),
           updates: [map()]
         }

  @typep grant_row :: %{
           id: String.t(),
           group_id: String.t(),
           permissions: [String.t()]
         }

  @typep members_by_group :: %{String.t() => %{String.t() => [String.t()]}}

  @typep request_sim :: %{
           additions: %{String.t() => [String.t()]},
           removals: %{String.t() => [String.t()]},
           models: %{String.t() => String.t()},
           member_overlay: %{String.t() => grant_row() | nil},
           members_by_group: members_by_group(),
           membership_rows: %{{String.t(), String.t()} => String.t()},
           removed_membership_ids: MapSet.t(String.t())
         }

  @type rejection :: %{
          action: validated_action(),
          reason: String.t(),
          details: String.t() | nil
        }

  @spec authorize([validated_action()], String.t(), AuthorizationContext.t()) ::
          {accepted :: [validated_action()], rejected :: [rejection()]}
  def authorize(actions, actor_id, ctx),
    do: authorize(actions, actor_id, ctx, new_sim(), [], [])

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
      models: %{},
      member_overlay: %{},
      members_by_group: %{},
      membership_rows: %{},
      removed_membership_ids: MapSet.new()
    }

  defp authorize_action(action, actor_id, ctx, sim) do
    opts = ctx_to_opts(ctx)
    mutations = fold_action(action, opts, sim)
    intra = PermissionHelper.build_intra_action_context(mutations)
    exists? = fn entity_id -> EntityScope.exists?(entity_id, opts) end

    # A membership row's existence must not depend on the model index alone:
    # that index is repaired asynchronously and can lag the group cache, and
    # a lagging index would re-open the bootstrap exemption for a row that
    # already exists (#625).
    member_exists? = fn member_id ->
      exists?.(member_id) or
        GrantCache.get_grant(member_id, ctx.grants_by_id_table) != nil
    end

    authz = %{
      intra: intra,
      intra_opts: Keyword.put(opts, :intra_action, intra),
      bootstrap: PermissionHelper.bootstrap_group_permissions(mutations, actor_id, exists?),
      bootstrap_grant_ids:
        PermissionHelper.bootstrap_grant_row_ids(mutations, actor_id, member_exists?),
      created_ids: PermissionHelper.created_subject_ids(mutations, exists?),
      # An id the request already modeled keeps that model: a later Action may
      # only model ids the simulation does not know.
      created_models: Map.merge(PermissionHelper.created_models(mutations), sim.models),
      deleted_memberships: resolve_deleted_memberships(mutations, opts),
      # A user row's update is authorized against the components the wire
      # names, so the subject is read from the Updates, not the folded row.
      written_components: PermissionHelper.written_components(action.updates),
      mutations: mutations,
      opts: opts,
      ctx: ctx
    }

    with :ok <- check_all_mutations(mutations, actor_id, authz),
         {:ok, sim} <- check_membership_rows(authz, sim),
         {:ok, sim} <- check_last_membership(authz, sim),
         {:ok, sim} <- check_last_grant(authz, sim) do
      {:ok, %{sim | models: authz.created_models}}
    end
  end

  # The Action's Updates fold into one row mutation per subject, so every
  # Update of a row is authorized once, against the row's model and the row's
  # fields. The verb is the Action's own create, so no existence predicate is
  # needed; a delete resolves its committed model through the request's own
  # earlier creates as well as the caches.
  defp fold_action(action, opts, sim) do
    fold_opts =
      Keyword.put(opts, :model_resolver, fn entity_id ->
        committed_model(entity_id, opts) || Map.get(sim.models, entity_id)
      end)

    RowMutations.fold(action.updates, fold_opts)
  end

  defp check_all_mutations(mutations, actor_id, authz) do
    Enum.reduce_while(mutations, :ok, fn update, _acc ->
      case check_update(update, actor_id, authz) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  # Row identity is not a permission: the bootstrap exemption covers
  # *creating* a membership, never re-pointing an existing row, so this
  # check runs before the exemption (#623). An id's model is identity too: a
  # component's prefix is client input, so a relabel may not ride the
  # bootstrap either (#624).
  defp check_update(update, actor_id, authz) do
    with :ok <- check_update_row_identity(update, authz),
         :ok <- check_update_model_identity(update, authz) do
      authorize_or_exempt(update, actor_id, authz)
    end
  end

  defp authorize_or_exempt(update, actor_id, authz) do
    if PermissionHelper.bootstrap_update?(
         update,
         actor_id,
         authz.bootstrap,
         authz.created_ids,
         authz.bootstrap_grant_ids
       ) do
      :ok
    else
      authorize_update(update, actor_id, authz)
    end
  end

  defp authorize_update(%{kind: kind} = update, actor_id, authz) do
    case kind do
      :group -> authorize_group_update(update, actor_id, authz)
      :grant -> authorize_grant_update(update, actor_id, authz)
      :membership -> authorize_membership_update(update, actor_id, authz)
      # An edge is a component of its source, so the source's own membership
      # set is its group set: the user path with `ebb/link` as the subject.
      :link -> authorize_user_entity_update(update.model, update, actor_id, authz)
      nil -> authorize_user_entity_update(update.model, update, actor_id, authz)
    end
  end

  defp authorize_group_update(update, actor_id, authz) do
    check_group_permission(
      [update.subject_id],
      actor_id,
      SystemComponent.component(:group),
      permission_for(update),
      authz
    )
  end

  defp authorize_grant_update(update, actor_id, authz) do
    case existing_grant(update.subject_id, authz) do
      :new ->
        authorize_new_grant_update(update, actor_id, authz)

      :unresolved ->
        {:error, "not_authorized", "cannot resolve the group of this ebb/grant row"}

      {:existing, group_id} ->
        check_group_permission(
          [group_id],
          actor_id,
          SystemComponent.component(:grant),
          permission_for(update),
          authz
        )
    end
  end

  defp authorize_new_grant_update(update, actor_id, authz) do
    group_ids = EntityScope.fan_out_groups(update, authz.intra_opts)

    if group_ids == [] do
      {:error, "not_authorized", "cannot resolve the group for this ebb/grant row"}
    else
      check_group_permission(
        group_ids,
        actor_id,
        SystemComponent.component(:grant),
        permission_for(update),
        authz
      )
    end
  end

  # `:new` when nothing knows the id, `{:existing, group_id}` when the
  # by-id index can place the row. `:unresolved` is an id the existence
  # index still knows after the cache dropped it: a tombstone must not be
  # re-filed as a fresh row.
  defp existing_grant(member_id, authz) do
    case GrantCache.get_grant(member_id, authz.ctx.grants_by_id_table) do
      nil ->
        if EntityScope.exists?(member_id, authz.opts), do: :unresolved, else: :new

      row ->
        {:existing, row.group_id}
    end
  end

  # #264: an entity must never resolve to zero owning groups. The check
  # is a net delta per entity — its cached membership, plus the request's
  # `ebb/membership` writes, minus its deletes, with re-added groups cancelled.
  # `build_intra_action_context/1` keeps only writes because other callers
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

  # A removed group is only subtracted when no write in the request re-adds
  # it: membership is per row, and a write replaces the pair's removed row
  # rather than adding beside it (see `check_membership_rows/2`).
  defp resulting_groups(entity_id, additions, removals, opts) do
    cached = EntityScope.source_groups(entity_id, opts)
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

  # Permissions live only on `ebb/grant` rows and `get_permissions/3`
  # treats an empty list as no membership, so a group with no capable row
  # is unreachable through the API.
  defp check_last_grant(authz, sim) do
    sim =
      authz.mutations
      |> Enum.filter(&(&1.kind == :grant))
      |> Enum.reduce(sim, fn update, acc -> apply_grant(update, authz, acc) end)

    if Enum.any?(sim.members_by_group, fn {_group_id, members} -> not capable_group?(members) end) do
      {:error, "last_grant",
       "removing this membership would leave the group with no member that can administer it"}
    else
      {:ok, sim}
    end
  end

  defp apply_grant(%{deleted?: false} = update, authz, sim) do
    value = SystemComponent.value(update.data, :grant)
    existing = resolve_grant(update.subject_id, authz, sim)
    group_id = member_group_id(update, value, existing)

    if is_nil(group_id) do
      sim
    else
      row = %{
        id: update.subject_id,
        group_id: group_id,
        permissions: resulting_permissions(update, value, existing)
      }

      sim = add_grant(sim, row, authz)

      %{sim | member_overlay: Map.put(sim.member_overlay, row.id, row)}
    end
  end

  defp apply_grant(%{deleted?: true} = update, authz, sim) do
    case resolve_grant(update.subject_id, authz, sim) do
      nil ->
        sim

      row ->
        sim = remove_grant(sim, row.id, row.group_id, authz)
        %{sim | member_overlay: Map.put(sim.member_overlay, row.id, nil)}
    end
  end

  # The grant value is atomic, so it is the whole row: a write to an existing
  # row with no value falls back to the row it names.
  defp member_group_id(_update, %{} = value, _existing), do: Map.get(value, "group_id")

  defp member_group_id(%{created?: false}, nil, existing), do: existing && existing.group_id
  defp member_group_id(_update, nil, _existing), do: nil

  defp resulting_permissions(_update, %{} = value, _existing),
    do: List.wrap(Map.get(value, "permissions"))

  defp resulting_permissions(%{created?: false}, nil, existing),
    do: List.wrap(existing && existing.permissions)

  defp resulting_permissions(_update, nil, _existing), do: []

  defp resolve_grant(member_id, authz, sim) do
    case Map.fetch(sim.member_overlay, member_id) do
      {:ok, row} -> row
      :error -> cached_grant(member_id, authz)
    end
  end

  defp cached_grant(member_id, authz) do
    case GrantCache.get_grant(member_id, authz.ctx.grants_by_id_table) do
      nil ->
        nil

      row ->
        %{id: member_id, group_id: row.group_id, permissions: List.wrap(row.permissions)}
    end
  end

  defp remove_grant(sim, member_id, group_id, authz) do
    members = ensure_group(sim.members_by_group, group_id, authz)

    %{
      sim
      | members_by_group: Map.put(sim.members_by_group, group_id, Map.delete(members, member_id))
    }
  end

  defp add_grant(sim, row, authz) do
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
    |> GrantCache.grant_ids(authz.ctx.grants_by_group_table)
    |> Enum.reduce(%{}, fn member_id, acc ->
      case cached_grant(member_id, authz) do
        nil -> acc
        row -> Map.put(acc, member_id, row.permissions)
      end
    end)
  end

  defp capable_group?(members) do
    Enum.any?(members, fn {_member_id, permissions} -> permissions != [] end)
  end

  # Keyed by the membership row id, not the mutation id: two deletes for one
  # row in an Action are already one row mutation, and collapsing them would
  # authorize one against the other's entity and hide one removal from the
  # last-membership guard (#623).
  defp resolve_deleted_memberships(mutations, opts) do
    mutations
    |> Enum.filter(&(&1.kind == :membership and &1.deleted?))
    |> Map.new(fn mutation ->
      {mutation.subject_id, EntityScope.membership(mutation.subject_id, opts)}
    end)
  end

  # One row per `(entity, group)` (#623): a write may re-write the pair's live
  # row, never mint a second one, whatever permission the caller holds. A
  # duplicate row outlives an unshare — the owner deletes the row it can
  # resolve and the entity stays shared — so this is revocation
  # correctness, not tidiness.
  #
  # It runs after the permission checks, so a caller without write access
  # learns nothing about an entity's memberships from which check refused
  # them. Deletes are read before writes because the Action is one unit: a
  # delete plus a write of the same pair replaces the row, in either wire
  # order — the shape the refused `ebb/membership` write documents. Writes
  # and deletes are also read from the request, since the caches only advance
  # once the Writer commits.
  defp check_membership_rows(authz, sim) do
    removed =
      authz.deleted_memberships
      |> Map.keys()
      |> MapSet.new()
      |> MapSet.union(sim.removed_membership_ids)

    sim =
      authz.deleted_memberships
      |> Map.values()
      |> Enum.reject(&is_nil/1)
      |> Enum.reduce(%{sim | removed_membership_ids: removed}, fn {entity_id, group_id}, acc ->
        %{acc | membership_rows: Map.delete(acc.membership_rows, {entity_id, group_id})}
      end)

    authz.mutations
    |> Enum.filter(&(&1.kind == :membership and RowMutations.write?(&1)))
    |> Enum.reduce_while({:ok, sim}, fn update, {:ok, acc} ->
      case apply_membership_write(update, authz, acc) do
        {:ok, next} -> {:cont, {:ok, next}}
        refusal -> {:halt, refusal}
      end
    end)
  end

  defp apply_membership_write(update, authz, sim) do
    value = SystemComponent.value(update.data, :membership)
    entity_id = value && Map.get(value, "entity_id")
    group_id = value && Map.get(value, "group_id")
    row_id = update.subject_id

    cond do
      not (is_binary(entity_id) and is_binary(group_id)) ->
        {:ok, sim}

      Enum.any?(live_membership_row_ids(entity_id, group_id, authz, sim), &(&1 != row_id)) ->
        {:error, "not_authorized",
         "the entity is already filed in that group: delete its membership row instead of adding a second one"}

      true ->
        {:ok,
         %{sim | membership_rows: Map.put(sim.membership_rows, {entity_id, group_id}, row_id)}}
    end
  end

  # The row ids the request leaves live for one pair: the membership
  # index, minus rows the request deletes, plus the row an earlier write in
  # the request minted (the index cannot see it yet).
  defp live_membership_row_ids(entity_id, group_id, authz, sim) do
    cached =
      entity_id
      |> MembershipCache.membership_entries(Keyword.fetch!(authz.opts, :memberships))
      |> Enum.filter(&(&1.group_id == group_id))
      |> Enum.reject(&MapSet.member?(sim.removed_membership_ids, &1.id))
      |> Enum.map(& &1.id)

    pending = Map.get(sim.membership_rows, {entity_id, group_id})

    Enum.uniq(cached ++ List.wrap(pending))
  end

  # Adding an entity to a group is gated by the entity's own
  # `<model>.create` in the target group (#121 "Add Entity to Group"), not
  # by the entity's whole group set. The model is the committed
  # entity-model cache's when the entity already exists, otherwise a model
  # created by this Action or an earlier Action of the request; an
  # unresolvable model is a refusal (`ebb/membership.create` would let any
  # group member graft an entity whose model they may not create).
  #
  # That `create` is not the whole gate when the write grows the entity's
  # group set. Filing an entity the read model already places elsewhere
  # adds the target group to the set that authorizes updates and deletes,
  # so the target group's `create` alone would let an actor holding it
  # read, overwrite or delete an entity they cannot write — a known id is
  # not authority (#623). An entity new to the index, or a write that only
  # re-files the pair the entity already holds, is filed by authority that
  # already exists and keeps the target gate.
  #
  # Both checks are cache-only: the bootstrap's declared permissions
  # stand in only for the membership the same Action creates, and this
  # update is exempt only when the entity is created by that same Action
  # (#289).
  #
  # A membership write is authorized against the row's real identity — the
  # entity and the group it names — so re-filing a live row is never a way to
  # mint one for an arbitrary entity (#623). The pair is immutable
  # (a system component's key never moves); a write that names no entity is refused below.
  defp authorize_membership_update(%{deleted?: false} = update, actor_id, authz) do
    with {:ok, entity_id, group_id} <- membership_identity(update) do
      authorize_membership_write(entity_id, group_id, update.subject_id, actor_id, authz)
    end
  end

  # Removing membership is gated by the entity's `<model>.update` in any
  # group of its current set (union semantics), not by `ebb/membership.delete`
  # in the removed group — the delete names no component, so the row is
  # resolved from the membership index.
  defp authorize_membership_update(%{deleted?: true} = update, actor_id, authz) do
    case Map.get(authz.deleted_memberships, update.subject_id) do
      nil ->
        {:error, "not_authorized", "cannot resolve the entity for this membership"}

      {entity_id, _group_id} ->
        authorize_membership_delete(entity_id, actor_id, authz)
    end
  end

  # A list or map here would be stored verbatim by the mutation planner and
  # corrupt the membership indices; a membership names one entity and one
  # group.
  defp membership_identity(update) do
    entity_id = SystemComponent.path(update.data, :membership, "entity_id")
    group_id = SystemComponent.path(update.data, :membership, "group_id")

    if is_binary(entity_id) and entity_id != "" and is_binary(group_id) and group_id != "" do
      {:ok, entity_id, group_id}
    else
      {:error, "not_authorized", "an ebb/membership write needs a string entity_id and group_id"}
    end
  end

  defp authorize_membership_write(entity_id, group_id, row_id, actor_id, authz) do
    case entity_model(entity_id, authz) do
      nil ->
        {:error, "not_authorized",
         "cannot resolve the model of the entity being added to a group"}

      model ->
        with :ok <-
               check_group_permission(
                 [group_id],
                 actor_id,
                 model,
                 "create",
                 authz,
                 &cached_permissions/3
               ),
             :ok <- check_existing_ownership(entity_id, group_id, row_id, actor_id, model, authz) do
          check_not_ownerless(entity_id, authz)
        end
    end
  end

  # The source side of a share. Filing an entity the read model already
  # places in a group adds the target group to the set that authorizes
  # updates and deletes, so it needs `<type>.update` where the entity
  # lives — the target group's `create` alone would let an actor holding
  # it read, overwrite or delete an entity they cannot write (#623).
  #
  # Two shapes keep the target gate on its own:
  #
  #   - an entity the read model places in no group is new to it (created
  #     by this request, or never filed), and the same Action is the
  #     authority that files it. `check_not_ownerless/2` still refuses a
  #     committed entity that owns nothing;
  #   - a write that names the row the pair already has adds nothing to the
  #     entity's group set. That is the idempotent re-write a retried Action
  #     (#285) and a second device send, and refusing it would need update
  #     authority to repeat a no-op.
  #
  # Cache-only via `cached_permissions/3`: the Action's declared bootstrap
  # permissions may stand in for the membership it creates, never for
  # ownership of an entity that already exists (#289).
  defp check_existing_ownership(entity_id, group_id, row_id, actor_id, model, authz) do
    group_ids = EntityScope.source_groups(entity_id, authz.opts)

    cond do
      group_ids == [] ->
        :ok

      holds_membership_row?(entity_id, group_id, row_id, authz) ->
        :ok

      true ->
        check_group_permission(group_ids, actor_id, model, "update", authz, &cached_permissions/3)
    end
  end

  defp holds_membership_row?(entity_id, group_id, row_id, authz) do
    entity_id
    |> MembershipCache.membership_entries(Keyword.fetch!(authz.opts, :memberships))
    |> Enum.any?(fn entry ->
      entry.group_id == group_id and entry.id == row_id and
        not Map.has_key?(authz.deleted_memberships, row_id)
    end)
  end

  # A platform row's write carries both facts, so the identity check runs on
  # a create and on a write to an existing row alike: a key that disagrees
  # with the committed row is refused before any permission is consulted
  # (a system component's key never moves).
  defp check_update_row_identity(%{kind: :membership, deleted?: false} = update, authz) do
    value = SystemComponent.value(update.data, :membership)
    check_membership_row_identity(update.subject_id, value, authz)
  end

  defp check_update_row_identity(%{kind: :grant, deleted?: false} = update, authz) do
    check_grant_row_group(
      update.subject_id,
      SystemComponent.path(update.data, :grant, "group_id"),
      authz
    )
  end

  defp check_update_row_identity(_update, _authz), do: :ok

  # `ebb/grant`'s `group_id` is its identity (a system component's key never moves): moving a grant
  # between groups is a delete plus a create, so an existing row is authorized
  # only in the group it already belongs to (#625).
  defp check_grant_row_group(grant_id, group_id, authz) do
    case GrantCache.get_grant(grant_id, authz.ctx.grants_by_id_table) do
      nil ->
        :ok

      %{group_id: committed} ->
        if is_nil(group_id) or committed == group_id do
          :ok
        else
          {:error, "not_authorized", "an ebb/grant row cannot be re-pointed at another group"}
        end
    end
  end

  # The model an id was committed under is authoritative; a component's
  # prefix is client input. Every stage downstream — the permission lookup,
  # the materialized row's model, the entity-model cache — keys on the prefix,
  # so a mismatch lets a permission on one model in the group rewrite, delete
  # or relabel every other model's entities there (#624). Fail closed: the
  # prefix stands only for an id nothing has committed yet, and the committed
  # model is never echoed back.
  defp check_update_model_identity(update, authz) do
    if overlay_write?(update, authz) do
      :ok
    else
      check_committed_model(update, authz)
    end
  end

  defp check_committed_model(update, authz) do
    case committed_model(update.subject_id, authz.opts) do
      nil -> check_unresolved_model(update, authz)
      committed -> require_model(committed, update)
    end
  end

  # An `ebb/*` overlay names the platform's component, not the row's model:
  # it is added to a row it does not re-model and the committed model is left
  # alone (an overlay never supplies a model), so there is no model claim to
  # check. Every other write claims one, and the fold reports it as
  # `update.model`.
  defp overlay_write?(%{created?: false, deleted?: false} = update, authz) do
    case Map.get(authz.written_components, update.subject_id, []) do
      [] -> false
      components -> Enum.all?(components, &overlay_component?/1)
    end
  end

  defp overlay_write?(_update, _authz), do: false

  defp overlay_component?(component),
    do: SystemComponent.overlay?(SystemComponent.kind(component))

  # A committed id can reach here unmodeled: the entity-model cache is a
  # projection that an ablation (`--ablate component_entities` on the bench,
  # which reaches `opts[:ablate]`) or an unfinished rebuild can omit an entry
  # from. A membership row proves the id is not new and nothing models it, so
  # a component prefix cannot stand in for a committed model (#624). An id
  # nothing records is new, and the model the request gave it — an earlier
  # Action's create or this Action's own first write — is the only one there is.
  defp check_unresolved_model(update, authz) do
    if EntityScope.source_groups(update.subject_id, authz.opts) != [] do
      {:error, "not_authorized", "cannot resolve the model this entity was committed under"}
    else
      case Map.get(authz.created_models, update.subject_id) do
        nil -> :ok
        request_model -> require_model(request_model, update)
      end
    end
  end

  defp require_model(model, %{model: model}), do: :ok

  defp require_model(_committed, _update) do
    {:error, "not_authorized",
     "the component's model does not match the model this entity was committed under"}
  end

  defp committed_model(entity_id, opts), do: EntityScope.committed_model(entity_id, opts)

  # `ebb/membership`'s pair is immutable after create (a system component's key
  # never moves): the old owner would silently lose the membership without the
  # last-membership guard seeing it, and an orphaned entity could then be
  # claimed by anyone (#623).
  defp check_membership_row_identity(membership_id, value, authz) do
    case EntityScope.membership(membership_id, authz.opts) do
      nil ->
        :ok

      committed ->
        wire = {value && Map.get(value, "entity_id"), value && Map.get(value, "group_id")}
        check_membership_pair(committed, wire)
    end
  end

  defp check_membership_pair(_committed, {nil, _group_id}), do: :ok
  defp check_membership_pair(_committed, {_entity_id, nil}), do: :ok

  defp check_membership_pair(committed, wire) do
    if committed == wire do
      :ok
    else
      {:error, "not_authorized",
       "an ebb/membership row cannot be re-pointed at another entity or group"}
    end
  end

  # An entity the existence index does not know is new to the read model
  # (created by this request), and the target-group `create` is the whole
  # gate. An entity it knows but that resolves to no group is an orphan
  # or a tombstone: fail closed rather than letting the first caller claim
  # it. An owned entity stays the share/invite primitive (#623).
  defp check_not_ownerless(entity_id, authz) do
    if EntityScope.source_groups(entity_id, authz.opts) == [] and
         EntityScope.exists?(entity_id, authz.opts) do
      {:error, "not_authorized", "cannot file an entity that has no owning group"}
    else
      :ok
    end
  end

  defp authorize_membership_delete(entity_id, actor_id, authz) do
    case entity_model(entity_id, authz) do
      nil ->
        {:error, "not_authorized",
         "cannot resolve the model of the entity owning this membership"}

      model ->
        check_group_permission(
          EntityScope.source_groups(entity_id, authz.opts),
          actor_id,
          model,
          "update",
          authz,
          &cached_permissions/3
        )
    end
  end

  # The resolved model of an entity. A committed model wins: an id the
  # entity-model cache knows exists, so its recorded model is authoritative
  # and a re-write cannot spoof it. Models created earlier in the request
  # resolve only ids the index does not know yet.
  defp entity_model(entity_id, authz) do
    EntityScope.model(entity_id, authz.opts) || Map.get(authz.created_models, entity_id)
  end

  # The subject a user row's write names: its model for a create or a
  # delete, since neither names a component, and every component named on the
  # wire for an update (#803). A write that names no component at all falls
  # back to the model.
  defp authorize_user_entity_update(model, update, actor_id, authz) do
    case EntityScope.resolve_groups(model, update.subject_id, authz.intra_opts) do
      [] ->
        {:error, "missing_ownership",
         "entity has no group membership; every write must resolve at least one owning group"}

      group_ids ->
        check_write_subjects(group_ids, update, model, actor_id, authz)
    end
  end

  # An update must hold every permission the components it names require;
  # the first one the actor misses rejects the Action.
  defp check_write_subjects(group_ids, update, model, actor_id, authz) do
    permission = permission_for(update)

    update
    |> write_subjects(model, authz)
    |> Enum.reduce_while(:ok, fn subject, :ok ->
      case check_group_permission(group_ids, actor_id, subject, permission, authz) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp write_subjects(%{created?: false, deleted?: false} = update, model, authz) do
    case Map.get(authz.written_components, update.subject_id, []) do
      [] -> [model]
      components -> components
    end
  end

  # A create names the row's model, which covers every *user* component of the
  # row it creates — but not an `ebb/*` overlay, whose subject is its own
  # name. A delete names no component and detaches the row with its edges.
  defp write_subjects(%{created?: true} = update, model, authz) do
    [model | overlay_components(update, authz)]
  end

  defp write_subjects(_update, model, _authz), do: [model]

  defp overlay_components(update, authz) do
    authz.written_components
    |> Map.get(update.subject_id, [])
    |> Enum.filter(&overlay_component?/1)
  end

  # Union semantics: the actor may hold the permission in any group of
  # the entity's set; the write is indexed into every group separately.
  #
  # `subject` is the model a user row's create or delete names, the component
  # a user row's update names, or a platform component's own name
  # (`ebb/grant`); either way the grant string is `<subject>.<verb>` and a
  # grant covers a subject of its own or one descended from it.
  #
  # `permissions_fun` selects the source: the cache unioned with the
  # Action's declared bootstrap permissions by default, or the cache
  # alone for membership mutations of an existing entity.
  defp check_group_permission(
         group_ids,
         actor_id,
         subject,
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
            PermissionHelper.check_permission(permissions, subject, permission)
        end
      end)

    if has_permission do
      :ok
    else
      {:error, "not_authorized", "missing required permission"}
    end
  end

  # Membership mutations of an **existing** entity require a real
  # membership holding `<model>.create` / `<model>.update` in the target
  # group. The bootstrap's declared permissions stand in only for the
  # membership the same Action creates and cover only the entities that
  # bootstrap creates (`bootstrap_update?/4`), so they must not be
  # unioned here — unioning them would let an actor file an existing
  # entity into their new group and write to it under the self-grant
  # (#289). Cache-only and deliberately blind to `authz.bootstrap`.
  defp cached_permissions(actor_id, group_id, authz) do
    GrantCache.get_permissions(actor_id, group_id, authz.ctx.grants_table)
  end

  # The actor's declared bootstrap permissions are unioned with the
  # cache: the membership row is written after authorization, so during
  # the bootstrap Action the cache has nothing for the new group.
  defp permissions_for(actor_id, group_id, authz) do
    cached = GrantCache.get_permissions(actor_id, group_id, authz.ctx.grants_table)
    declared = Map.get(authz.bootstrap, group_id)

    if is_nil(cached) and is_nil(declared) do
      nil
    else
      Enum.uniq((cached || []) ++ (declared || []))
    end
  end

  defp permission_for(%{deleted?: true}), do: "delete"
  defp permission_for(%{created?: true}), do: "create"
  defp permission_for(_update), do: "update"

  defp ctx_to_opts(ctx) do
    AuthorizationContext.to_opts(ctx)
  end
end
