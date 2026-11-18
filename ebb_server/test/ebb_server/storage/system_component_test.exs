defmodule EbbServer.Storage.SystemComponentTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.SystemComponent

  test "every kind declares its component, scope owner, by-id cache and overlay" do
    assert [
             {:grant, {:field, :group_id, :group}, :grants_by_id, false},
             {:membership, {:field, :group_id, :group}, :memberships_by_id, false},
             {:link, nil, nil, true},
             {:group, :self, :group_apps, false}
           ] ==
             Enum.map(SystemComponent.kinds(), fn kind ->
               {kind, SystemComponent.scope(kind), SystemComponent.by_id(kind),
                SystemComponent.overlay?(kind)}
             end)
  end

  test "a link declares no scope owner and no by-id cache" do
    assert SystemComponent.scope(:link) == nil
    assert SystemComponent.by_id(:link) == nil
  end

  test "a non-platform value declares no scope" do
    assert SystemComponent.scope("todo") == nil
    assert SystemComponent.scope(nil) == nil
    assert SystemComponent.by_id("todo") == nil
    assert SystemComponent.by_id(nil) == nil
    assert SystemComponent.overlay?("todo") == false
    assert SystemComponent.overlay?(nil) == false
  end

  test "only the overlay field is named under `ebb` on a user row" do
    assert SystemComponent.component_of_field("note", "link") == "ebb/link"
    assert SystemComponent.component_of_field("ebb", "link") == "ebb/link"
    assert SystemComponent.component_of_field("ebb", "group") == "ebb/group"
    assert SystemComponent.component_of_field("note", "group") == "note/group"
    assert SystemComponent.component_of_field("note", "title") == "note/title"
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
    source = File.read!(Path.expand("../../../lib/ebb_server/storage/entity_scope.ex", __DIR__))

    refute source =~ ~r/def resolve_groups_cached\(:(grant|membership|link|group)\b/
    refute source =~ ~r/def fan_out_preference\(%\{kind: :(grant|membership|link|group)\} /
    assert source =~ "SystemComponent.scope("
  end
end
