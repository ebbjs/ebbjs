defmodule EbbServer.Storage.CacheTablesTest do
  @moduledoc """
  Tests the single resolution surface for cache module table names.

  GrantCache and RelationshipCache publish their ETS table names via
  `:persistent_term` at boot. `CacheTables` exposes those names as
  accessor functions so callers (Writer, EntityScope, etc.) read from
  one place rather than duplicating the `:persistent_term.get(..., default)`
  pattern.

  ## Key Behaviors Tested

  - Accessors return whatever a cache supervisor published
  - Accessors return the canonical default when nothing has been published
  - Per-test isolation via `:persistent_term.erase` works (no leak across tests)
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    CacheTables,
    MembershipCache,
    EntityModelCache,
    GroupAppsCache,
    GrantCache,
    RelationshipCache
  }

  # Erase the published keys before any test in this module runs so a
  # prior test's leftover `:persistent_term` (e.g., from
  # `entity_index_test.exs`, which starts RelationshipCache/GrantCache
  # in-process and only cleans up the ETS tables) doesn't make the
  # "no publication yet" assertions fail. The test was order-dependent
  # on `mix test` ExUnit scheduling — see #197 follow-up.
  setup_all do
    for {module, key} <- [
          {RelationshipCache, :relationships},
          {RelationshipCache, :relationships_by_id},
          {GrantCache, :grants},
          {GrantCache, :grants_by_id},
          {GrantCache, :grants_by_group},
          {MembershipCache, :memberships},
          {MembershipCache, :memberships_by_id},
          {MembershipCache, :memberships_by_group},
          {EntityModelCache, :entity_models},
          {GroupAppsCache, :group_apps}
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

  describe "grants/0" do
    test "returns the canonical default when GrantCache has not published" do
      assert CacheTables.grants() == :ebb_grants
    end

    test "returns whatever GrantCache published" do
      name = :"gm_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.GrantCache, :grants, name)

      assert CacheTables.grants() == name
    end
  end

  describe "grants_by_id/0" do
    test "returns the canonical default when GrantCache has not published" do
      assert CacheTables.grants_by_id() == :ebb_grants_by_id
    end

    test "returns whatever GrantCache published" do
      name = :"gm_by_id_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.GrantCache, :grants_by_id, name)

      assert CacheTables.grants_by_id() == name
    end
  end

  describe "grants_by_group/0" do
    test "returns the canonical default when GrantCache has not published" do
      assert CacheTables.grants_by_group() == :ebb_grants_by_group
    end

    test "returns whatever GrantCache published" do
      name = :"gm_by_group_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EbbServer.Storage.GrantCache, :grants_by_group, name)

      assert CacheTables.grants_by_group() == name
    end
  end

  describe "memberships/0" do
    test "returns the canonical default when MembershipCache has not published" do
      assert CacheTables.memberships() == :ebb_memberships
    end

    test "returns whatever MembershipCache published" do
      name = :"eg_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(MembershipCache, :memberships, name)

      assert CacheTables.memberships() == name
    end
  end

  describe "memberships_by_id/0" do
    test "returns the canonical default when MembershipCache has not published" do
      assert CacheTables.memberships_by_id() == :ebb_memberships_by_id
    end

    test "returns whatever MembershipCache published" do
      name = :"eg_by_id_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(MembershipCache, :memberships_by_id, name)

      assert CacheTables.memberships_by_id() == name
    end
  end

  describe "memberships_by_group/0" do
    test "returns the canonical default when MembershipCache has not published" do
      assert CacheTables.memberships_by_group() == :ebb_memberships_by_group
    end

    test "returns whatever MembershipCache published" do
      name = :"eg_by_group_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(MembershipCache, :memberships_by_group, name)

      assert CacheTables.memberships_by_group() == name
    end
  end

  describe "entity_models/0" do
    test "returns the canonical default when EntityModelCache has not published" do
      assert CacheTables.entity_models() == :ebb_entity_models
    end

    test "returns whatever EntityModelCache published" do
      name = :"et_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(EntityModelCache, :entity_models, name)

      assert CacheTables.entity_models() == name
    end
  end

  describe "group_apps/0" do
    test "returns the canonical default when GroupAppsCache has not published" do
      assert CacheTables.group_apps() == :ebb_group_apps
    end

    test "returns whatever GroupAppsCache published" do
      name = :"ga_published_#{System.unique_integer([:positive])}"
      publish_and_cleanup(GroupAppsCache, :group_apps, name)

      assert CacheTables.group_apps() == name
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
