defmodule EbbServer.Storage.AuthorizationContextTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.AuthorizationContext

  describe "build/1" do
    test "uses default values when no opts provided" do
      ctx = AuthorizationContext.build([])

      assert ctx.group_members_table == :ebb_group_members
      assert ctx.group_members_by_id_table == :ebb_group_members_by_id
      assert ctx.entity_groups_table == :ebb_entity_groups
      assert ctx.entity_groups_by_id_table == :ebb_entity_groups_by_id
      assert ctx.relationships_by_id_table == :ebb_relationships_by_id
      assert ctx.now_ms == nil
    end

    test "accepts custom table names via opts" do
      ctx =
        AuthorizationContext.build(
          group_members: :custom_gm,
          group_members_by_id: :custom_gm_by_id,
          entity_groups: :custom_eg,
          entity_groups_by_id: :custom_eg_by_id,
          relationships_by_id: :custom_rbi
        )

      assert ctx.group_members_table == :custom_gm
      assert ctx.group_members_by_id_table == :custom_gm_by_id
      assert ctx.entity_groups_table == :custom_eg
      assert ctx.entity_groups_by_id_table == :custom_eg_by_id
      assert ctx.relationships_by_id_table == :custom_rbi
    end

    test "accepts now_ms for time-sensitive tests" do
      ctx = AuthorizationContext.build(now_ms: 1_700_000_000_000)

      assert ctx.now_ms == 1_700_000_000_000
    end

    test "accepts mixed options" do
      ctx = AuthorizationContext.build(group_members: :test_gm, now_ms: 123)

      assert ctx.group_members_table == :test_gm
      assert ctx.now_ms == 123
      assert ctx.entity_groups_table == :ebb_entity_groups
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
      assert Map.has_key?(ctx, :group_members_by_id_table)
      assert Map.has_key?(ctx, :entity_groups_table)
      assert Map.has_key?(ctx, :entity_groups_by_id_table)
      assert Map.has_key?(ctx, :relationships_by_id_table)
      assert Map.has_key?(ctx, :now_ms)
    end
  end
end
