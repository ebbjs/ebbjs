defmodule EbbServer.Storage.AuthorizationContext do
  @moduledoc """
  Holds resolved configuration for authorization operations.

  Eliminates duplicated table name resolution and provides a clean
  context struct for passing around authorization configuration.
  """

  @enforce_keys []
  defstruct group_members_table: :ebb_group_members,
            group_members_by_id_table: :ebb_group_members_by_id,
            entity_groups_table: :ebb_entity_groups,
            entity_groups_by_id_table: :ebb_entity_groups_by_id,
            entity_types_table: :ebb_entity_types,
            relationships_by_id_table: :ebb_relationships_by_id,
            now_ms: nil

  @type t :: %__MODULE__{
          group_members_table: atom(),
          group_members_by_id_table: atom(),
          entity_groups_table: atom(),
          entity_groups_by_id_table: atom(),
          entity_types_table: atom(),
          relationships_by_id_table: atom(),
          now_ms: non_neg_integer() | nil
        }

  @default_group_members :ebb_group_members
  @default_group_members_by_id :ebb_group_members_by_id
  @default_entity_groups :ebb_entity_groups
  @default_entity_groups_by_id :ebb_entity_groups_by_id
  @default_entity_types :ebb_entity_types
  @default_relationships_by_id :ebb_relationships_by_id

  @doc """
  Builds an AuthorizationContext from keyword options.

  If values are not provided in opts, falls back to Application env,
  then to sensible defaults.
  """
  @spec build(keyword()) :: t()
  def build(opts \\ []) do
    %__MODULE__{
      group_members_table: resolve_table(opts, :group_members, @default_group_members),
      group_members_by_id_table:
        resolve_table(opts, :group_members_by_id, @default_group_members_by_id),
      entity_groups_table: resolve_table(opts, :entity_groups, @default_entity_groups),
      entity_groups_by_id_table:
        resolve_table(opts, :entity_groups_by_id, @default_entity_groups_by_id),
      entity_types_table: resolve_table(opts, :entity_types, @default_entity_types),
      relationships_by_id_table:
        resolve_table(opts, :relationships_by_id, @default_relationships_by_id),
      now_ms: Keyword.get(opts, :now_ms)
    }
  end

  defp resolve_table(opts, key, default) do
    Keyword.get(opts, key) ||
      Application.get_env(:ebb_server, key) ||
      default
  end

  @doc """
  Returns the cache-backed lookup options for this context.

  The single source for the entity/group resolution keyword list shared by
  `Authorizer`, `EntityIndex`, and `PermissionChecker`, so a new table
  cannot be added to one call site and forgotten at another.
  """
  @spec to_opts(t()) :: keyword()
  def to_opts(%__MODULE__{} = ctx) do
    [
      entity_groups: ctx.entity_groups_table,
      entity_groups_by_id: ctx.entity_groups_by_id_table,
      entity_types: ctx.entity_types_table,
      relationships_by_id: ctx.relationships_by_id_table,
      group_members_by_id: ctx.group_members_by_id_table
    ]
  end
end
