defmodule EbbServer.Storage.CacheTables do
  @moduledoc """
  Single resolution surface for cache module table names.

  GroupCache, EntityGroupCache, EntityTypeCache and RelationshipCache
  publish their ETS table names via `:persistent_term` at boot. Callers
  that need to hand a table name to a downstream module (Writer,
  EntityIndex, SystemCache, etc.) read it through this module rather
  than re-implementing the `:persistent_term.get(..., default)` pattern.

  Defaults are honored so unit tests can run without standing the
  supervisor up; production callers can rely on the supervisor having
  published by the time they read.
  """

  alias EbbServer.Storage.{EntityGroupCache, EntityTypeCache, GroupCache, RelationshipCache}

  @default_group_members :ebb_group_members
  @default_group_members_by_id :ebb_group_members_by_id
  @default_entity_groups :ebb_entity_groups
  @default_entity_groups_by_id :ebb_entity_groups_by_id
  @default_entity_groups_by_group :ebb_entity_groups_by_group
  @default_entity_types :ebb_entity_types
  @default_relationships :ebb_relationships
  @default_relationships_by_id :ebb_relationships_by_id

  @spec group_members() :: atom()
  def group_members,
    do: :persistent_term.get({GroupCache, :group_members}, @default_group_members)

  @spec group_members_by_id() :: atom()
  def group_members_by_id,
    do: :persistent_term.get({GroupCache, :group_members_by_id}, @default_group_members_by_id)

  @spec entity_groups() :: atom()
  def entity_groups,
    do: :persistent_term.get({EntityGroupCache, :entity_groups}, @default_entity_groups)

  @spec entity_groups_by_id() :: atom()
  def entity_groups_by_id,
    do:
      :persistent_term.get(
        {EntityGroupCache, :entity_groups_by_id},
        @default_entity_groups_by_id
      )

  @spec entity_groups_by_group() :: atom()
  def entity_groups_by_group,
    do:
      :persistent_term.get(
        {EntityGroupCache, :entity_groups_by_group},
        @default_entity_groups_by_group
      )

  @spec entity_types() :: atom()
  def entity_types,
    do: :persistent_term.get({EntityTypeCache, :entity_types}, @default_entity_types)

  @spec relationships() :: atom()
  def relationships,
    do: :persistent_term.get({RelationshipCache, :relationships}, @default_relationships)

  @spec relationships_by_id() :: atom()
  def relationships_by_id,
    do:
      :persistent_term.get(
        {RelationshipCache, :relationships_by_id},
        @default_relationships_by_id
      )
end
