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

    - `"relationship"` → `:ebb_relationships_by_id` (relationship id)
    - `"groupMember"`  → `:ebb_group_members_by_id` (member id)
    - `"group"`        → the group IS its own id
    - user types       → `:ebb_relationships` (source_id key)

  Tables are passed through the `AuthorizationContext` (or directly
  as options) so the resolution surface stays stateless and the
  underlying ETS tables can be reset independently per test.
  """

  alias EbbServer.Storage.RelationshipCache

  @typep subject_type :: String.t()
  @typep subject_id :: String.t()

  @doc """
  Returns the group an entity belongs to, or `nil` when no
  resolved group exists.

  Options mirror the keys on `AuthorizationContext`:

    - `:group_members`           — `:ebb_group_members`
    - `:group_members_by_id`     — `:ebb_group_members_by_id`
    - `:relationships`           — `:ebb_relationships`
    - `:relationships_by_group`  — `:ebb_relationships_by_group`
    - `:relationships_by_id`     — `:ebb_relationships_by_id`

  When an option is omitted the relevant default name is used.
  """
  @spec resolve_group(subject_type(), subject_id(), keyword()) :: String.t() | nil
  def resolve_group(subject_type, subject_id, opts \\ [])

  def resolve_group("group", group_id, _opts), do: group_id

  def resolve_group("relationship", rel_id, opts) do
    rel_id
    |> lookup(relationships_by_id_table(opts))
    |> case do
      nil -> nil
      entry -> Map.get(entry, :target_id) || Map.get(entry, "target_id")
    end
  end

  def resolve_group("groupMember", gm_id, opts) do
    gm_id
    |> lookup(group_members_by_id_table(opts))
    |> case do
      nil -> nil
      entry -> Map.get(entry, :group_id) || Map.get(entry, "group_id")
    end
  end

  def resolve_group(_user_type, source_id, opts) do
    RelationshipCache.get_entity_group(source_id, relationships_table(opts))
  end

  # Wraps a lookup so a missing or unreachable ETS table doesn't crash
  # the calling code — the resolver returns `nil` and the caller falls
  # back to whatever other resolution strategy it has (intra-action
  # context, writer fallback, etc.).
  defp lookup(_id, nil), do: nil

  defp lookup(id, table) do
    case :ets.lookup(table, id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  rescue
    ArgumentError -> nil
  end

  defp relationships_table(opts),
    do: Keyword.get(opts, :relationships, :ebb_relationships)

  defp relationships_by_id_table(opts) do
    case Keyword.get(opts, :relationships_by_id) do
      nil ->
        :persistent_term.get(
          {EbbServer.Storage.RelationshipCache, :relationships_by_id},
          :ebb_relationships_by_id
        )

      name ->
        name
    end
  end

  defp group_members_by_id_table(opts) do
    case Keyword.get(opts, :group_members_by_id) do
      nil ->
        :persistent_term.get(
          {EbbServer.Storage.GroupCache, :group_members_by_id},
          :ebb_group_members_by_id
        )

      name ->
        name
    end
  end
end
