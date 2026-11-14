defmodule EbbServer.Storage.EntityIndex do
  @moduledoc """
  Single resolution surface for "which groups own this entity?".

  Every entity — user-defined rows and the platform's four component
  rows (`ebb/group`, `ebb/grant`, `ebb/membership`, `ebb/link`) — belongs
  to one or more Groups. Entity↔Group membership is a dedicated
  `ebb/membership` row (`{entity_id, group_id}`); it is the only thing
  that moves a user entity between groups. The authorizer, the Writer's
  `cf_group_actions` index, the fan-out router, and the presence router
  all ask the same question through this module and expect the same
  answer.

  ## Scope is declared, not dispatched

  Which owner a row's group set comes from is declared on the platform
  component (`EbbServer.Storage.SystemComponent`), and this module reads
  that declaration: one table read plus one recursion, so a fifth `ebb/*`
  component is one registration and no edit here. There are three shapes:

    - `:self` — the row's own id is its group set, as `ebb/group` is.
    - `{:field, name, :group}` — the value at `name` is a group id, and a
      group owns itself, so the scope is `[that id]` (`ebb/grant`,
      `ebb/membership`). This recurses to the `:self` case without reading
      the group's row: a group created in the same Action is not cached
      yet, and the group by-id table is optional for some callers.
    - `{:field, name, :entity}` — the value at `name` is an entity id, and
      the scope is that entity's membership set (`ebb/link`).

  A component with no declaration is a user component, whose scope is the
  entity's own membership set.

  A link resolves through its **source**, never its own `target_id`: an
  app may hold a domain link to a `group` entity, and that link must not
  grant membership. The source is read as an entity, never through
  `kind/2`, so an id that happens to collide with another kind's row
  cannot lend the edge a foreign scope. Which source a mutation is scoped
  by — the wire's or the stored row's — is `fan_out_preference/2`'s rule.

  `source_groups/2` is the same resolution for a caller that already
  knows an entity id — for example a relationship being created in the
  current Action, which is not in the cache yet. The read rule is stored
  state unioned with the current Action's own prefix: membership carried
  by the Action (`:intra_action`) and, for a row the Action itself wrote,
  the field value that write carried (`:intra_relationship_sources`).

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.

  Auxiliary lookups live here as well: `model/2` resolves an existing
  entity's committed model from the entity-type index (the authorizer uses
  it to gate membership mutations, #264, and every entity write, whose
  component prefix must match the committed model, #624),
  `committed_model/2` is the same answer widened with the by-id caches so a
  lagging index still models a platform row, `exists?/2`
  exposes the same index as an existence signal (used by the authorizer to
  gate the bootstrap self-grant, #289), `kind/2` answers which of the four
  platform components a stored id carries, `membership/2` resolves an
  `ebb/membership` row id to its `{entity_id, group_id}` (the delete wire
  form drops the entity reference), and `relationship_source/2` resolves
  an `ebb/link` row id to the source it is bound to (the authorizer's
  row-identity check, #624).
  """

  alias EbbServer.Storage.CacheMutationPlanner.Overlay
  alias EbbServer.Storage.EntityGroupCache
  alias EbbServer.Storage.EntityTypeCache
  alias EbbServer.Storage.SystemComponent

  @model SystemComponent.model()

  @typep model :: String.t()
  @typep scope_key :: SystemComponent.kind() | model()
  @typep subject_id :: String.t()

  @doc """
  Returns the group set an entity belongs to.

  The first argument is the row's platform component kind for a platform
  row, and its committed model for a user row — the model `ebb` is also
  accepted and resolved to the row's kind.

  Required options:

    - `:entity_groups`           — entity membership rows, for user models
      and for a link's source
    - `:entity_groups_by_id`     — the `ebb/membership` by-id cache
    - `:relationships_by_id`     — the `ebb/link` by-id cache
    - `:group_members_by_id`     — the `ebb/grant` by-id cache
    - `:group_apps`              — optional, the `ebb/group` by-id cache;
      only `kind/2` counts it
    - `:intra_action`            — optional membership from the
      current Action, keyed by entity id
    - `:intra_relationship_sources` — optional row id → source entity id
      for an `ebb/link` row the current Action wrote
    - `:flush_rows`              — optional row shapes an earlier Action
      of the same flush wrote
    - `:overlay`                 — optional `CacheMutationPlanner.Overlay`
      of planned cache rows a predecessor batch has not applied yet

  Missing required options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_groups(scope_key(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(key, subject_id, opts \\ [])

  def resolve_groups(key, subject_id, opts) do
    {groups, source_id} = resolve_groups_cached(key, subject_id, opts)
    apply_intra_action(groups, source_id, opts)
  end

  @doc """
  Cache-only resolution: `resolve_groups/3` without the Action's
  `:intra_action` membership.

  Returns the cached group set and the entity id whose intra-action
  membership still has to be unioned on top, or `nil` for a kind that
  carries none (a group, or a membership or grant naming one).

  The Writer builds every Action of a coalesced flush against one cache
  snapshot, so it memoizes this per resolution key and calls
  `apply_intra_action/3` once per Action. Keying the memo on the full
  `{kind, subject_id}` keeps one kind's lookup from being answered by an
  unrelated entry with the same id, and an atom kind never collides with a
  user model's name.
  """
  @spec resolve_groups_cached(scope_key(), subject_id(), keyword()) ::
          {[String.t()], subject_id() | nil}
  def resolve_groups_cached(:unknown, _subject_id, _opts), do: {[], nil}

  # A caller holding the committed model (`ebb`) rather than the kind still
  # resolves: the by-id caches name the kind.
  def resolve_groups_cached(model, subject_id, opts) when model == @model do
    resolve_groups_cached(kind(subject_id, opts) || :unknown, subject_id, opts)
  end

  # The scope owner `{:field, name, :entity}` recurses to here: an entity id
  # whose group set is its membership set.
  def resolve_groups_cached(:entity, source_id, opts),
    do: {source_groups_cached(source_id, opts), source_id}

  def resolve_groups_cached(key, subject_id, opts) when is_atom(key) do
    case SystemComponent.scope(key) do
      :self -> {[subject_id], nil}
      {:field, field, owner} -> resolve_owner(key, subject_id, field, owner, opts)
      nil -> {source_groups_cached(subject_id, opts), subject_id}
    end
  end

  def resolve_groups_cached(_user_model, source_id, opts),
    do: {source_groups_cached(source_id, opts), source_id}

  # The declaration names the field; the row supplies its value. The recursion
  # is the declaration's owner, so a group value lands on `:self` and an
  # entity value on its membership set.
  defp resolve_owner(kind, subject_id, field, owner, opts) do
    case by_id_row!(SystemComponent.by_id(kind), subject_id, opts) do
      nil -> resolve_uncached(subject_id, owner, opts)
      row -> resolve_owner_value(row_field(row, field), owner, opts)
    end
  end

  defp resolve_owner_value(nil, _owner, _opts), do: {[], nil}
  defp resolve_owner_value(value, owner, opts), do: resolve_groups_cached(owner, value, opts)

  # A row the Action itself wrote has no stored row yet. The value that write
  # carried is the scope it was authorized and fanned out against — the
  # Action's own prefix in the read rule. Only an entity-owned scope needs
  # it: a group value travels on the row's fan-out preference, and a resolve
  # without one has no earlier write of its own to read.
  defp resolve_uncached(subject_id, :entity, opts) do
    case Keyword.get(opts, :intra_relationship_sources, %{}) do
      %{} = sources -> resolve_owner_value(Map.get(sources, subject_id), :entity, opts)
      _ -> {[], nil}
    end
  end

  defp resolve_uncached(_subject_id, _owner, _opts), do: {[], nil}

  @doc """
  Unions a cached group set with the Action's intra-action membership for
  `source_id`.

  `EntityGroupCache.entity_groups/2` already dedupes, so the union is the
  only place a duplicate can appear. A `nil` source id means the subject
  type carries no intra-action membership and the set is returned as is.
  """
  @spec apply_intra_action([String.t()], subject_id() | nil, keyword()) :: [String.t()]
  def apply_intra_action(groups, nil, _opts), do: groups

  def apply_intra_action(groups, source_id, opts) do
    case Keyword.get(opts, :intra_action, %{}) |> Map.get(source_id, []) do
      [] -> groups
      intra_action -> Enum.uniq(groups ++ intra_action)
    end
  end

  @doc """
  Returns the group set for a known entity id: cached membership rows
  unioned with the Action's membership rows.
  """
  @spec source_groups(subject_id(), keyword()) :: [String.t()]
  def source_groups(source_id, opts) do
    source_id
    |> source_groups_cached(opts)
    |> apply_intra_action(source_id, opts)
  end

  @doc """
  Cache-only `source_groups/2`: an entity's cached membership rows without
  the Action's intra-action union.
  """
  @spec source_groups_cached(subject_id(), keyword()) :: [String.t()]
  def source_groups_cached(source_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups)
    entries = EntityGroupCache.entity_group_entries(source_id, table)

    with %Overlay{} = overlay <- Keyword.get(opts, :overlay),
         {:ok, groups} <- Overlay.entity_groups(overlay, source_id, entries) do
      groups
    else
      _ -> EntityGroupCache.entity_groups_from_entries(entries)
    end
  end

  @doc """
  Answers which platform component a stored row carries.

  A `delete` names no component, so this is how a caller learns a stored
  row's kind from its id: the by-id caches can answer because each is
  written by exactly one kind. Returns `nil` for a user row and for an id
  nothing knows.

  The scan follows `SystemComponent.kinds/0`'s declaration order, which is
  the by-id precedence: ids are not model-unique here, so a colliding id
  answers the same kind it always has. A cache the caller's options do not
  carry holds no row.
  """
  @spec kind(subject_id(), keyword()) :: SystemComponent.kind() | nil
  def kind(entity_id, opts) do
    Enum.find(SystemComponent.kinds(), fn kind ->
      by_id_present?(SystemComponent.by_id(kind), entity_id, opts)
    end)
  end

  @doc """
  The kind a folded row mutation carries.

  A value Update names its component, so the fold already knows the kind. A
  `delete` names only the row, so its kind comes from the by-id caches — and
  only when the row's committed model is the platform model: ids are not
  model-unique here, so an id another kind happens to use must not lend its
  kind to a user row. Returns `nil` for a delete nothing can place (an id
  created earlier in the same request).
  """
  @spec kind_of(map(), keyword()) :: SystemComponent.kind() | nil
  def kind_of(%{kind: kind}, _opts) when not is_nil(kind), do: kind

  def kind_of(%{model: model, subject_id: subject_id}, opts) when model == @model,
    do: kind(subject_id, opts)

  def kind_of(_mutation, _opts), do: nil

  @doc """
  Resolves the committed model of an existing entity id from the
  entity-type index.

  Returns `nil` when the index has no entry for the id. That is not proof
  of a new id: the index is rebuilt from the caches and can lag them, so a
  caller that gates a write on the resolved model must weigh its other
  existence signals before treating the id as new, and refuse when the id
  exists but nothing records its model.
  """
  @spec model(subject_id(), keyword()) :: model() | nil
  def model(entity_id, opts) do
    table = Keyword.fetch!(opts, :entity_types)

    cached_row(opts, :entity_types, entity_id, fn ->
      EntityTypeCache.get_type(entity_id, table)
    end)
  end

  @doc """
  Resolves the model an entity id was **committed** under.

  The entity-type index wins whenever it has an entry; failing that, a
  by-id cache row is a platform row by construction (`ebb`). Both signals
  matter because the entity-type index is rebuilt asynchronously and can
  lag the caches: a caller that gates a write on this must not read a
  committed platform row as new.

  Returns `nil` when nothing knows the id. For by-id caches the caller's
  options do not carry, the corresponding lookup is skipped; the authorizer
  and the Writer both pass all of them.
  """
  @spec committed_model(subject_id(), keyword()) :: model() | nil
  def committed_model(entity_id, opts) do
    model(entity_id, opts) || system_model_by_id(entity_id, opts)
  end

  # Only the shared model is named here; the kind distinguishes the four.
  defp system_model_by_id(entity_id, opts) do
    if kind(entity_id, opts), do: @model, else: nil
  end

  @doc """
  Returns true when the entity-type index knows `entity_id`.

  Existence only: the recorded model may be stale — a tombstoned entity
  keeps its entry — so callers treat this as a fail-closed existence
  signal, never as a current-model assertion.
  """
  @spec exists?(subject_id(), keyword()) :: boolean()
  def exists?(entity_id, opts), do: model(entity_id, opts) != nil

  @doc """
  Resolves an `ebb/membership` row to its `{entity_id, group_id}`.

  The membership delete wire form carries only the row id, so the
  authorizer needs the row's entity and group to resolve the model and
  current membership set. Returns `nil` when the row is not cached.
  """
  @spec membership(subject_id(), keyword()) :: {String.t(), String.t()} | nil
  def membership(membership_id, opts) do
    case by_id_row!(:entity_groups_by_id, membership_id, opts) do
      nil -> nil
      row -> {row_field(row, "entity_id"), row_field(row, "group_id")}
    end
  end

  @doc """
  Returns the source id a committed `ebb/link` row is bound to.

  A link row's source is its identity: the row fans out to the
  source's group set, so every scope decision follows the stored row
  rather than the wire `source_id` (#624). Returns `nil` when the by-id
  cache has no row — either a new edge or one the request itself deleted.
  """
  @spec relationship_source(subject_id(), keyword()) :: subject_id() | nil
  def relationship_source(rel_id, opts) do
    case by_id_row!(:relationships_by_id, rel_id, opts) do
      nil -> nil
      row -> row_field(row, "source_id")
    end
  end

  @doc """
  Classifies how a folded row mutation's fan-out group set is resolved.

  The Writer's `cf_group_actions` index and `fan_out_groups/2` both
  consume this decision, so the "wire value wins for a not-yet-cached
  row" rule lives here once. The row is the unit: a platform row's
  `group_id` or `source_id` lives in its one atomic component value, so
  the folded row is what names the scope.

  Returns `{:wire, group_ids}` when the row carries the group on the
  wire, `{:source, entity_id}` when its scope follows a resolved link
  source, and `{:by_id, kind | model}` when the subject has to be
  resolved from the caches. A link's source is resolved by method — the
  stored row for a delete and the wire for a put or patch, #624 — so
  fan-out cannot scope a delete more widely than its authorization did.
  """
  @spec fan_out_preference(map(), keyword()) ::
          {:wire, [String.t()]} | {:source, subject_id()} | {:by_id, scope_key()}
  def fan_out_preference(%{kind: kind} = update, opts) when not is_nil(kind) do
    case SystemComponent.scope(kind) do
      :self ->
        {:by_id, kind}

      {:field, field, :group} ->
        case scope_field(update, kind, field, opts) do
          nil -> {:by_id, kind}
          group_id -> {:wire, [group_id]}
        end

      {:field, field, :entity} ->
        case scope_owner(update, kind, field, opts) do
          nil -> {:by_id, kind}
          source_id -> {:source, source_id}
        end
    end
  end

  def fan_out_preference(update, _opts), do: {:by_id, update.model}

  # A put or patch is already bound to its stored source by the authorizer's
  # row-identity check, so its wire source is the identity to resolve. Any
  # other method has no such check and must not be able to pick its scope.
  defp scope_owner(update, kind, field, opts) do
    wire = scope_field(update, kind, field, opts)
    stored = stored_field(update.subject_id, kind, field, opts)

    if put_or_patch?(update.method) do
      wire || stored
    else
      stored || wire
    end
  end

  defp put_or_patch?(method), do: method in [:put, :patch]

  # The current Action's value wins: that is the value the authorizer bound
  # (#624). The flush row supplies what an earlier Action of the same commit
  # wrote, which the by-id caches cannot see yet (#813).
  defp scope_field(update, kind, field, opts) do
    SystemComponent.path(update.data, kind, field) ||
      flush_field(update.subject_id, kind, field, opts)
  end

  defp stored_field(subject_id, kind, field, opts) do
    case by_id_row!(SystemComponent.by_id(kind), subject_id, opts) do
      nil -> nil
      row -> row_field(row, field)
    end
  end

  @doc """
  Returns the group set a folded row fans out to, before the Writer commits.

  Resolves `fan_out_preference/2` against the caches unioned with the
  Action's `:intra_action` membership. The brand-new membership and grant
  rows of the Action are not in the by-id caches yet, so those rows prefer
  the group on the wire.
  """
  @spec fan_out_groups(map(), keyword()) :: [String.t()]
  def fan_out_groups(update, opts) do
    case fan_out_preference(update, opts) do
      {:wire, group_ids} -> group_ids
      {:source, source_id} -> source_groups(source_id, opts)
      {:by_id, key} -> resolve_groups(key, update.subject_id, opts)
    end
  end

  # The row shape an earlier Action of the same flush left behind. The Writer
  # threads it through `:flush_rows`; a caller without it falls back to the
  # by-id caches exactly as before. A field the current Action carries still
  # wins, because that is the value the authorizer bound (#624).
  defp flush_field(subject_id, kind, field, opts) do
    case Keyword.get(opts, :flush_rows) do
      %{} = rows -> SystemComponent.path(Map.get(rows, subject_id), kind, field)
      _ -> nil
    end
  end

  # A planned row shadows the cache for its id; a tombstone means the
  # successor batch must resolve as if the predecessor had already applied.
  defp cached_row(opts, cache, id, fetch) do
    case Keyword.get(opts, :overlay) do
      %Overlay{} = overlay ->
        case Overlay.fetch(overlay, cache, id) do
          {:ok, :deleted} -> nil
          {:ok, row} -> row
          :error -> fetch.()
        end

      _ ->
        fetch.()
    end
  end

  # Presence, not a row. A group's planned `apps` value may be `nil` while the
  # row still exists, so a planned entry answers present unless it is a
  # tombstone.
  defp by_id_present?(cache, id, opts) do
    case Keyword.fetch(opts, cache) do
      {:ok, table} -> planned_or_cached?(table, cache, id, opts)
      :error -> false
    end
  end

  defp planned_or_cached?(table, cache, id, opts) do
    case Keyword.get(opts, :overlay) do
      %Overlay{} = overlay -> planned_present?(overlay, cache, id, table)
      _ -> ets_row(table, id) != nil
    end
  end

  defp planned_present?(overlay, cache, id, table) do
    case Overlay.fetch(overlay, cache, id) do
      {:ok, :deleted} -> false
      {:ok, _row} -> true
      :error -> ets_row(table, id) != nil
    end
  end

  # The strict read: resolution says a missing cache is a caller error.
  defp by_id_row!(cache, id, opts) do
    table = Keyword.fetch!(opts, cache)
    cached_row(opts, cache, id, fn -> ets_row(table, id) end)
  end

  defp ets_row(table, id) do
    case :ets.info(table, :name) do
      :undefined ->
        nil

      _ ->
        case :ets.lookup(table, id) do
          [{_, row}] -> row
          [] -> nil
        end
    end
  end

  defp row_field(row, name) do
    case existing_atom(name) do
      nil -> Map.get(row, name)
      key -> Map.get(row, key) || Map.get(row, name)
    end
  end

  defp existing_atom(name) do
    String.to_existing_atom(name)
  rescue
    ArgumentError -> nil
  end
end
