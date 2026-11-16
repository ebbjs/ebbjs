defmodule EbbServer.Storage.AuthorizationContext do
  @enforce_keys []
  defstruct grants_table: :ebb_grants,
            grants_by_id_table: :ebb_grants_by_id,
            grants_by_group_table: :ebb_grants_by_group,
            memberships_table: :ebb_memberships,
            memberships_by_id_table: :ebb_memberships_by_id,
            entity_models_table: :ebb_entity_models,
            relationships_by_id_table: :ebb_relationships_by_id,
            group_apps_table: :ebb_group_apps,
            now_ms: nil

  @type t :: %__MODULE__{
          grants_table: atom(),
          grants_by_id_table: atom(),
          grants_by_group_table: atom(),
          memberships_table: atom(),
          memberships_by_id_table: atom(),
          entity_models_table: atom(),
          relationships_by_id_table: atom(),
          group_apps_table: atom(),
          now_ms: non_neg_integer() | nil
        }

  @default_grants :ebb_grants
  @default_grants_by_id :ebb_grants_by_id
  @default_grants_by_group :ebb_grants_by_group
  @default_memberships :ebb_memberships
  @default_memberships_by_id :ebb_memberships_by_id
  @default_entity_models :ebb_entity_models
  @default_relationships_by_id :ebb_relationships_by_id
  @default_group_apps :ebb_group_apps

  @spec build(keyword()) :: t()
  def build(opts \\ []) do
    %__MODULE__{
      grants_table: resolve_table(opts, :grants, @default_grants),
      grants_by_id_table: resolve_table(opts, :grants_by_id, @default_grants_by_id),
      grants_by_group_table: resolve_table(opts, :grants_by_group, @default_grants_by_group),
      memberships_table: resolve_table(opts, :memberships, @default_memberships),
      memberships_by_id_table:
        resolve_table(opts, :memberships_by_id, @default_memberships_by_id),
      entity_models_table: resolve_table(opts, :entity_models, @default_entity_models),
      relationships_by_id_table:
        resolve_table(opts, :relationships_by_id, @default_relationships_by_id),
      group_apps_table: resolve_table(opts, :group_apps, @default_group_apps),
      now_ms: Keyword.get(opts, :now_ms)
    }
  end

  defp resolve_table(opts, key, default) do
    Keyword.get(opts, key) ||
      Application.get_env(:ebb_server, key) ||
      default
  end

  @spec to_opts(t()) :: keyword()
  def to_opts(%__MODULE__{} = ctx) do
    [
      memberships: ctx.memberships_table,
      memberships_by_id: ctx.memberships_by_id_table,
      entity_models: ctx.entity_models_table,
      relationships_by_id: ctx.relationships_by_id_table,
      grants_by_id: ctx.grants_by_id_table,
      grants_by_group: ctx.grants_by_group_table,
      group_apps: ctx.group_apps_table
    ]
  end
end
