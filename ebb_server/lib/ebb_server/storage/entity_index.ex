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

  Resolution is dispatched by `subject_type`:

    - `"group"`        → the group is its own id
    - `"entityGroup"`  → the membership's `group_id`
    - `"groupMember"`  → the membership's `group_id`
    - `"relationship"` → the membership set of the edge's source
    - user types       → the source's membership set

  A relationship resolves through its **source**, never its own
  `target_id`: an app may hold a domain link to a `group` entity, and
  that link must not grant membership.

  `source_groups/2` is the same resolution for a caller that already
  knows an entity id — for example a relationship being created in the
  current Action, which is not in the cache yet. Its group set is the
  cached membership unioned with membership carried by the Action
  (`:intra_action`).

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.

  Two auxiliary lookups live here as well: `subject_type/2` resolves an
  existing entity's type from the entity-type index (used by the
  authorizer to gate membership mutations, #264), `exists?/2` exposes
  the same index as an existence signal (used by the authorizer to gate
  the bootstrap self-grant, #289), and `membership/2` resolves an
  `entityGroup` row id to its `{entity_id, group_id}` (the delete wire
  form drops the entity reference).
  """

  alias EbbServer.Storage.{
    EntityGroupCache,
    EntityTypeCache,
    Fields,
    GroupCache,
    RelationshipCache
  }

  alias EbbServer.Storage.CacheMutationPlanner.Overlay

  @typep subject_type :: String.t()
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
    - `:overlay`                 — optional `CacheMutationPlanner.Overlay`
      of planned cache rows a predecessor batch has not applied yet

  Missing required options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_groups(subject_type(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(subject_type, subject_id, opts \\ [])

  def resolve_groups(subject_type, subject_id, opts) do
    {groups, source_id} = resolve_groups_cached(subject_type, subject_id, opts)
    apply_intra_action(groups, source_id, opts)
  end

  @doc """
  Cache-only resolution: `resolve_groups/3` without the Action's
  `:intra_action` membership.

  Returns the cached group set and the entity id whose intra-action
  membership still has to be unioned on top, or `nil` for a subject type
  that carries none (`"group"`, `"entityGroup"`, `"groupMember"`).

  The Writer builds every Action of a coalesced flush against one cache
  snapshot, so it memoizes this per resolution key and calls
  `apply_intra_action/3` once per Action. Keying the memo on the full
  `{subject_type, subject_id}` keeps a `"relationship"` or
  `"entityGroup"` lookup from being answered by an unrelated entry with
  the same id.
  """
  @spec resolve_groups_cached(subject_type(), subject_id(), keyword()) ::
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
        {[], nil}

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

  def resolve_groups_cached(_user_type, source_id, opts) do
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
  Resolves the type of an existing entity id from the entity-type index.

  Returns `nil` when the id is unknown. Callers that gate a write on the
  resolved type must treat `nil` as a refusal rather than a fallback.
  """
  @spec subject_type(subject_id(), keyword()) :: subject_type() | nil
  def subject_type(entity_id, opts) do
    table = Keyword.fetch!(opts, :entity_types)

    cached_row(opts, :entity_types, entity_id, fn ->
      EntityTypeCache.get_type(entity_id, table)
    end)
  end

  @doc """
  Returns true when the entity-type index knows `entity_id`.

  Existence only: the recorded type may be stale — a tombstoned entity
  keeps its entry — so callers treat this as a fail-closed existence
  signal, never as a current-type assertion.
  """
  @spec exists?(subject_id(), keyword()) :: boolean()
  def exists?(entity_id, opts), do: subject_type(entity_id, opts) != nil

  @doc """
  Resolves an `entityGroup` membership row to its `{entity_id, group_id}`.

  The `entityGroup` delete wire form carries only the membership row id,
  so the authorizer needs the row's entity and group to resolve the type
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
  Returns the group set for a `relationship` update: the wire
  `source_id`'s membership set when the Update carries it, otherwise
  the by-id edge's source (the delete wire form drops the data
  envelope).
  """
  @spec relationship_groups(String.t() | nil, subject_id(), keyword()) :: [String.t()]
  def relationship_groups(nil, rel_id, opts), do: resolve_groups("relationship", rel_id, opts)
  def relationship_groups(source_id, _rel_id, opts), do: source_groups(source_id, opts)

  @doc """
  Classifies how an Update's fan-out group set is resolved.

  The Writer's `cf_group_actions` index and the `PermissionChecker`
  group-scope check both consume this decision, so the "wire value wins
  for a not-yet-cached row" rule lives here once.

  Returns `{:wire, group_ids}` when the Update carries the group on the
  wire, `{:source, entity_id}` when its scope follows a relationship
  source, and `{:by_id, subject_type}` when the subject has to be
  resolved from the caches.
  """
  @spec fan_out_preference(map()) ::
          {:wire, [String.t()]} | {:source, subject_id()} | {:by_id, subject_type()}
  def fan_out_preference(update) do
    case update.subject_type do
      "relationship" ->
        case Fields.get(update.data, "source_id") do
          nil -> {:by_id, "relationship"}
          source_id -> {:source, source_id}
        end

      type when type in ["entityGroup", "groupMember"] ->
        case Fields.get(update.data, "group_id") do
          nil -> {:by_id, type}
          group_id -> {:wire, [group_id]}
        end

      type ->
        {:by_id, type}
    end
  end

  @doc """
  Returns the group set an Update fans out to, before the Writer commits.

  Resolves `fan_out_preference/1` against the caches unioned with the
  Action's `:intra_action` membership. The brand-new `entityGroup` and
  `groupMember` rows of the Action are not in the by-id caches yet, so
  those Updates prefer the group on the wire.
  """
  @spec fan_out_groups(map(), keyword()) :: [String.t()]
  def fan_out_groups(update, opts) do
    case fan_out_preference(update) do
      {:wire, group_ids} -> group_ids
      {:source, source_id} -> source_groups(source_id, opts)
      {:by_id, subject_type} -> resolve_groups(subject_type, update.subject_id, opts)
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
