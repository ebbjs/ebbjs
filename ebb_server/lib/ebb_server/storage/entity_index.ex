defmodule EbbServer.Storage.EntityIndex do
  @moduledoc """
  Single resolution surface for "which groups own this entity?".

  Every entity — user-defined rows, `Relationship` rows,
  `groupMember` rows — belongs to one or more Groups. Membership is a
  `Relationship` edge with `kind: "member"`; domain edges carry
  `kind: "link"`. The authorizer, the Writer's `cf_group_actions`
  index, the fan-out router, and the presence router all ask the same
  question through this module and expect the same answer.

  Resolution is dispatched by `subject_type`:

    - `"group"`        → the group is its own id
    - `"relationship"` → the membership set of the edge's source
    - `"groupMember"`  → the membership's `group_id`
    - user types       → the source's membership set

  A relationship resolves through its **source**, never its own
  `target_id`: an app may hold a domain link to a `group` entity, and
  that link must not grant membership.

  `source_groups/2` is the same resolution for a caller that already
  knows an entity id — for example a relationship being created in the
  current Action, which is not in the cache yet. Its group set is the
  cached membership unioned with membership edges carried by the
  Action (`:intra_action`).

  Each caller supplies its own table names; the module never falls
  back to globals, so a stale `:persistent_term` cannot reach a later
  caller's resolution path.
  """

  alias EbbServer.Storage.{GroupCache, RelationshipCache}

  @typep subject_type :: String.t()
  @typep subject_id :: String.t()

  @doc """
  Returns the group set an entity belongs to.

  Required options:

    - `:relationships`           — used for user-entity resolution
    - `:relationships_by_id`     — used for `"relationship"` resolution
    - `:group_members_by_id`     — used for `"groupMember"` resolution
    - `:intra_action`            — optional membership edges from the
      current Action, keyed by source id

  Missing required options raise `ArgumentError` rather than silently
  falling back to a global default.
  """
  @spec resolve_groups(subject_type(), subject_id(), keyword()) :: [String.t()]
  def resolve_groups(subject_type, subject_id, opts \\ [])

  def resolve_groups("group", group_id, _opts), do: [group_id]

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
  Returns the group set for a known entity id: cached `kind: "member"`
  targets unioned with the Action's membership edges.
  """
  @spec source_groups(subject_id(), keyword()) :: [String.t()]
  def source_groups(source_id, opts) do
    table = Keyword.fetch!(opts, :relationships)
    intra_action = Keyword.get(opts, :intra_action, %{})

    (RelationshipCache.membership_groups(source_id, table) ++
       Map.get(intra_action, source_id, []))
    |> Enum.uniq()
  end

  @doc """
  Returns the first group in the entity's set, or `nil` when the set is
  empty. Prefer `resolve_groups/3` when every group matters.
  """
  @spec resolve_group(subject_type(), subject_id(), keyword()) :: String.t() | nil
  def resolve_group(subject_type, subject_id, opts \\ []) do
    case resolve_groups(subject_type, subject_id, opts) do
      [group_id | _] -> group_id
      [] -> nil
    end
  end

  defp entry_source_id(entry), do: entry[:source_id] || entry["source_id"]
  defp entry_group_id(entry), do: entry[:group_id] || entry["group_id"]
end
