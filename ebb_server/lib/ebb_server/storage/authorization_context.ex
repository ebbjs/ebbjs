defmodule EbbServer.Storage.AuthorizationContext do
  @moduledoc """
  Holds resolved configuration for authorization operations.

  Eliminates duplicated table name resolution and provides a clean
  context struct for passing around authorization configuration.
  """

  @enforce_keys []
  defstruct group_members_table: :ebb_group_members,
            relationships_table: :ebb_relationships,
            relationships_by_group_table: :ebb_relationships_by_group,
            now_ms: nil

  @type t :: %__MODULE__{
          group_members_table: atom(),
          relationships_table: atom(),
          relationships_by_group_table: atom(),
          now_ms: non_neg_integer() | nil
        }

  @default_group_members :ebb_group_members
  @default_relationships :ebb_relationships
  @default_relationships_by_group :ebb_relationships_by_group

  @doc """
  Builds an AuthorizationContext from keyword options.

  If values are not provided in opts, falls back to Application env,
  then to sensible defaults.
  """
  @spec build(keyword()) :: t()
  def build(opts \\ []) do
    %__MODULE__{
      group_members_table: resolve_table(opts, :group_members, @default_group_members),
      relationships_table: resolve_table(opts, :relationships, @default_relationships),
      relationships_by_group_table:
        resolve_table(opts, :relationships_by_group, @default_relationships_by_group),
      now_ms: Keyword.get(opts, :now_ms)
    }
  end

  defp resolve_table(opts, key, default) do
    Keyword.get(opts, key) ||
      Application.get_env(:ebb_server, key) ||
      default
  end
end
