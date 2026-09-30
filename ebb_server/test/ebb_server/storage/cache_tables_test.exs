defmodule EbbServer.Storage.CacheTablesTest do
  @moduledoc """
  Tests the single resolution surface for cache module table names.

  GroupCache and RelationshipCache publish their ETS table names via
  `:persistent_term` at boot. `CacheTables` exposes those names as
  accessor functions so callers (Writer, EntityIndex, etc.) read from
  one place rather than duplicating the `:persistent_term.get(..., default)`
  pattern.

  ## Key Behaviors Tested

  - Accessors return whatever a cache supervisor published
  - Accessors return the canonical default when nothing has been published
  - Per-test isolation via `:persistent_term.erase` works (no leak across tests)
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{CacheTables, GroupCache, RelationshipCache}

  # Erase the published keys before any test in this module runs so a
  # prior test's leftover `:persistent_term` (e.g., from
  # `entity_index_test.exs`, which starts RelationshipCache/GroupCache
  # in-process and only cleans up the ETS tables) doesn't make the
  # "no publication yet" assertions fail. The test was order-dependent
  # on `mix test` ExUnit scheduling — see #197 follow-up.
  setup_all do
    for {module, key} <- [
          {RelationshipCache, :relationships},
          {RelationshipCache, :relationships_by_group},
          {RelationshipCache, :relationships_by_id},
          {GroupCache, :group_members},
          {GroupCache, :group_members_by_id}
        ] do
      try do
        :persistent_term.erase({module, key})
      catch
        _, _ -> :ok
      end
    end

    :ok
  end

  # Each test publishes a unique table name, then erases on exit so
  # parallel or subsequent tests see the canonical default rather than
  # the value published by a previous test.
  defp publish_and_cleanup(module, key, value) do
    :persistent_term.put({module, key}, value)

    on_exit(fn ->
      try do
        :persistent_term.erase({module, key})
      catch
        _, _ -> :ok
      end
    end)

    value
  end

  describe "group_members/0" do
    test "returns the canonical default when GroupCache has not published" do
      assert CacheTables.group_members() == :ebb_group_members
    end

    test "returns whatever GroupCache published" do
      name = :"gm_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.GroupCache, :group_members, name)

      assert CacheTables.group_members() == name
    end
  end

  describe "group_members_by_id/0" do
    test "returns the canonical default when GroupCache has not published" do
      assert CacheTables.group_members_by_id() == :ebb_group_members_by_id
    end

    test "returns whatever GroupCache published" do
      name = :"gm_by_id_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.GroupCache, :group_members_by_id, name)

      assert CacheTables.group_members_by_id() == name
    end
  end

  describe "relationships/0" do
    test "returns the canonical default when RelationshipCache has not published" do
      assert CacheTables.relationships() == :ebb_relationships
    end

    test "returns whatever RelationshipCache published" do
      name = :"rel_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.RelationshipCache, :relationships, name)

      assert CacheTables.relationships() == name
    end
  end

  describe "relationships_by_group/0" do
    test "returns the canonical default when RelationshipCache has not published" do
      assert CacheTables.relationships_by_group() == :ebb_relationships_by_group
    end

    test "returns whatever RelationshipCache published" do
      name = :"rbg_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.RelationshipCache, :relationships_by_group, name)

      assert CacheTables.relationships_by_group() == name
    end
  end

  describe "relationships_by_id/0" do
    test "returns the canonical default when RelationshipCache has not published" do
      assert CacheTables.relationships_by_id() == :ebb_relationships_by_id
    end

    test "returns whatever RelationshipCache published" do
      name = :"rbi_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.RelationshipCache, :relationships_by_id, name)

      assert CacheTables.relationships_by_id() == name
    end
  end
end
