defmodule EbbServer.Storage.SystemComponentTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.SystemComponent

  test "every kind declares its component, scope owner, and by-id cache" do
    assert [
             {:grant, {:field, "group_id", :group}, :group_members_by_id},
             {:membership, {:field, "group_id", :group}, :entity_groups_by_id},
             {:link, {:field, "source_id", :entity}, :relationships_by_id},
             {:group, :self, :group_apps}
           ] ==
             Enum.map(SystemComponent.kinds(), fn kind ->
               {kind, SystemComponent.scope(kind), SystemComponent.by_id(kind)}
             end)
  end

  test "a non-platform value declares no scope" do
    assert SystemComponent.scope("todo") == nil
    assert SystemComponent.scope(nil) == nil
    assert SystemComponent.by_id("todo") == nil
    assert SystemComponent.by_id(nil) == nil
  end

  test "component names round-trip through kind/1" do
    for kind <- SystemComponent.kinds() do
      assert SystemComponent.kind(SystemComponent.component(kind)) == kind
      assert SystemComponent.field(kind) == Atom.to_string(kind)
    end
  end

  # A fifth platform component is a registration in the declaration table.
  # Scope resolution reads the table, so it has no clause per kind.
  test "scope resolution is not dispatched on a platform kind" do
    source = File.read!("lib/ebb_server/storage/entity_index.ex")

    refute source =~ ~r/def resolve_groups_cached\(:(grant|membership|link|group)\b/
    refute source =~ ~r/def fan_out_preference\(%\{kind: :(grant|membership|link|group)\} /
    assert source =~ "SystemComponent.scope("
  end
end
