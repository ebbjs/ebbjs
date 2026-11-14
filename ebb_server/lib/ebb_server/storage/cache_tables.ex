defmodule EbbServer.Storage.CacheTables do
  @moduledoc """
  Single resolution surface for cache module table names.

  GrantCache, MembershipCache, EntityModelCache, RelationshipCache and
  GroupAppsCache publish their ETS table names via `:persistent_term` at
  boot. Callers that need to hand a table name to a downstream module
  (Writer, EntityScope, SystemCache, etc.) read it through this module
  rather than re-implementing the `:persistent_term.get(..., default)`
  pattern.

  Defaults are honored so unit tests can run without standing the
  supervisor up; production callers can rely on the supervisor having
  published by the time they read.
  """

  alias EbbServer.Storage.{
    EntityModelCache,
    GrantCache,
    GroupAppsCache,
    MembershipCache,
    RelationshipCache
  }

  @default_grants :ebb_grants
  @default_grants_by_id :ebb_grants_by_id
  @default_grants_by_group :ebb_grants_by_group
  @default_memberships :ebb_memberships
  @default_memberships_by_id :ebb_memberships_by_id
  @default_memberships_by_group :ebb_memberships_by_group
  @default_entity_models :ebb_entity_models
  @default_group_apps :ebb_group_apps
  @default_relationships :ebb_relationships
  @default_relationships_by_id :ebb_relationships_by_id

  @spec grants() :: atom()
  def grants,
    do: :persistent_term.get({GrantCache, :grants}, @default_grants)

  @spec grants_by_id() :: atom()
  def grants_by_id,
    do: :persistent_term.get({GrantCache, :grants_by_id}, @default_grants_by_id)

  @spec grants_by_group() :: atom()
  def grants_by_group,
    do: :persistent_term.get({GrantCache, :grants_by_group}, @default_grants_by_group)

  @spec memberships() :: atom()
  def memberships,
    do: :persistent_term.get({MembershipCache, :memberships}, @default_memberships)

  @spec memberships_by_id() :: atom()
  def memberships_by_id,
    do:
      :persistent_term.get(
        {MembershipCache, :memberships_by_id},
        @default_memberships_by_id
      )

  @spec memberships_by_group() :: atom()
  def memberships_by_group,
    do:
      :persistent_term.get(
        {MembershipCache, :memberships_by_group},
        @default_memberships_by_group
      )

  @spec entity_models() :: atom()
  def entity_models,
    do: :persistent_term.get({EntityModelCache, :entity_models}, @default_entity_models)

  @spec group_apps() :: atom()
  def group_apps,
    do: :persistent_term.get({GroupAppsCache, :group_apps}, @default_group_apps)

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
