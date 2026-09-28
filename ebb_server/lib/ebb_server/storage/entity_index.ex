defmodule EbbServer.Storage.EntityIndex do
  @moduledoc """
  Single resolution surface for "which group owns this entity?".

  Every entity in the system — user-defined entities, `Relationship`
  rows, `groupMember` rows — belongs to a group. The authorizer,
  fan-out router, and presence router all ask the same question
  with a `(subject_type, subject_id)` pair and expect the same kind
  of answer.

  This module hides the per-type table layout from callers. Each
  entity type knows which physical index holds its group
  relationship; callers know only that they get back a `group_id`
  or `nil`.

  Resolution is dispatched by `subject_type`:

    - `"group"`        → the group IS its own id
    - `"relationship"` → `:ebb_relationships_by_id` (relationship id)
    - `"groupMember"`  → `:ebb_group_members_by_id` (member id)
    - user types       → `:ebb_relationships` (source_id key)

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.
  """

  alias EbbServer.Storage.{GroupCache, RelationshipCache}

  @typep subject_type :: String.t()
  @typep subject_id :: String.t()

  @doc """
  Returns the group an entity belongs to, or `nil` when no
  resolved group exists.

  Required options:

    - `:relationships`           — used for user-entity resolution
    - `:relationships_by_id`     — used for `"relationship"` resolution
    - `:group_members_by_id`     — used for `"groupMember"` resolution

  Missing options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_group(subject_type(), subject_id(), keyword()) :: String.t() | nil
  def resolve_group(subject_type, subject_id, opts \\ [])

  def resolve_group("group", group_id, _opts), do: group_id

  def resolve_group("relationship", rel_id, opts) do
    table = Keyword.fetch!(opts, :relationships_by_id)

    case RelationshipCache.get_relationship(rel_id, table) do
      nil -> nil
      entry -> Map.get(entry, :target_id) || Map.get(entry, "target_id")
    end
  end

  def resolve_group("groupMember", gm_id, opts) do
    table = Keyword.fetch!(opts, :group_members_by_id)

    case GroupCache.get_group_member(gm_id, table) do
      nil -> nil
      entry -> Map.get(entry, :group_id) || Map.get(entry, "group_id")
    end
  end

  def resolve_group(_user_type, source_id, opts) do
    table = Keyword.fetch!(opts, :relationships)
    RelationshipCache.get_entity_group(source_id, table)
  end
end
