defmodule EbbServer.Storage.EntityIndex do
  @moduledoc """
  Single resolution surface for "which groups own this entity?".

  Every entity — user-defined rows, `Relationship` rows,
  `entityGroup` membership rows, `groupMember` rows — belongs to one
  or more Groups. Entity↔Group membership is a dedicated `entityGroup`
  system entity (`{entity_id, group_id}`); it is the only thing that
  moves a user entity between groups. The authorizer, the Writer's
  `cf_group_actions` index, the fan-out router, and the presence router
  all ask the same question through this module and expect the same
  answer.

  Resolution is dispatched by the row's `model`:

    - `"group"`        → the group is its own id
    - `"entityGroup"`  → the membership's `group_id`
    - `"groupMember"`  → the membership's `group_id`
    - `"relationship"` → the membership set of the edge's source
    - user models      → the source's membership set

  A relationship resolves through its **source**, never its own
  `target_id`: an app may hold a domain link to a `group` entity, and
  that link must not grant membership. Which source that is depends on
  the Update: the stored row's for a delete, the wire `source_id` for a
  put or patch. See `relationship_groups/4`.

  `source_groups/2` is the same resolution for a caller that already
  knows an entity id — for example a relationship being created in the
  current Action, which is not in the cache yet. Its group set is the
  cached membership unioned with membership carried by the Action
  (`:intra_action`).

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.

  Auxiliary lookups live here as well: `model/2` resolves an existing
  entity's committed model from the entity-type index (the authorizer uses
  it to gate membership mutations, #264, and every entity write, whose
  component prefix must match the committed model, #624),
  `committed_model/2` is the same answer widened with the by-id caches so a
  lagging index still models a system row, `exists?/2`
  exposes the same index as an existence signal (used by the authorizer to
  gate the bootstrap self-grant, #289), `membership/2` resolves an
  `entityGroup` row id to its `{entity_id, group_id}` (the delete wire
  form drops the entity reference), and `relationship_source/2` resolves
  a relationship row id to the source it is bound to (the authorizer's
  row-identity check, #624).
  """

  alias EbbServer.Storage.{
    EntityGroupCache,
    EntityTypeCache,
    Fields,
    GroupCache,
    RelationshipCache
  }

  alias EbbServer.Storage.CacheMutationPlanner.Overlay

  @typep model :: String.t()
  @typep subject_id :: String.t()

  @doc """
  Returns the group set an entity belongs to.

  Required options:

    - `:entity_groups`           — used for user-entity resolution
    - `:entity_groups_by_id`     — used for `"entityGroup"` resolution
    - `:relationships_by_id`     — used for `"relationship"` resolution
    - `:group_members_by_id`     — used for `"groupMember"` resolution
    - `:intra_action`            — optional membership from the
      current Action, keyed by entity id
    - `:intra_relationship_sources` — optional `relationship` row id →
      source entity id for a row put earlier in the same Action
    - `:overlay`                 — optional `CacheMutationPlanner.Overlay`
      of planned cache rows a predecessor batch has not applied yet

  Missing required options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_groups(model(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(model, subject_id, opts \\ [])

  def resolve_groups(model, subject_id, opts) do
    {groups, source_id} = resolve_groups_cached(model, subject_id, opts)
    apply_intra_action(groups, source_id, opts)
  end

  @doc """
  Cache-only resolution: `resolve_groups/3` without the Action's
  `:intra_action` membership.

  Returns the cached group set and the entity id whose intra-action
  membership still has to be unioned on top, or `nil` for a model that
  carries none (`"group"`, `"entityGroup"`, `"groupMember"`).

  The Writer builds every Action of a coalesced flush against one cache
  snapshot, so it memoizes this per resolution key and calls
  `apply_intra_action/3` once per Action. Keying the memo on the full
  `{model, subject_id}` keeps a `"relationship"` or `"entityGroup"`
  lookup from being answered by an unrelated entry with the same id.
  """
  @spec resolve_groups_cached(model(), subject_id(), keyword()) ::
          {[String.t()], subject_id() | nil}
  def resolve_groups_cached("group", group_id, _opts), do: {[group_id], nil}

  def resolve_groups_cached("entityGroup", membership_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups_by_id)

    case cached_row(opts, :entity_groups_by_id, membership_id, fn ->
           EntityGroupCache.get_entity_group(membership_id, table)
         end) do
      nil -> {[], nil}
      entry -> {List.wrap(entry_group_id(entry)), nil}
    end
  end

  def resolve_groups_cached("relationship", rel_id, opts) do
    table = Keyword.fetch!(opts, :relationships_by_id)

    case cached_row(opts, :relationships_by_id, rel_id, fn ->
           RelationshipCache.get_relationship(rel_id, table)
         end) do
      nil ->
        # A row put earlier in the same Action has no stored row yet; the put's
        # source is the only scope there is, and it is the one the put itself
        # was authorized and fanned out against.
        case Keyword.get(opts, :intra_relationship_sources, %{}) |> Map.get(rel_id) do
          nil -> {[], nil}
          source_id -> {source_groups_cached(source_id, opts), source_id}
        end

      entry ->
        source_id = entry_source_id(entry)
        {source_groups_cached(source_id, opts), source_id}
    end
  end

  def resolve_groups_cached("groupMember", gm_id, opts) do
    table = Keyword.fetch!(opts, :group_members_by_id)

    case cached_row(opts, :group_members_by_id, gm_id, fn ->
           GroupCache.get_group_member(gm_id, table)
         end) do
      nil -> {[], nil}
      entry -> {List.wrap(entry_group_id(entry)), nil}
    end
  end

  def resolve_groups_cached(_user_model, source_id, opts) do
    {source_groups_cached(source_id, opts), source_id}
  end

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
  Returns the group set for a known entity id: cached `entityGroup`
  targets unioned with the Action's membership rows.
  """
  @spec source_groups(subject_id(), keyword()) :: [String.t()]
  def source_groups(source_id, opts) do
    source_id
    |> source_groups_cached(opts)
    |> apply_intra_action(source_id, opts)
  end

  @doc """
  Cache-only `source_groups/2`: an entity's cached `entityGroup` targets
  without the Action's intra-action union.
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
  by-id cache row carries its system model by construction (a
  `groupMember`, `entityGroup` or `relationship` row is a row of that
  system model wherever else it is indexed). Both signals matter because
  the entity-type index is rebuilt asynchronously and can lag the caches: a
  caller that gates a write on this must not read a committed system row
  as new.

  Returns `nil` when nothing knows the id. For by-id caches the caller's
  options do not carry, the corresponding lookup is skipped; the authorizer
  and the Writer both pass all three.
  """
  @spec committed_model(subject_id(), keyword()) :: model() | nil
  def committed_model(entity_id, opts) do
    model(entity_id, opts) || system_model_by_id(entity_id, opts)
  end

  # A membership or edge row is its own model's row by construction; there is
  # no other model it could have been committed under.
  defp system_model_by_id(entity_id, opts) do
    cond do
      cached_by_id?(entity_id, opts, :group_members_by_id, &GroupCache.get_group_member/2) ->
        "groupMember"

      cached_by_id?(entity_id, opts, :entity_groups_by_id, &EntityGroupCache.get_entity_group/2) ->
        "entityGroup"

      cached_by_id?(entity_id, opts, :relationships_by_id, &RelationshipCache.get_relationship/2) ->
        "relationship"

      true ->
        nil
    end
  end

  # A cache the caller's options do not carry is no answer, not a negative
  # one: the authorizer and the Writer both pass all three.
  defp cached_by_id?(entity_id, opts, cache, fetch) do
    case Keyword.fetch(opts, cache) do
      {:ok, table} ->
        cached_row(opts, cache, entity_id, fn -> fetch.(entity_id, table) end) != nil

      :error ->
        false
    end
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
  Resolves an `entityGroup` membership row to its `{entity_id, group_id}`.

  The `entityGroup` delete wire form carries only the membership row id,
  so the authorizer needs the row's entity and group to resolve the model
  and current membership set. Returns `nil` when the row is not cached.
  """
  @spec membership(subject_id(), keyword()) :: {String.t(), String.t()} | nil
  def membership(membership_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups_by_id)

    case cached_row(opts, :entity_groups_by_id, membership_id, fn ->
           EntityGroupCache.get_entity_group(membership_id, table)
         end) do
      nil -> nil
      entry -> {entry_entity_id(entry), entry_group_id(entry)}
    end
  end

  @doc """
  Returns the source id a committed `relationship` row is bound to.

  A relationship row's source is its identity: the row fans out to the
  source's group set, so every scope decision follows the stored row
  rather than the wire `source_id` (#624). Returns `nil` when the by-id
  cache has no row — either a new edge or one the request itself deleted.
  """
  @spec relationship_source(subject_id(), keyword()) :: subject_id() | nil
  def relationship_source(rel_id, opts) do
    table = Keyword.fetch!(opts, :relationships_by_id)

    case cached_row(opts, :relationships_by_id, rel_id, fn ->
           RelationshipCache.get_relationship(rel_id, table)
         end) do
      nil -> nil
      entry -> entry_source_id(entry)
    end
  end

  @doc """
  Returns the group set for a `relationship` row mutation.

  The row is scoped through the source it is **bound** to, not the source
  the wire claims:

    - `:put` / `:patch` follow the wire `source_id` (the authorizer refuses
      a put or patch whose wire source differs from the stored row's, #624)
      and fall back to the stored row when the wire drops the source.
    - Every other method — notably `:delete` — follows the stored row's
      source, so a delete is scoped to the groups the row actually belongs
      to. The wire `source_id` is used only when no committed row exists: a
      row created earlier in the request, or one already tombstoned, has
      nothing left to re-point, and the wire source is the only scope there
      is (#624).

  A `nil` source resolves the by-id row directly, which is the same answer
  the fallbacks above produce.
  """
  @spec relationship_groups(atom() | String.t(), String.t() | nil, subject_id(), keyword()) :: [
          String.t()
        ]
  def relationship_groups(method, source_id, rel_id, opts) do
    case scope_source(method, source_id, rel_id, opts) do
      nil -> resolve_groups("relationship", rel_id, opts)
      source -> source_groups(source, opts)
    end
  end

  # A put or patch is already bound to its stored source by the authorizer's
  # row-identity check, so its wire source is the identity to resolve. Any
  # other method has no such check and must not be able to pick its scope.
  defp scope_source(method, wire_source, rel_id, opts) do
    stored = relationship_source(rel_id, opts)

    if put_or_patch?(method) do
      wire_source || stored
    else
      stored || wire_source
    end
  end

  defp put_or_patch?(method), do: method in [:put, :patch]

  @doc """
  Classifies how a folded row mutation's fan-out group set is resolved.

  The Writer's `cf_group_actions` index and `fan_out_groups/2` both
  consume this decision, so the "wire value wins for a not-yet-cached
  row" rule lives here once. The row is the unit: a system row's
  `group_id` or `source_id` may be carried by one component Update while
  its siblings carry none, so the folded row is what names the scope.

  Returns `{:wire, group_ids}` when the row carries the group on the
  wire, `{:source, entity_id}` when its scope follows a resolved
  relationship source, and `{:by_id, model}` when the subject has to be
  resolved from the caches. A relationship's source is resolved by
  method here — see `relationship_groups/4` — so fan-out cannot scope a
  delete more widely than its authorization did (#624).
  """
  @spec fan_out_preference(map(), keyword()) ::
          {:wire, [String.t()]} | {:source, subject_id()} | {:by_id, model()}
  def fan_out_preference(update, opts) do
    case update.model do
      "relationship" -> relationship_preference(update, opts)
      model when model in ["entityGroup", "groupMember"] -> group_preference(model, update, opts)
      model -> {:by_id, model}
    end
  end

  # The current Action's value wins: that is the value the authorizer bound
  # (#624). The flush row supplies what an earlier Action of the same commit
  # wrote, which the by-id caches cannot see yet (#813).
  defp scope_field(update, field, opts) do
    Fields.get(update.data, field) || flush_field(update.subject_id, field, opts)
  end

  defp relationship_preference(update, opts) do
    source_id = scope_field(update, "source_id", opts)

    case scope_source(update.method, source_id, update.subject_id, opts) do
      nil -> {:by_id, "relationship"}
      source -> {:source, source}
    end
  end

  defp group_preference(model, update, opts) do
    case scope_field(update, "group_id", opts) do
      nil -> {:by_id, model}
      group_id -> {:wire, [group_id]}
    end
  end

  @doc """
  Returns the group set a folded row fans out to, before the Writer commits.

  Resolves `fan_out_preference/2` against the caches unioned with the
  Action's `:intra_action` membership. The brand-new `entityGroup` and
  `groupMember` rows of the Action are not in the by-id caches yet, so
  those rows prefer the group on the wire.
  """
  @spec fan_out_groups(map(), keyword()) :: [String.t()]
  def fan_out_groups(update, opts) do
    case fan_out_preference(update, opts) do
      {:wire, group_ids} -> group_ids
      {:source, source_id} -> source_groups(source_id, opts)
      {:by_id, model} -> resolve_groups(model, update.subject_id, opts)
    end
  end

  # The row shape an earlier Action of the same flush left behind. The Writer
  # threads it through `:flush_rows`; a caller without it falls back to the
  # by-id caches exactly as before. A field the current Action carries still
  # wins, because that is the value the authorizer bound (#624).
  defp flush_field(subject_id, field, opts) do
    case Keyword.get(opts, :flush_rows) do
      %{} = rows -> Fields.get(Map.get(rows, subject_id), field)
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

  defp entry_source_id(entry), do: entry[:source_id] || entry["source_id"]
  defp entry_group_id(entry), do: entry[:group_id] || entry["group_id"]
  defp entry_entity_id(entry), do: entry[:entity_id] || entry["entity_id"]
end
