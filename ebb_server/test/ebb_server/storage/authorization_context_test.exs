defmodule EbbServer.Storage.AuthorizationContextTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.AuthorizationContext

  describe "build/1" do
    test "uses default values when no opts provided" do
      ctx = AuthorizationContext.build([])

      assert ctx.group_members_table == :ebb_group_members
      assert ctx.relationships_table == :ebb_relationships
      assert ctx.relationships_by_group_table == :ebb_relationships_by_group
      assert ctx.now_ms == nil
    end

    test "accepts custom table names via opts" do
      ctx =
        AuthorizationContext.build(
          group_members: :custom_gm,
          relationships: :custom_rel,
          relationships_by_group: :custom_rbg
        )

      assert ctx.group_members_table == :custom_gm
      assert ctx.relationships_table == :custom_rel
      assert ctx.relationships_by_group_table == :custom_rbg
    end

    test "accepts now_ms for time-sensitive tests" do
      ctx = AuthorizationContext.build(now_ms: 1_700_000_000_000)

      assert ctx.now_ms == 1_700_000_000_000
    end

    test "accepts mixed options" do
      ctx = AuthorizationContext.build(group_members: :test_gm, now_ms: 123)

      assert ctx.group_members_table == :test_gm
      assert ctx.now_ms == 123
      assert ctx.relationships_table == :ebb_relationships
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

      assert Map.has_key?(ctx, :group_members_table)
      assert Map.has_key?(ctx, :relationships_table)
      assert Map.has_key?(ctx, :relationships_by_group_table)
      assert Map.has_key?(ctx, :now_ms)
    end
  end
end
