defmodule EbbServer.Storage.AuthorizationContextTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.AuthorizationContext

  describe "build/1" do
    test "uses default values when no opts provided" do
      ctx = AuthorizationContext.build([])

      assert ctx.grants_table == :ebb_grants
      assert ctx.grants_by_id_table == :ebb_grants_by_id
      assert ctx.grants_by_group_table == :ebb_grants_by_group
      assert ctx.memberships_table == :ebb_memberships
      assert ctx.memberships_by_id_table == :ebb_memberships_by_id
      assert ctx.relationships_by_id_table == :ebb_relationships_by_id
      assert ctx.now_ms == nil
    end

    test "accepts custom table names via opts" do
      ctx =
        AuthorizationContext.build(
          grants: :custom_gm,
          grants_by_id: :custom_gm_by_id,
          grants_by_group: :custom_gm_by_group,
          memberships: :custom_eg,
          memberships_by_id: :custom_eg_by_id,
          relationships_by_id: :custom_rbi
        )

      assert ctx.grants_table == :custom_gm
      assert ctx.grants_by_id_table == :custom_gm_by_id
      assert ctx.grants_by_group_table == :custom_gm_by_group
      assert ctx.memberships_table == :custom_eg
      assert ctx.memberships_by_id_table == :custom_eg_by_id
      assert ctx.relationships_by_id_table == :custom_rbi
    end

    test "accepts now_ms for time-sensitive tests" do
      ctx = AuthorizationContext.build(now_ms: 1_700_000_000_000)

      assert ctx.now_ms == 1_700_000_000_000
    end

    test "accepts mixed options" do
      ctx = AuthorizationContext.build(grants: :test_gm, now_ms: 123)

      assert ctx.grants_table == :test_gm
      assert ctx.now_ms == 123
      assert ctx.memberships_table == :ebb_memberships
    end

    test "handles empty keyword list same as no args" do
      ctx1 = AuthorizationContext.build([])
      ctx2 = AuthorizationContext.build()

      assert ctx1 == ctx2
    end
  end

  describe "struct fields" do
    test "has expected fields" do
      ctx = AuthorizationContext.build()

      assert Map.has_key?(ctx, :grants_table)
      assert Map.has_key?(ctx, :grants_by_id_table)
      assert Map.has_key?(ctx, :grants_by_group_table)
      assert Map.has_key?(ctx, :memberships_table)
      assert Map.has_key?(ctx, :memberships_by_id_table)
      assert Map.has_key?(ctx, :relationships_by_id_table)
      assert Map.has_key?(ctx, :now_ms)
    end
  end
end
