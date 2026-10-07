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
  authorizer to gate membership mutations, #264), and `membership/2`
  resolves an `entityGroup` row id to its `{entity_id, group_id}` (the
  delete wire form drops the entity reference).
  """

  alias EbbServer.Storage.{EntityGroupCache, EntityTypeCache, GroupCache, RelationshipCache}

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

  Missing required options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_groups(subject_type(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(subject_type, subject_id, opts \\ [])

  def resolve_groups("group", group_id, _opts), do: [group_id]

  def resolve_groups("entityGroup", membership_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups_by_id)

    case EntityGroupCache.get_entity_group(membership_id, table) do
      nil -> []
      entry -> List.wrap(entry_group_id(entry))
    end
  end

  def resolve_groups("relationship", rel_id, opts) do
    table = Keyword.fetch!(opts, :relationships_by_id)

    case RelationshipCache.get_relationship(rel_id, table) do
      nil -> []
      entry -> source_groups(entry_source_id(entry), opts)
    end
  end

  def resolve_groups("groupMember", gm_id, opts) do
    table = Keyword.fetch!(opts, :group_members_by_id)

    case GroupCache.get_group_member(gm_id, table) do
      nil -> []
      entry -> List.wrap(entry_group_id(entry))
    end
  end

  def resolve_groups(_user_type, source_id, opts) do
    source_groups(source_id, opts)
  end

  @doc """
  Returns the group set for a known entity id: cached `entityGroup`
  targets unioned with the Action's membership rows.
  """
  @spec source_groups(subject_id(), keyword()) :: [String.t()]
  def source_groups(source_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups)
    intra_action = Keyword.get(opts, :intra_action, %{})

    (EntityGroupCache.entity_groups(source_id, table) ++ Map.get(intra_action, source_id, []))
    |> Enum.uniq()
  end

  @doc """
  Resolves the type of an existing entity id from the entity-type index.

  Returns `nil` when the id is unknown. Callers that gate a write on the
  resolved type must treat `nil` as a refusal rather than a fallback.
  """
  @spec subject_type(subject_id(), keyword()) :: subject_type() | nil
  def subject_type(entity_id, opts) do
    table = Keyword.fetch!(opts, :entity_types)
    EntityTypeCache.get_type(entity_id, table)
  end

  @doc """
  Resolves an `entityGroup` membership row to its `{entity_id, group_id}`.

  The `entityGroup` delete wire form carries only the membership row id,
  so the authorizer needs the row's entity and group to resolve the type
  and current membership set. Returns `nil` when the row is not cached.
  """
  @spec membership(subject_id(), keyword()) :: {String.t(), String.t()} | nil
  def membership(membership_id, opts) do
    table = Keyword.fetch!(opts, :entity_groups_by_id)

    case EntityGroupCache.get_entity_group(membership_id, table) do
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

  defp entry_source_id(entry), do: entry[:source_id] || entry["source_id"]
  defp entry_group_id(entry), do: entry[:group_id] || entry["group_id"]
  defp entry_entity_id(entry), do: entry[:entity_id] || entry["entity_id"]
end
