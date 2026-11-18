defmodule EbbServer.Storage.EntityScope do
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

  Which owner a row's group set comes from is declared on the platform
  component (`EbbServer.Storage.SystemComponent`), and this module reads
  that declaration: one table read plus one recursion, so a fifth `ebb/*`
  component is one registration and no edit here.

  An edge is not a row: `ebb/link` is a keyed component of its source, so
  a link write's subject *is* the source and the default path — the
  subject's own membership set — is the scope decision. An edge may point
  at a `group` entity, and that target never lends the write a foreign
  scope because nothing reads it here.

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.
  """

  alias EbbServer.Storage.CacheMutationPlanner.Overlay
  alias EbbServer.Storage.EntityModelCache
  alias EbbServer.Storage.MembershipCache
  alias EbbServer.Storage.SystemComponent

  @model SystemComponent.model()

  @typep model :: String.t()
  @typep scope_key :: SystemComponent.kind() | model()
  @typep subject_id :: String.t()

  @doc """
  A missing required option raises `KeyError` rather than falling back to a
  global default.
  """
  @spec resolve_groups(scope_key(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(key, subject_id, opts \\ [])

  def resolve_groups(key, subject_id, opts) do
    {groups, source_id} = resolve_groups_cached(key, subject_id, opts)
    apply_intra_action(groups, source_id, opts)
  end

  @doc """
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

  def resolve_groups_cached(model, subject_id, opts) when model == @model do
    resolve_groups_cached(kind(subject_id, opts) || :unknown, subject_id, opts)
  end

  def resolve_groups_cached(key, subject_id, opts) when is_atom(key) do
    case SystemComponent.scope(key) do
      :self -> {[subject_id], nil}
      {:field, field, owner} -> resolve_owner(key, subject_id, field, owner, opts)
      nil -> {source_groups_cached(subject_id, opts), subject_id}
    end
  end

  def resolve_groups_cached(_user_model, source_id, opts),
    do: {source_groups_cached(source_id, opts), source_id}

  # A row the Action itself wrote has no stored row yet, and its `group_id`
  # travels on the mutation's fan-out preference, so a resolution with no
  # stored row has nothing to read.
  defp resolve_owner(kind, subject_id, field, owner, opts) do
    case by_id_row!(SystemComponent.by_id(kind), subject_id, opts) do
      nil -> {[], nil}
      row -> resolve_owner_value(Map.get(row, field), owner, opts)
    end
  end

  defp resolve_owner_value(nil, _owner, _opts), do: {[], nil}

  defp resolve_owner_value(value, :group, opts), do: resolve_groups_cached(:group, value, opts)

  @spec apply_intra_action([String.t()], subject_id() | nil, keyword()) :: [String.t()]
  def apply_intra_action(groups, nil, _opts), do: groups

  def apply_intra_action(groups, source_id, opts) do
    case Keyword.get(opts, :intra_action, %{}) |> Map.get(source_id, []) do
      [] -> groups
      intra_action -> Enum.uniq(groups ++ intra_action)
    end
  end

  @spec source_groups(subject_id(), keyword()) :: [String.t()]
  def source_groups(source_id, opts) do
    source_id
    |> source_groups_cached(opts)
    |> apply_intra_action(source_id, opts)
  end

  @spec source_groups_cached(subject_id(), keyword()) :: [String.t()]
  def source_groups_cached(source_id, opts) do
    table = Keyword.fetch!(opts, :memberships)
    entries = MembershipCache.membership_entries(source_id, table)

    with %Overlay{} = overlay <- Keyword.get(opts, :overlay),
         {:ok, groups} <- Overlay.memberships(overlay, source_id, entries) do
      groups
    else
      _ -> MembershipCache.memberships_from_entries(entries)
    end
  end

  @doc """
  The scan follows `SystemComponent.kinds/0`'s declaration order, which is
  the by-id precedence: ids are not model-unique here, so a colliding id
  resolves to the first kind whose cache holds it. A cache the caller's
  options do not carry holds no row.
  """
  @spec kind(subject_id(), keyword()) :: SystemComponent.kind() | nil
  def kind(entity_id, opts) do
    Enum.find(SystemComponent.kinds(), fn kind ->
      case SystemComponent.by_id(kind) do
        nil -> false
        cache -> by_id_carries?(cache, entity_id, opts)
      end
    end)
  end

  @doc """
  A `delete` names only the row, so its kind comes from the by-id caches — and
  only when the row's committed model is the platform model: ids are not
  model-unique here, so an id another kind happens to use must not lend its
  kind to a user row.
  """
  @spec kind_of(map(), keyword()) :: SystemComponent.kind() | nil
  def kind_of(%{kind: kind}, _opts) when not is_nil(kind), do: kind

  def kind_of(%{model: model, subject_id: subject_id}, opts) when model == @model,
    do: kind(subject_id, opts)

  def kind_of(_mutation, _opts), do: nil

  @doc """
  Returns `nil` when the index has no entry for the id. That is not proof
  of a new id: the index is rebuilt from the caches and can lag them, so a
  caller that gates a write on the resolved model must weigh its other
  existence signals before treating the id as new, and refuse when the id
  exists but nothing records its model.
  """
  @spec model(subject_id(), keyword()) :: model() | nil
  def model(entity_id, opts) do
    table = Keyword.fetch!(opts, :entity_models)

    cached_row(opts, :entity_models, entity_id, fn ->
      EntityModelCache.get_model(entity_id, table)
    end)
  end

  @doc """
  The entity-model cache wins whenever it has an entry; failing that, a
  by-id cache row is a platform row by construction (`ebb`). Both signals
  matter because the entity-model cache is rebuilt asynchronously and can
  lag the caches: a caller that gates a write on this must not read a
  committed platform row as new.
  """
  @spec committed_model(subject_id(), keyword()) :: model() | nil
  def committed_model(entity_id, opts) do
    model(entity_id, opts) || system_model_by_id(entity_id, opts)
  end

  defp system_model_by_id(entity_id, opts) do
    if kind(entity_id, opts), do: @model, else: nil
  end

  @doc """
  Existence only: the recorded model may be stale — a tombstoned entity
  keeps its entry — so callers treat this as a fail-closed existence
  signal, never as a current-model assertion.
  """
  @spec exists?(subject_id(), keyword()) :: boolean()
  def exists?(entity_id, opts), do: model(entity_id, opts) != nil

  @spec membership(subject_id(), keyword()) :: {String.t(), String.t()} | nil
  def membership(membership_id, opts) do
    case by_id_row!(:memberships_by_id, membership_id, opts) do
      nil -> nil
      row -> {Map.get(row, :entity_id), Map.get(row, :group_id)}
    end
  end

  @doc """
  The Writer's `cf_group_actions` index and `fan_out_groups/2` both
  consume this decision, so the "wire value wins for a not-yet-cached
  row" rule lives here once. The row is the unit: a platform row's
  `group_id` lives in its one atomic component value, so the folded row is
  what names the scope.

  Returns `{:wire, group_ids}` when the row carries the group on the wire,
  `{:by_id, kind | model}` when the subject's scope has to be resolved from
  the caches, and `{:source, entity_id}` when the row's scope *is* its own
  membership set — a component that declares no scope owner borrows the
  subject's, which is `ebb/link`: an edge is scoped by the row it leaves.
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

      nil ->
        {:source, update.subject_id}
    end
  end

  def fan_out_preference(update, _opts), do: {:by_id, update.model}

  # The current Action's value wins: that is the value the authorizer bound
  # (#624). The flush row supplies what an earlier Action of the same commit
  # wrote, which the by-id caches cannot see yet (#813).
  defp scope_field(update, kind, field, opts) do
    SystemComponent.path(update.data, kind, Atom.to_string(field)) ||
      flush_field(update.subject_id, kind, field, opts)
  end

  @doc """
  The brand-new membership and grant rows of the Action are not in the
  by-id caches yet, so those rows prefer the group on the wire.
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
      %{} = rows -> SystemComponent.path(Map.get(rows, subject_id), kind, Atom.to_string(field))
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
  defp by_id_carries?(cache, id, opts) do
    case {Keyword.fetch(opts, cache), Keyword.get(opts, :overlay)} do
      {{:ok, table}, %Overlay{} = overlay} -> planned_carries?(overlay, table, cache, id)
      {{:ok, table}, _} -> ets_row(table, id) != nil
      {:error, _} -> false
    end
  end

  defp planned_carries?(overlay, table, cache, id) do
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
end
